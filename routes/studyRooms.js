const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeRoomHelpers } = require("../utils/roomHelpers");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");
const { resolveActor, requireParty } = require("../utils/actor");
const {
  STUDY_ROOM_JOIN_CREDIT,
  STUDY_ROOM_CREATE_CREDIT,
  STUDY_ROOM_MAX_STUDENTS,
  STUDY_ROOM_MONTH_MS,
  STUDY_ROOM_TEACHER_CREDIT_RATE,
  STUDY_ROOM_TEACHER_SESSION_MS,
} = require("../utils/constants");

module.exports = ({
  userCollection,
  studyRooms,
  roomQuizzes,
  activepackages,
  databaseinmongo,
  admin,
}) => {
  const router = Router();
  const { createRoomNotification } = makeNotificationHelpers({
    databaseinmongo,
    userCollection,
    studyRooms,
  });

  const {
    getRoomMembership,
    hydrateStudyRoom,
    hydrateStudyRoomLite,
    STUDY_ROOM_LIST_PROJECTION,
    hydrateTeacherRoomChat,
    createStudyRoomChat,
    getUniqueRoomKeyword,
    spendStudentCredit,
    claimRoomSeat,
    releaseRoomSeat,
    renewRoomMembership,
    getRoomJoinCost,
    isFreeRoom,
    ensureRoomChatSubscriptions,
  } = makeRoomHelpers({ userCollection, databaseinmongo, studyRooms, activepackages, roomQuizzes });

  const isRoomTeacher = (room, userId) =>
    (room.teacherSessions || []).some((session) => session.teacherId === userId);

  /**
   * The room list.
   *
   * This used to run the full `hydrateStudyRoom` over every result, which fans
   * out four queries per room, and the Rooms page called the route twice in
   * parallel - once for public rooms, once with memberOnly=true - so a single
   * page load cost roughly 400 queries and shipped member and teacher user
   * documents the card never reads.
   *
   * Now: one projected query, no fan-out, and both slices in one response.
   * `?memberOnly=true` is still honoured for older app builds in the wild.
   */
  router.get("/api/study-rooms", async (req, res) => {
    try {
      const { category, type, memberOnly } = req.query;
      const legacyMemberOnly = memberOnly === "true";
      // "your rooms" is personal, so the uid comes from the token
      const userId = req.query.userId ? await resolveActor(req, res, req.query.userId) : null;
      if (req.query.userId && !userId) return;

      // A room the user has joined stays in their list whatever their current
      // study profile says, so the category/type filter only narrows the public
      // side. It used to narrow both, which quietly hid your own rooms when you
      // changed profile.
      const scope = {};
      if (category) scope.category = category;
      if (type) scope.type = type;

      // Joined rooms are their own query. Both slices used to share one
      // `.limit(50)` sorted by activity, so once 50 busier public rooms existed
      // a student's own rooms fell off the end and "Your rooms" emptied.
      const listQuery = (filter, limit) =>
        studyRooms
          .find(filter, { projection: STUDY_ROOM_LIST_PROJECTION })
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(limit)
          .toArray();
      const [joinedRooms, publicRooms] = await Promise.all([
        userId
          ? listQuery(legacyMemberOnly ? { memberIds: userId, ...scope } : { memberIds: userId }, 100)
          : [],
        legacyMemberOnly
          ? []
          : listQuery(
              userId
                ? { visibility: "public", memberIds: { $ne: userId }, ...scope }
                : { visibility: "public", ...scope },
              50
            ),
      ]);

      const joined = joinedRooms.map(hydrateStudyRoomLite);
      const available = publicRooms.map(hydrateStudyRoomLite);

      res.json({
        success: true,
        rooms: [...joined, ...available], // kept for older builds that read a flat list
        joined,
        available,
        costs: { join: STUDY_ROOM_JOIN_CREDIT, create: STUDY_ROOM_CREATE_CREDIT },
      });
    } catch (err) {
      console.error("Error fetching study rooms:", err);
      res.status(500).json({ error: "Failed to fetch study rooms." });
    }
  });

  router.get("/api/study-rooms/search/:keyword", async (req, res) => {
    try {
      const keyword = String(req.params.keyword || "").trim().toUpperCase();
      const room = await studyRooms.findOne({ keyword });
      if (!room) return res.status(404).json({ error: "Room not found." });
      res.json({ success: true, room: await hydrateStudyRoom(room) });
    } catch (err) {
      console.error("Error searching study room:", err);
      res.status(500).json({ error: "Failed to search study room." });
    }
  });

  router.get("/api/study-rooms/:roomId", async (req, res) => {
    try {
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      // This used to reconcile every chat subscription before responding - a GET
      // that wrote, fired the instant a user tapped Open, so anything that
      // prefetched the route mutated state. Every path that can change who
      // belongs to a chat already does it: create (POST /api/study-rooms),
      // join (POST /:roomId/join, which iterates ALL the room's chats so a
      // student joining a room that already has teachers is subscribed to
      // those too), and add-teacher (POST /:roomId/teachers).
      res.json({ success: true, room: await hydrateStudyRoom(room) });
    } catch (err) {
      console.error("Error fetching study room:", err);
      res.status(500).json({ error: "Failed to fetch study room." });
    }
  });

  router.post("/api/study-rooms", async (req, res) => {
    try {
      const {
        name,
        visibility = "public",
        category = "school",
        type = "bangla_medium",
      } = req.body;
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const cleanName = String(name || "").trim();
      const cleanVisibility = visibility === "private" ? "private" : "public";
      const cleanCategory = ["school", "college", "university"].includes(category)
        ? category
        : "school";
      const cleanType = ["english_medium", "bangla_medium"].includes(type)
        ? type
        : "bangla_medium";

      if (!userId || !cleanName)
        return res.status(400).json({ error: "userId and room name are required." });

      const userDoc = await userCollection.findOne({ uid: userId, role: "student" });
      if (!userDoc)
        return res.status(403).json({ error: "Only students can create study rooms." });

      const creditResult = await spendStudentCredit(userId, STUDY_ROOM_CREATE_CREDIT);
      if (!creditResult.ok)
        return res.status(creditResult.status).json({ error: creditResult.message });

      const keyword = await getUniqueRoomKeyword();
      const now = new Date();
      const studentChat = await createStudyRoomChat({
        name: `${cleanName} Students`,
        type: "students",
        participantIds: [userId],
      });

      const roomDoc = {
        name: cleanName,
        visibility: cleanVisibility,
        category: cleanCategory,
        type: cleanType,
        keyword,
        createdBy: userId,
        teacherControl: false,
        quizExpenseEnabled: true,
        memberIds: [userId],
        memberStatuses: {
          [userId]: {
            joinedAt: now,
            lastPaymentAt: now,
            nextBillingAt: new Date(now.getTime() + STUDY_ROOM_MONTH_MS),
            isActive: true,
          },
        },
        maxStudents: STUDY_ROOM_MAX_STUDENTS,
        studentChatId: studentChat.chatId,
        chats: [studentChat],
        teacherSessions: [],
        createdAt: now,
        updatedAt: Date.now(),
      };

      const result = await studyRooms.insertOne(roomDoc);
      await ensureRoomChatSubscriptions({
        chat: { ...studentChat, roomId: result.insertedId.toString() },
        participantIds: [userId],
        roomId: result.insertedId.toString(),
      });
      const room = await studyRooms.findOne({ _id: result.insertedId });
      res.status(201).json({
        success: true,
        room: await hydrateStudyRoom(room),
        remainingCredit: creditResult.credit,
      });
    } catch (err) {
      console.error("Error creating study room:", err);
      res.status(500).json({ error: "Failed to create study room." });
    }
  });

  router.patch("/api/study-rooms/:roomId", async (req, res) => {
    try {
      const { name, visibility, category, type } = req.body;
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      if (!userId || !(room.memberIds || []).includes(userId))
        return res.status(403).json({ error: "Only room members can edit this room." });

      const update = { updatedAt: Date.now() };
      if (typeof name === "string" && name.trim()) update.name = name.trim();
      if (visibility === "public" || visibility === "private") update.visibility = visibility;
      if (["school", "college", "university"].includes(category)) update.category = category;
      if (["english_medium", "bangla_medium"].includes(type)) update.type = type;

      await studyRooms.updateOne({ _id: room._id }, { $set: update });
      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error updating study room:", err);
      res.status(500).json({ error: "Failed to update study room." });
    }
  });

  router.post("/api/study-rooms/:roomId/progress/goals", async (req, res) => {
    try {
      const { title, note = "", dueDate = null } = req.body;
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const cleanTitle = String(title || "").trim();
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

      if (!room) return res.status(404).json({ error: "Room not found." });
      const isActiveStudent =
        userId &&
        (room.memberIds || []).includes(userId) &&
        getRoomMembership(room, userId).isActive;
      const isControlledTeacher =
        room.teacherControl === true &&
        (room.teacherSessions || []).some((session) => session.teacherId === userId);
      if (!isActiveStudent && !isControlledTeacher)
        return res.status(403).json({ error: "Only active students or controlled room teachers can add goals." });
      if (!cleanTitle) return res.status(400).json({ error: "Goal title is required." });

      const now = new Date();
      const parsedDueDate = dueDate ? new Date(dueDate) : null;
      const goal = {
        id: new ObjectId().toString(),
        title: cleanTitle.slice(0, 120),
        note: String(note || "").trim().slice(0, 400),
        dueDate: parsedDueDate && !Number.isNaN(parsedDueDate.getTime()) ? parsedDueDate : null,
        createdBy: userId,
        // teacher-set goals in teacher-controlled rooms count for XP without
        // peer confirmation; see ROOM_GOAL_XP_* in utils/constants.js
        createdByRole: isControlledTeacher && !isActiveStudent ? "teacher" : "student",
        createdAt: now,
        votes: { [userId]: false },
      };

      await studyRooms.updateOne(
        { _id: room._id },
        { $push: { "progress.goals": goal }, $set: { updatedAt: Date.now() } }
      );

      await createRoomNotification({
        room,
        type: "room_goal_created",
        title: "New task added",
        message: cleanTitle,
        actorId: userId,
        actorRole: isControlledTeacher ? "teacher" : "student",
        metadata: { goalId: goal.id },
      });

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.status(201).json({ success: true, room: await hydrateStudyRoom(updatedRoom), goal });
    } catch (err) {
      console.error("Error adding study room goal:", err);
      res.status(500).json({ error: "Failed to add room goal." });
    }
  });

  router.patch("/api/study-rooms/:roomId/progress/goals/:goalId/vote", async (req, res) => {
    try {
      const { completed } = req.body;
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const { goalId } = req.params;
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

      if (!room) return res.status(404).json({ error: "Room not found." });
      if (
        !userId ||
        !(room.memberIds || []).includes(userId) ||
        !getRoomMembership(room, userId).isActive
      )
        return res.status(403).json({ error: "Only active room students can update progress." });
      if (!(room.progress?.goals || []).some((g) => g.id === goalId))
        return res.status(404).json({ error: "Goal not found." });

      await studyRooms.updateOne(
        { _id: room._id, "progress.goals.id": goalId },
        {
          $set: {
            [`progress.goals.$.votes.${userId}`]: Boolean(completed),
            "progress.goals.$.updatedAt": new Date(),
            updatedAt: Date.now(),
          },
        }
      );

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error voting on study room goal:", err);
      res.status(500).json({ error: "Failed to update room progress." });
    }
  });

  router.delete("/api/study-rooms/:roomId/progress/goals/:goalId", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const { goalId } = req.params;
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

      if (!room) return res.status(404).json({ error: "Room not found." });
      const isActiveStudent =
        userId &&
        (room.memberIds || []).includes(userId) &&
        getRoomMembership(room, userId).isActive;
      const isControlledTeacher =
        room.teacherControl === true &&
        (room.teacherSessions || []).some((session) => session.teacherId === userId);
      if (!isActiveStudent && !isControlledTeacher)
        return res.status(403).json({ error: "Only active students or controlled room teachers can delete goals." });

      const goalExists = (room.progress?.goals || []).some((g) => g.id === goalId);
      if (!goalExists) return res.status(404).json({ error: "Goal not found." });

      await studyRooms.updateOne(
        { _id: room._id },
        { $pull: { "progress.goals": { id: goalId } }, $set: { updatedAt: Date.now() } }
      );

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error deleting study room goal:", err);
      res.status(500).json({ error: "Failed to delete room goal." });
    }
  });

  /**
   * Reactivates a lapsed member: free rooms just flip the status back on, paid
   * rooms go through renewRoomMembership (conditional claim, then a conditional
   * charge). Shared by /join (lapsed member) and /renew.
   */
  const reactivateMember = async (room, userId) => {
    const membership = getRoomMembership(room, userId);
    if (membership.isActive)
      return { ok: false, status: 409, alreadyActive: true, message: "Your room membership is already active." };

    if (isFreeRoom(room)) {
      await studyRooms.updateOne(
        { _id: room._id, memberIds: userId },
        {
          $set: {
            [`memberStatuses.${userId}`]: {
              joinedAt: membership.joinedAt,
              lastPaymentAt: null,
              nextBillingAt: null,
              isActive: true,
              freeAccess: true,
            },
            updatedAt: Date.now(),
          },
        }
      );
      return { ok: true, freeAccess: true, credit: null };
    }

    return renewRoomMembership(room, userId);
  };

  /** A refused renewal still sends the current room, so the app can refresh. */
  const sendRenewalRefusal = async (res, room, result) => {
    const freshRoom = await studyRooms.findOne({ _id: room._id });
    return res.status(result.status).json({
      error: result.message,
      alreadyActive: Boolean(result.alreadyActive),
      room: result.alreadyActive ? await hydrateStudyRoom(freshRoom) : undefined,
    });
  };

  router.post("/api/study-rooms/:roomId/join", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;

      const userDoc = await userCollection.findOne({ uid: userId, role: "student" });
      if (!userDoc)
        return res.status(403).json({ error: "Only students can join study rooms." });

      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });

      if ((room.memberIds || []).includes(userId)) {
        if (getRoomMembership(room, userId).isActive)
          return res.json({ success: true, room: await hydrateStudyRoom(room), alreadyJoined: true });

        const renewalResult = await reactivateMember(room, userId);
        if (!renewalResult.ok) return sendRenewalRefusal(res, room, renewalResult);

        const renewedRoom = await studyRooms.findOne({ _id: room._id });
        return res.json({
          success: true,
          room: await hydrateStudyRoom(renewedRoom),
          renewed: true,
          freeAccess: renewalResult.freeAccess === true || undefined,
          remainingCredit: renewalResult.credit,
        });
      }

      if ((room.memberIds || []).length >= (room.maxStudents || STUDY_ROOM_MAX_STUDENTS))
        return res.status(409).json({ error: "This room is full." });

      const joinCost = getRoomJoinCost(room);
      const shouldSpendCredit = joinCost > 0;
      const now = new Date();

      // Seat first, atomically (see claimRoomSeat); a lost race - double tap,
      // or the last seat going to someone else - is answered before any charge.
      const claimed = await claimRoomSeat(room, userId, {
        joinedAt: now,
        lastPaymentAt: shouldSpendCredit ? now : null,
        nextBillingAt: shouldSpendCredit ? new Date(now.getTime() + STUDY_ROOM_MONTH_MS) : null,
        isActive: true,
        freeAccess: !shouldSpendCredit,
      });
      if (!claimed) {
        const latestRoom = await studyRooms.findOne({ _id: room._id });
        if ((latestRoom?.memberIds || []).includes(userId))
          return res.json({ success: true, room: await hydrateStudyRoom(latestRoom), alreadyJoined: true });
        return res.status(409).json({ error: "This room is full." });
      }

      let creditResult = { ok: true, credit: null };
      if (shouldSpendCredit) {
        creditResult = await spendStudentCredit(userId, joinCost);
        if (!creditResult.ok) {
          await releaseRoomSeat(room, userId);
          return res.status(creditResult.status).json({ error: creditResult.message });
        }
      }

      // chat participant lists grow by one id each; never written back from the
      // stale copy read above
      const joinedRoom = await studyRooms.findOne({ _id: room._id });
      const roomChats = joinedRoom?.chats || [];
      const chatDB = databaseinmongo.collection("chatDB");
      await Promise.all(
        roomChats.map((chat) =>
          chat.chatId && ObjectId.isValid(chat.chatId)
            ? chatDB.updateOne(
                { _id: new ObjectId(chat.chatId) },
                { $addToSet: { participantIds: userId } }
              )
            : Promise.resolve()
        )
      );
      await Promise.all(
        roomChats.map((chat) =>
          ensureRoomChatSubscriptions({
            chat: { ...chat, roomId: room._id.toString() },
            participantIds: chat.participantIds || joinedRoom.memberIds || [],
            roomId: room._id.toString(),
          })
        )
      );

      res.json({
        success: true,
        room: await hydrateStudyRoom(joinedRoom),
        remainingCredit: creditResult.credit,
        freeAccess: !shouldSpendCredit,
      });
    } catch (err) {
      console.error("Error joining study room:", err);
      res.status(500).json({ error: "Failed to join study room." });
    }
  });

  router.post("/api/study-rooms/:roomId/renew", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;

      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      if (!(room.memberIds || []).includes(userId))
        return res.status(404).json({ error: "Join this room first." });

      const renewalResult = await reactivateMember(room, userId);
      if (!renewalResult.ok) return sendRenewalRefusal(res, room, renewalResult);

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({
        success: true,
        room: await hydrateStudyRoom(updatedRoom),
        freeAccess: renewalResult.freeAccess === true || undefined,
        remainingCredit: renewalResult.credit,
      });
    } catch (err) {
      console.error("Error renewing study room:", err);
      res.status(500).json({ error: "Failed to renew study room membership." });
    }
  });

  router.post("/api/study-rooms/:roomId/teachers", async (req, res) => {
    try {
      const { teacherId, subject } = req.body;
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      if (!teacherId)
        return res.status(400).json({ error: "userId and teacherId are required." });

      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      if (!(room.memberIds || []).includes(userId))
        return res.status(403).json({ error: "Join this room before adding a teacher." });
      if (!getRoomMembership(room, userId).isActive)
        return res
          .status(402)
          .json({ error: "Renew this room membership before adding a teacher." });

      const teacher = await userCollection.findOne({
        uid: teacherId,
        role: "teacher",
        approved: true,
        isActive: true,
      });
      if (!teacher) return res.status(404).json({ error: "Available teacher not found." });

      const teacherSubjects = Array.isArray(teacher.subjects) ? teacher.subjects : [];
      const selectedSubject = subject || teacherSubjects[0] || teacher.category || "General";

      // The admin route has had this guard since it was written; this one never
      // did, so two students in the same room could add the same teacher for the
      // same subject and produce two chats with byte-identical names.
      const alreadyAdded = (room.teacherSessions || []).some(
        (session) =>
          session.teacherId === teacherId &&
          String(session.subject || "General").toLowerCase() ===
            String(selectedSubject).toLowerCase()
      );
      if (alreadyAdded)
        return res
          .status(409)
          .json({ error: "This teacher is already in the room for that subject." });

      const teacherChat = await createStudyRoomChat({
        name: `${teacher.displayName || "Teacher"} - ${selectedSubject}`,
        type: "teacher",
        participantIds: [...new Set([...(room.memberIds || []), teacherId])],
        teacherId,
        subject: selectedSubject,
      });
      const teacherSession = {
        ...teacherChat,
        addedBy: userId,
        addedAt: new Date(),
        // STUDY_ROOM_TEACHER_SESSION_MS was never defined, which stored an
        // Invalid Date. Nothing reads this yet; null until a length is chosen.
        expiresAt: STUDY_ROOM_TEACHER_SESSION_MS ? new Date(Date.now() + STUDY_ROOM_TEACHER_SESSION_MS) : null,
      };

      await studyRooms.updateOne(
        { _id: room._id },
        {
          $push: { chats: teacherChat, teacherSessions: teacherSession },
          $set: { updatedAt: Date.now() },
        }
      );
      await ensureRoomChatSubscriptions({
        chat: { ...teacherChat, roomId: room._id.toString() },
        participantIds: teacherChat.participantIds,
        roomId: room._id.toString(),
      });

      await createRoomNotification({
        room: {
          ...room,
          teacherSessions: [...(room.teacherSessions || []), teacherSession],
        },
        type: "room_teacher_added",
        title: "Teacher added",
        message: `${teacher.displayName || "Teacher"} joined ${selectedSubject}.`,
        actorId: userId,
        actorRole: "student",
        metadata: { chatId: teacherChat.chatId, teacherId, subject: selectedSubject },
      });

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.status(201).json({
        success: true,
        room: await hydrateStudyRoom(updatedRoom),
        chat: teacherChat,
      });
    } catch (err) {
      console.error("Error adding teacher to study room:", err);
      res.status(500).json({ error: "Failed to add teacher." });
    }
  });

  router.get("/api/teacher-room-chats/:teacherId", async (req, res) => {
    try {
      const teacherId = await resolveActor(req, res, req.params.teacherId);
      if (!teacherId) return;
      const teacher = await userCollection.findOne({ uid: teacherId, role: "teacher" });
      if (!teacher)
        return res.status(403).json({ error: "Only teachers can view room chats." });

      const rooms = await studyRooms
        .find({ "teacherSessions.teacherId": teacherId })
        .sort({ updatedAt: -1, createdAt: -1 })
        .toArray();
      const allMemberIds = [
        ...new Set(rooms.flatMap((room) => room.memberIds || []).filter(Boolean)),
      ];
      const roomMembers = allMemberIds.length
        ? await userCollection
            .find({ uid: { $in: allMemberIds } })
            .project({ uid: 1, displayName: 1, photoURL: 1, role: 1 })
            .toArray()
        : [];
      const membersById = roomMembers.reduce((acc, member) => {
        acc[member.uid] = member;
        return acc;
      }, {});
      await Promise.all(
        rooms.flatMap((room) =>
          (room.chats || []).map((chat) =>
            ensureRoomChatSubscriptions({
              chat: { ...chat, roomId: room._id.toString() },
              participantIds: chat.participantIds || room.memberIds || [],
              roomId: room._id.toString(),
            })
          )
        )
      );

      const roomIds = rooms.map((room) => room._id.toString());
      const quizRequests = roomQuizzes
        ? await roomQuizzes
            .find({ roomId: { $in: roomIds }, teacherId, status: "requested" })
            .project({ roomId: 1, teacherId: 1, subject: 1 })
            .toArray()
        : [];
      const requestCountByRoomSubject = quizRequests.reduce((acc, request) => {
        const key = `${request.roomId}:${String(request.subject || "General").toLowerCase()}`;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      const chats = rooms.flatMap((room) =>
        (room.teacherSessions || [])
          .filter((session) => session.teacherId === teacherId)
          .map((session) => {
            const chat = hydrateTeacherRoomChat(room, session);
            const key = `${room._id.toString()}:${String(session.subject || "General").toLowerCase()}`;
            return {
              ...chat,
              members: (room.memberIds || []).map((memberId) => membersById[memberId]).filter(Boolean),
              participants: [
                ...(room.memberIds || []).map((memberId) => membersById[memberId]).filter(Boolean),
                { uid: teacher.uid, displayName: teacher.displayName, photoURL: teacher.photoURL, role: "teacher" },
              ],
              quizRequestCount: requestCountByRoomSubject[key] || 0,
            };
          })
      );
      chats.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

      res.json({ success: true, chats, roomCreditRate: STUDY_ROOM_TEACHER_CREDIT_RATE });
    } catch (err) {
      console.error("Error fetching teacher room chats:", err);
      res.status(500).json({ error: "Failed to fetch teacher room chats." });
    }
  });

  router.post("/api/study-rooms/:roomId/call-notification", async (req, res) => {
    try {
      const { callerName, chatName } = req.body;
      const callerId = await resolveActor(req, res, req.body?.callerId);
      if (!callerId) return;
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      // anyone signed in could push "class started" to every member of any room
      if (!(room.memberIds || []).includes(callerId) && !isRoomTeacher(room, callerId))
        return res.status(403).json({ error: "Only room members can start a room class." });

      const memberIds = (room.memberIds || []).filter((id) => id !== callerId);
      if (!memberIds.length) return res.json({ success: true, sent: 0 });

      const members = await userCollection
        .find({ uid: { $in: memberIds }, FCMToken: { $exists: true, $ne: null } })
        .project({ FCMToken: 1 })
        .toArray();
      const tokens = [...new Set(members.map((m) => m.FCMToken).filter(Boolean))];
      if (!tokens.length) return res.json({ success: true, sent: 0 });

      const payload = {
        tokens,
        notification: {
          title: "Room class started",
          body: `${callerName || "A student"} started ${chatName || room.name}.`,
        },
        android: {
          priority: "high",
          notification: {
            sound: "default",
            channelId: "high_importance_channel",
          },
        },
        apns: { payload: { aps: { sound: "default", contentAvailable: true } } },
        data: {
          type: "room_class_invitation",
          roomId: room._id.toString(),
          roomName: room.name || "",
          chatName: chatName || "",
          path: `/study-rooms/${room._id.toString()}`,
        },
      };

      const response = await admin.messaging().sendEachForMulticast(payload);
      res.json({ success: true, sent: response.successCount, failed: response.failureCount });
    } catch (err) {
      console.error("Error sending room call notification:", err);
      res.status(500).json({ error: "Failed to notify room members." });
    }
  });

  router.get("/api/room-calls/:roomCallId/participants", async (req, res) => {
    try {
      const { roomCallId } = req.params;
      const { teacherId, roomId } = req.query;

      const filter = { roomCallId };
      if (teacherId) filter.teacherId = teacherId;
      if (roomId) filter.roomId = roomId;

      const sessions = await databaseinmongo
        .collection("callSession")
        .find(filter)
        .project({
          studentId: 1,
          participantName: 1,
          participantPhotoURL: 1,
          startTime: 1,
          endTime: 1,
        })
        .toArray();
      const teacher = teacherId
        ? await userCollection.findOne(
            { uid: teacherId },
            { projection: { uid: 1, displayName: 1, photoURL: 1, role: 1 } }
          )
        : null;
      const teacherSession = sessions.find((item) => !item.studentId);
      const students = sessions
        .filter((item) => item.studentId)
        .map((item) => ({
          uid: item.studentId,
          displayName: item.participantName,
          photoURL: item.participantPhotoURL,
          role: "student",
          joinedAt: item.startTime,
          leftAt: item.endTime || null,
          isActive: !item.endTime,
        }));

      res.json({
        success: true,
        participants: [
          ...(teacherId
            ? [
                {
                  uid: teacher?.uid || teacherId,
                  displayName: teacher?.displayName || teacherSession?.participantName || "Teacher",
                  photoURL: teacher?.photoURL || teacherSession?.participantPhotoURL || null,
                  role: "teacher",
                  joinedAt: teacherSession?.startTime || null,
                  leftAt: teacherSession?.endTime || null,
                  isActive: !teacherSession?.endTime,
                },
              ]
            : []),
          ...students,
        ],
      });
    } catch (err) {
      console.error("Error fetching room call participants:", err);
      res.status(500).json({ error: "Failed to fetch participants." });
    }
  });

  router.post("/api/call-session/heartbeat", async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: "sessionId is required." });

      // Heartbeats decide how long a call is billed and paid if it is never
      // ended properly, so only the call's own student or teacher may send them.
      const callSession = databaseinmongo.collection("callSession");
      const session = await callSession.findOne({ sessionId: String(sessionId) }, { projection: { studentId: 1, teacherId: 1 } });
      if (!session) return res.json({ success: false });
      const caller = await requireParty(req, res, [session.studentId, session.teacherId], req.body.userId);
      if (!caller) return;

      await callSession.updateOne(
        { sessionId: String(sessionId), endTime: { $exists: false } },
        { $set: { lastHeartbeatAt: Date.now() } }
      );
      res.json({ success: true });
    } catch (err) {
      console.error("Error updating call heartbeat:", err);
      res.status(500).json({ error: "Failed to update heartbeat." });
    }
  });

  return router;
};
