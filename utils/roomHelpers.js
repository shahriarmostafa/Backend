const { ObjectId } = require("mongodb");
const {
  STUDY_ROOM_MAX_STUDENTS,
  STUDY_ROOM_JOIN_CREDIT,
  STUDY_ROOM_MONTH_MS,
  STUDY_ROOM_TEACHER_CREDIT_RATE,
} = require("./constants");

/**
 * What a room payload may say about the people in it. Room pages, room chats
 * (sender names/avatars) and the quiz/goal panels read only these. The full
 * user documents used to go out - email, FCMToken, points, credit fields - to
 * anyone who could open the room, which includes non-members via room search.
 */
const ROOM_MEMBER_PROJECTION = { _id: 0, uid: 1, displayName: 1, photoURL: 1, role: 1 };
const ROOM_TEACHER_PROJECTION = {
  _id: 0,
  uid: 1,
  displayName: 1,
  photoURL: 1,
  role: 1,
  rating: 1,
  experience: 1,
  subjects: 1,
  category: 1,
  type: 1,
};

/** Rooms with free access, or with credit expense switched off, cost nothing. */
const isFreeRoom = (room) => room?.freeAccess === true || room?.creditExpenseEnabled === false;
const getRoomJoinCost = (room) => (isFreeRoom(room) ? 0 : STUDY_ROOM_JOIN_CREDIT);

