const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeRoomHelpers } = require("../utils/roomHelpers");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");
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
    hydrateTeacherRoomChat,
    createStudyRoomChat,
    getUniqueRoomKeyword,
    spendStudentCredit,
    renewRoomMembership,
    ensureRoomChatSubscriptions,
  } = makeRoomHelpers({ userCollection, databaseinmongo, studyRooms, activepackages, roomQuizzes });

  router.get("/api/study-rooms", async (req, res) => {
    try {
      const { category, type, userId, memberOnly } = req.query;
      const filter =
        userId && memberOnly === "true"
          ? { memberIds: userId }
          : userId
          ? { $or: [{ visibility: "public" }, { memberIds: userId }] }
          : { visibility: "public" };

      if (category) filter.category = category;
      if (type) filter.type = type;

      const rooms = await studyRooms
        .find(filter)
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(50)
        .toArray();
      const hydratedRooms = await Promise.all(rooms.map(hydrateStudyRoom));

      res.json({
        success: true,
        rooms: hydratedRooms,
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
      await Promise.all(
        (room.chats || []).map((chat) =>
          ensureRoomChatSubscriptions({
            chat: { ...chat, roomId: room._id.toString() },
            participantIds: chat.participantIds || room.memberIds || [],
            roomId: room._id.toString(),
          })
        )
      );
      res.json({ success: true, room: await hydrateStudyRoom(room) });
    } catch (err) {
      console.error("Error fetching study room:", err);
      res.status(500).json({ error: "Failed to fetch study room." });
    }
  });

  router.post("/api/study-rooms", async (req, res) => {
    try {
      const {
        userId,
        name,
        visibility = "public",
        category = "school",
        type = "bangla_medium",
      } = req.body;
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
      const { userId, name, visibility, category, type } = req.body;
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
      const { userId, title, note = "", dueDate = null } = req.body;
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
      const goal = {
        id: new ObjectId().toString(),
        title: cleanTitle.slice(0, 120),
        note: String(note || "").trim().slice(0, 400),
        dueDate: dueDate ? new Date(dueDate) : null,
        createdBy: userId,
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
      const { userId, completed } = req.body;
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
      const { userId } = req.body;
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

  router.post("/api/study-rooms/:roomId/join", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required." });

      const userDoc = await userCollection.findOne({ uid: userId, role: "student" });
      if (!userDoc)
        return res.status(403).json({ error: "Only students can join study rooms." });

      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });

      if ((room.memberIds || []).includes(userId)) {
        const membership = getRoomMembership(room, userId);
        if (membership.isActive)
          return res.json({ success: true, room: await hydrateStudyRoom(room), alreadyJoined: true });

        if (room.freeAccess === true || room.creditExpenseEnabled === false) {
          const now = new Date();
          await studyRooms.updateOne(
            { _id: room._id },
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
          const freeRenewedRoom = await studyRooms.findOne({ _id: room._id });
          return res.json({ success: true, room: await hydrateStudyRoom(freeRenewedRoom), renewed: true, freeAccess: true });
        }

        const renewalResult = await renewRoomMembership(room, userId);
        if (!renewalResult.ok)
          return res.status(renewalResult.status).json({ error: renewalResult.message });

        const renewedRoom = await studyRooms.findOne({ _id: room._id });
        return res.json({
          success: true,
          room: await hydrateStudyRoom(renewedRoom),
          renewed: true,
          remainingCredit: renewalResult.credit,
        });
      }

      if ((room.memberIds || []).length >= (room.maxStudents || STUDY_ROOM_MAX_STUDENTS))
        return res.status(409).json({ error: "This room is full." });

      const shouldSpendCredit = room.freeAccess !== true && room.creditExpenseEnabled !== false;
      let creditResult = { ok: true, credit: null };
      if (shouldSpendCredit) {
        creditResult = await spendStudentCredit(userId, STUDY_ROOM_JOIN_CREDIT);
        if (!creditResult.ok)
          return res.status(creditResult.status).json({ error: creditResult.message });
      }

      const now = new Date();
      const nextMemberIds = [...(room.memberIds || []), userId];
      const updatedChats = (room.chats || []).map((chat) =>
        chat.type === "students"
          ? { ...chat, participantIds: nextMemberIds }
          : { ...chat, participantIds: [...new Set([...(chat.participantIds || []), userId])] }
      );

      await studyRooms.updateOne(
        { _id: room._id },
        {
          $set: {
            memberIds: nextMemberIds,
            chats: updatedChats,
            [`memberStatuses.${userId}`]: {
              joinedAt: now,
              lastPaymentAt: shouldSpendCredit ? now : null,
              nextBillingAt: shouldSpendCredit ? new Date(now.getTime() + STUDY_ROOM_MONTH_MS) : null,
              isActive: true,
              freeAccess: !shouldSpendCredit,
            },
            updatedAt: Date.now(),
          },
        }
      );

      const chatDB = databaseinmongo.collection("chatDB");
      await Promise.all(
        updatedChats.map((chat) =>
          chat.chatId
            ? chatDB.updateOne(
                { _id: new ObjectId(chat.chatId) },
                { $set: { participantIds: chat.participantIds } }
              )
            : Promise.resolve()
        )
      );
      await Promise.all(
        updatedChats.map((chat) =>
          ensureRoomChatSubscriptions({
            chat: { ...chat, roomId: room._id.toString() },
            participantIds: chat.participantIds,
            roomId: room._id.toString(),
          })
        )
      );

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({
        success: true,
        room: await hydrateStudyRoom(updatedRoom),
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
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required." });

      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });

      if (room.freeAccess === true || room.creditExpenseEnabled === false) {
        const membership = getRoomMembership(room, userId);
        await studyRooms.updateOne(
          { _id: room._id },
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
        const freeRoom = await studyRooms.findOne({ _id: room._id });
        return res.json({ success: true, room: await hydrateStudyRoom(freeRoom), freeAccess: true });
      }

      const renewalResult = await renewRoomMembership(room, userId);
      if (!renewalResult.ok)
        return res.status(renewalResult.status).json({ error: renewalResult.message });

      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({
        success: true,
        room: await hydrateStudyRoom(updatedRoom),
        remainingCredit: renewalResult.credit,
      });
    } catch (err) {
      console.error("Error renewing study room:", err);
      res.status(500).json({ error: "Failed to renew study room membership." });
    }
  });

  router.post("/api/study-rooms/:roomId/teachers", async (req, res) => {
    try {
      const { userId, teacherId, subject } = req.body;
      if (!userId || !teacherId)
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
        expiresAt: new Date(Date.now() + STUDY_ROOM_TEACHER_SESSION_MS),
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
      const { teacherId } = req.params;
      const teacher = await userCollection.findOne({ uid: teacherId, role: "teacher" });
      if (!teacher)
        return res.status(403).json({ error: "Only teachers can view room chats." });

      const rooms = await studyRooms
        .find({ "teacherSessions.teacherId": teacherId })
        .sort({ updatedAt: -1, createdAt: -1 })
        .toArray();
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
      const { callerId, callerName, chatName } = req.body;
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });

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
            clickAction: "FLUTTER_NOTIFICATION_CLICK",
          },
        },
        apns: { payload: { aps: { sound: "default", contentAvailable: true } } },
        data: {
          type: "room_class_invitation",
          roomId: room._id.toString(),
          roomName: room.name || "",
          chatName: chatName || "",
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

      res.json({
        success: true,
        participants: sessions.map((item) => ({
          uid: item.studentId,
          displayName: item.participantName,
          photoURL: item.participantPhotoURL,
          joinedAt: item.startTime,
          leftAt: item.endTime || null,
          isActive: !item.endTime,
        })),
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

      await databaseinmongo.collection("callSession").updateOne(
        { sessionId, endTime: { $exists: false } },
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