const makeRoomHelpers = ({ userCollection, databaseinmongo, studyRooms, activepackages, roomQuizzes = null }) => {
  const getRoomMembership = (room, userId) => {
    const rawStatus = room?.memberStatuses?.[userId];
    const joinedAt = rawStatus?.joinedAt
      ? new Date(rawStatus.joinedAt)
      : new Date(room?.createdAt || Date.now());
    const nextBillingAt = rawStatus?.nextBillingAt
      ? new Date(rawStatus.nextBillingAt)
      : new Date(joinedAt.getTime() + STUDY_ROOM_MONTH_MS);
    const isFreeAccess = rawStatus?.freeAccess === true || room?.freeAccess === true || room?.creditExpenseEnabled === false;
    const isActive = rawStatus?.isActive !== false && (isFreeAccess || nextBillingAt.getTime() > Date.now());
    return {
      joinedAt,
      lastPaymentAt: rawStatus?.lastPaymentAt ? new Date(rawStatus.lastPaymentAt) : joinedAt,
      nextBillingAt,
      isActive,
    };
  };

  const buildMemberStatuses = (room) =>
    (room.memberIds || []).reduce((acc, memberId) => {
      acc[memberId] = getRoomMembership(room, memberId);
      return acc;
    }, {});

  const hydrateRoomProgress = (room) => {
    const memberCount = (room.memberIds || []).length;
    const goals = (room.progress?.goals || [])
      .map((goal) => {
        const votes = goal.votes || {};
        const yesCount = Object.values(votes).filter(Boolean).length;
        const noCount = Object.values(votes).filter((v) => v === false).length;
        const voteCount = Object.keys(votes).length;
        const completionPercent =
          memberCount > 0 ? Math.round((yesCount / memberCount) * 100) : 0;
        return {
          ...goal,
          yesCount,
          noCount,
          voteCount,
          memberCount,
          completionPercent,
          status: memberCount > 0 && yesCount >= memberCount ? "completed" : "active",
        };
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const activeGoals = goals.filter((g) => g.status !== "completed");
    const completedGoals = goals.filter((g) => g.status === "completed");
    const averageCompletion = goals.length
      ? Math.round(goals.reduce((sum, g) => sum + g.completionPercent, 0) / goals.length)
      : 0;

    return {
      goals,
      summary: {
        totalGoals: goals.length,
        activeGoals: activeGoals.length,
        completedGoals: completedGoals.length,
        averageCompletion,
      },
    };
  };

  /**
   * The room-list shape: exactly the ten fields a room card renders, and
   * nothing else.
   *
   * `hydrateStudyRoom` below fans out four queries per room - member user docs,
   * teacher user docs, a quiz aggregate and a call-session aggregate. The list
   * route ran it over 50 rooms, and the Rooms page called that route twice in
   * parallel, so opening the page cost ~400 queries to render eight strings per
   * card. Everything those queries produced (`members`, `progress.goals[]` with
   * their vote maps, `attendanceByStudent`, `teacherSessions[].teacher`) was
   * shipped and then dropped on the floor by the client.
   *
   * This one issues no queries at all: `buildMemberStatuses` is pure, and every
   * other field is already on the room document.
   */
  const hydrateStudyRoomLite = (room) => {
    if (!room) return null;
    return {
      id: room._id.toString(),
      name: room.name,
      keyword: room.keyword,
      category: room.category,
      type: room.type,
      visibility: room.visibility,
      memberIds: room.memberIds || [],
      memberCount: (room.memberIds || []).length,
      memberStatuses: buildMemberStatuses(room),
      maxStudents: room.maxStudents || STUDY_ROOM_MAX_STUDENTS,
      // so the join prompt can say "free" instead of the default price
      freeAccess: room.freeAccess === true,
      creditExpenseEnabled: room.creditExpenseEnabled !== false,
      joinCost: getRoomJoinCost(room),
    };
  };

  /** The projection hydrateStudyRoomLite needs - keep the two in step. */
  const STUDY_ROOM_LIST_PROJECTION = {
    name: 1,
    keyword: 1,
    category: 1,
    type: 1,
    visibility: 1,
    memberIds: 1,
    maxStudents: 1,
    memberStatuses: 1,
    // getRoomMembership reads these three too - drop any of them and isActive
    // silently computes differently from the full hydrator
    freeAccess: 1,
    creditExpenseEnabled: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  /**
   * `options.includeContact` adds member/teacher email for the owner's admin
   * screens. It is an object check on purpose: admin.js calls this through
   * `rooms.map(hydrateStudyRoom)`, which passes the array index here.
   */
  const hydrateStudyRoom = async (room, options = {}) => {
    if (!room) return null;
    const includeContact = Boolean(options && typeof options === "object" && options.includeContact);
    const roomId = room._id.toString();
    const callSession = databaseinmongo.collection("callSession");
    const [members, teachers] = await Promise.all([
      userCollection
        .find(
          { uid: { $in: room.memberIds || [] } },
          { projection: includeContact ? { ...ROOM_MEMBER_PROJECTION, email: 1 } : ROOM_MEMBER_PROJECTION }
        )
        .toArray(),
      userCollection
        .find(
          { uid: { $in: (room.teacherSessions || []).map((s) => s.teacherId) } },
          { projection: includeContact ? { ...ROOM_TEACHER_PROJECTION, email: 1 } : ROOM_TEACHER_PROJECTION }
        )
        .toArray(),
    ]);
    const quizSummary = roomQuizzes
      ? await roomQuizzes
          .aggregate([
            { $match: { roomId, status: "completed" } },
            { $unwind: "$attempts" },
            { $match: { "attempts.submittedAt": { $exists: true } } },
            {
              $group: {
                _id: null,
                quizzesTaken: { $sum: 1 },
                totalScore: { $sum: { $ifNull: ["$attempts.score", 0] } },
                totalMaxScore: { $sum: { $ifNull: ["$attempts.maxScore", 0] } },
              },
            },
          ])
          .toArray()
      : [];
    const attendanceSummary = await callSession
      .aggregate([
        {
          $match: {
            roomId,
            roomCallFinalized: true,
            studentId: { $in: room.memberIds || [] },
            seconds: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: { roomCallId: "$roomCallId", studentId: "$studentId" },
            seconds: { $max: { $ifNull: ["$seconds", 0] } },
            attendedAt: { $max: "$endedAt" },
          },
        },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  classAttendances: { $sum: 1 },
                  totalStudentSeconds: { $sum: "$seconds" },
                  groupClassIds: { $addToSet: "$_id.roomCallId" },
                  studentsAttended: { $addToSet: "$_id.studentId" },
                  lastClassAt: { $max: "$attendedAt" },
                },
              },
              {
                $project: {
                  _id: 0,
                  classAttendances: 1,
                  totalStudentSeconds: 1,
                  studentsAttended: { $size: "$studentsAttended" },
                  groupClassesHeld: { $size: "$groupClassIds" },
                  lastClassAt: 1,
                },
              },
            ],
            students: [
              {
                $group: {
                  _id: "$_id.studentId",
                  classesAttended: { $sum: 1 },
                  totalSeconds: { $sum: "$seconds" },
                  lastClassAt: { $max: "$attendedAt" },
                },
              },
            ],
          },
        },
      ])
      .toArray();
    const progress = hydrateRoomProgress(room);
    const attendance = attendanceSummary[0]?.summary?.[0] || {};
    const groupClassesHeld = attendance.groupClassesHeld || 0;
    const classAttendances = attendance.classAttendances || 0;
    const possibleAttendances = groupClassesHeld * ((room.memberIds || []).length || 0);
    const attendanceByStudent = (attendanceSummary[0]?.students || []).reduce((acc, item) => {
      acc[item._id] = {
        classesAttended: item.classesAttended || 0,
        totalSeconds: item.totalSeconds || 0,
        totalMinutes: Math.round((item.totalSeconds || 0) / 60),
        lastClassAt: item.lastClassAt || null,
        attendancePercent: groupClassesHeld
          ? Math.round(((item.classesAttended || 0) / groupClassesHeld) * 100)
          : 0,
      };
      return acc;
    }, {});
    progress.summary.quizzesTaken = quizSummary[0]?.quizzesTaken || 0;
    progress.summary.quizAverage = quizSummary[0]?.totalMaxScore
      ? Math.round((quizSummary[0].totalScore / quizSummary[0].totalMaxScore) * 100)
      : 0;
    progress.summary.groupClassesHeld = groupClassesHeld;
    progress.summary.classAttendances = classAttendances;
    progress.summary.classAttendanceRate = possibleAttendances
      ? Math.round((classAttendances / possibleAttendances) * 100)
      : 0;
    progress.summary.averageClassMinutes = classAttendances
      ? Math.round(((attendance.totalStudentSeconds || 0) / classAttendances) / 60)
      : 0;
    progress.summary.studentsAttendedClasses = attendance.studentsAttended || 0;
    progress.summary.lastClassAt = attendance.lastClassAt || null;
    progress.attendanceByStudent = attendanceByStudent;
    progress.metrics = [
      {
        id: "goals",
        label: "Room progress",
        value: progress.summary.averageCompletion,
        suffix: "%",
        progress: progress.summary.averageCompletion,
      },
      {
        id: "quizzes",
        label: "Quizzes taken",
        value: progress.summary.quizzesTaken,
        progress: Math.min((progress.summary.quizzesTaken || 0) * 10, 100),
      },
      {
        id: "attendance",
        label: "Class attendance",
        value: progress.summary.classAttendanceRate,
        suffix: "%",
        progress: progress.summary.classAttendanceRate,
      },
    ];
    const teachersById = teachers.reduce((acc, t) => {
      acc[t.uid] = t;
      return acc;
    }, {});
    return {
      ...room,
      id: room._id.toString(),
      memberCount: (room.memberIds || []).length,
      memberStatuses: buildMemberStatuses(room),
      maxStudents: room.maxStudents || STUDY_ROOM_MAX_STUDENTS,
      teacherControl: room.teacherControl === true,
      quizExpenseEnabled: room.quizExpenseEnabled !== false,
      joinCost: getRoomJoinCost(room),
      members,
      progress,
      teacherSessions: (room.teacherSessions || []).map((session) => ({
        ...session,
        teacher: teachersById[session.teacherId] || null,
      })),
    };
  };

  const hydrateTeacherRoomChat = (room, session) => {
    const chatName =
      session.name ||
      `${room.name || "Study Room"} - ${session.subject || "Teacher Chat"}`;
    return {
      ...session,
      name: chatName,
      roomId: room._id.toString(),
      roomName: room.name,
      roomKeyword: room.keyword,
      teacherControl: room.teacherControl === true,
      quizExpenseEnabled: room.quizExpenseEnabled !== false,
      memberIds: room.memberIds || [],
      memberCount: (room.memberIds || []).length,
      maxStudents: room.maxStudents || STUDY_ROOM_MAX_STUDENTS,
      roomCreditRate: STUDY_ROOM_TEACHER_CREDIT_RATE,
    };
  };

  const createStudyRoomChat = async ({
    name,
    type,
    participantIds,
    teacherId = null,
    subject = null,
    roomId = null,
  }) => {
    const chatDB = databaseinmongo.collection("chatDB");
    const newChat = await chatDB.insertOne({
      createdAt: new Date(),
      messages: [],
      roomChat: true,
      roomId,
      name,
      type,
      participantIds,
      teacherId,
      subject,
    });
    return {
      chatId: newChat.insertedId.toString(),
      name,
      type,
      participantIds,
      teacherId,
      subject,
      roomId,
      createdAt: new Date(),
    };
  };

  const ensureRoomChatSubscriptions = async ({ chat, participantIds, roomId }) => {
    if (!chat?.chatId || !Array.isArray(participantIds)) return;
    const chatCollection = databaseinmongo.collection("chatCollection");
    const uniqueParticipantIds = [...new Set(participantIds.filter(Boolean))];
    await Promise.all(
      uniqueParticipantIds.map(async (participantId) => {
        const receiverId =
          chat.type === "teacher" && participantId !== chat.teacherId
            ? chat.teacherId
            : roomId || chat.roomId || chat.chatId;
        const receiverRole =
          chat.type === "teacher"
            ? participantId === chat.teacherId
              ? "room-teacher"
              : "teacher"
            : "room";

        await chatCollection.updateOne(
          { _id: participantId },
          { $setOnInsert: { chats: [] } },
          { upsert: true }
        );

        return chatCollection.updateOne(
          { _id: participantId, "chats.chatId": { $ne: chat.chatId } },
          {
            $push: {
              chats: {
                receiverRole,
                yourRole: receiverRole,
                chatId: chat.chatId,
                lastMessage: "",
                receiverId,
                roomChat: true,
                roomId: roomId || chat.roomId || null,
                chatName: chat.name,
                chatType: chat.type,
                teacherId: chat.teacherId || null,
                subject: chat.subject || null,
                participantIds: uniqueParticipantIds,
                isSeen: true,
                unreadCount: 0,
                updatedAt: Date.now(),
              },
            },
          }
        );
      })
    );
  };

  const makeRoomKeyword = () => {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let keyword = "";
    for (let i = 0; i < 7; i++) {
      keyword += letters[Math.floor(Math.random() * letters.length)];
    }
    return keyword;
  };

  const getUniqueRoomKeyword = async () => {
    for (let i = 0; i < 10; i++) {
      const keyword = makeRoomKeyword();
      const existing = await studyRooms.findOne({ keyword });
      if (!existing) return keyword;
    }
    return `${makeRoomKeyword()}${Date.now().toString(36).slice(-1)}`.slice(0, 7);
  };

  const getStudentCreditPackage = async (studentId) => {
    const activePackage = await activepackages.findOne({ uid: studentId });
    if (!activePackage) return { activePackage: null, credit: 0, isValid: false };
    const isValid =
      activePackage.isActive === true && new Date(activePackage.expiryDate) > new Date();
    return { activePackage, credit: Number(activePackage.credit) || 0, isValid };
  };

  /**
   * Conditional decrement, like spendCourseCredit: the balance check and the
   * spend are one operation, so two requests racing on the same balance cannot
   * both pass a stale `credit >= cost` read.
   */
  const spendStudentCredit = async (studentId, amount) => {
    const creditToSpend = Math.max(0, Number(amount) || 0);
    if (creditToSpend === 0) return { ok: true, credit: null };

    const { isValid } = await getStudentCreditPackage(studentId);
    if (!isValid)
      return { ok: false, status: 403, message: "No active package found for this student." };
    const result = await activepackages.findOneAndUpdate(
      { uid: studentId, credit: { $gte: creditToSpend } },
      { $inc: { credit: -creditToSpend } },
      { returnDocument: "after" }
    );
    const doc = result && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
    if (!doc)
      return { ok: false, status: 402, message: `At least ${creditToSpend} credit is required.` };
    return { ok: true, credit: Number(doc.credit) || 0 };
  };

  /**
   * Adds a student to the room in ONE conditional update: only if they are not
   * already a member and a seat is free (`memberIds.<limit-1>` must not exist).
   * The route used to `$set` memberIds and chats from the copy it read, so two
   * joins at once each wrote their own array and one student vanished - after
   * being charged - and a teacher chat added meanwhile could be dropped too.
   *
   * Returns true when this call added the student.
   */
  const claimRoomSeat = async (room, userId, membership) => {
    const seatLimit = Math.max(1, Number(room.maxStudents) || STUDY_ROOM_MAX_STUDENTS);
    const update = {
      $addToSet: { memberIds: userId },
      $set: { [`memberStatuses.${userId}`]: membership, updatedAt: Date.now() },
    };
    // every room chat (students + teacher chats) includes every member
    if (Array.isArray(room.chats) && room.chats.length) {
      update.$addToSet["chats.$[].participantIds"] = userId;
    }
    const result = await studyRooms.updateOne(
      {
        _id: room._id,
        memberIds: { $ne: userId },
        [`memberIds.${seatLimit - 1}`]: { $exists: false },
      },
      update
    );
    return Boolean(result?.modifiedCount);
  };

  /** Undoes claimRoomSeat when the join charge fails. */
  const releaseRoomSeat = async (room, userId) => {
    const update = {
      $pull: { memberIds: userId },
      $unset: { [`memberStatuses.${userId}`]: "" },
      $set: { updatedAt: Date.now() },
    };
    if (Array.isArray(room.chats) && room.chats.length) {
      update.$pull["chats.$[].participantIds"] = userId;
    }
    await studyRooms.updateOne({ _id: room._id }, update);
  };

  /**
   * Paid renewal. Refused while the membership is still active - the UI only
   * offers Renew once it lapses, so an active one means a double tap or a
   * replay, and each used to charge another month from *now*, wasting the
   * remaining days.
   *
   * The membership is claimed first with a conditional write keyed on the
   * nextBillingAt that was read, so of two concurrent renewals only one gets
   * past this point and only that one is charged. If the charge then fails the
   * claim is put back.
   */
  const renewRoomMembership = async (room, userId) => {
    if (!(room.memberIds || []).includes(userId))
      return { ok: false, status: 404, message: "Student is not a member of this room." };

    const current = getRoomMembership(room, userId);
    if (current.isActive)
      return {
        ok: false,
        status: 409,
        alreadyActive: true,
        message: "Your room membership is already active.",
      };

    const rawStatus = room.memberStatuses?.[userId];
    const now = new Date();
    const nextBillingAt = new Date(now.getTime() + STUDY_ROOM_MONTH_MS);
    const membership = {
      joinedAt: current.joinedAt,
      lastPaymentAt: now,
      nextBillingAt,
      isActive: true,
    };

    const claim = await studyRooms.updateOne(
      {
        _id: room._id,
        memberIds: userId,
        [`memberStatuses.${userId}.nextBillingAt`]: rawStatus?.nextBillingAt ?? null,
      },
      {
        $set: {
          [`memberStatuses.${userId}`]: membership,
          updatedAt: Date.now(),
        },
      }
    );
    if (!claim?.modifiedCount)
      return {
        ok: false,
        status: 409,
        alreadyActive: true,
        message: "This membership was just renewed.",
      };

    const creditResult = await spendStudentCredit(userId, STUDY_ROOM_JOIN_CREDIT);
    if (!creditResult.ok) {
      await studyRooms.updateOne(
        { _id: room._id, [`memberStatuses.${userId}.nextBillingAt`]: nextBillingAt },
        rawStatus
          ? { $set: { [`memberStatuses.${userId}`]: rawStatus } }
          : { $unset: { [`memberStatuses.${userId}`]: "" } }
      );
      return creditResult;
    }
    return { ok: true, membership, credit: creditResult.credit };
  };

  return {
    getRoomMembership,
    buildMemberStatuses,
    hydrateRoomProgress,
    hydrateStudyRoom,
    hydrateStudyRoomLite,
    STUDY_ROOM_LIST_PROJECTION,
    hydrateTeacherRoomChat,
    createStudyRoomChat,
    ensureRoomChatSubscriptions,
    makeRoomKeyword,
    getUniqueRoomKeyword,
    getStudentCreditPackage,
    spendStudentCredit,
    claimRoomSeat,
    releaseRoomSeat,
    renewRoomMembership,
    getRoomJoinCost,
    isFreeRoom,
  };
};

module.exports = {
  makeRoomHelpers,
  getRoomJoinCost,
  isFreeRoom,
  ROOM_MEMBER_PROJECTION,
  ROOM_TEACHER_PROJECTION,
};
