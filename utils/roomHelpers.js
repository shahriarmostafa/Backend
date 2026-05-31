const { ObjectId } = require("mongodb");
const {
  STUDY_ROOM_MAX_STUDENTS,
  STUDY_ROOM_JOIN_CREDIT,
  STUDY_ROOM_MONTH_MS,
  STUDY_ROOM_TEACHER_CREDIT_RATE,
} = require("./constants");

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

  const hydrateStudyRoom = async (room) => {
    if (!room) return null;
    const roomId = room._id.toString();
    const callSession = databaseinmongo.collection("callSession");
    const [members, teachers] = await Promise.all([
      userCollection.find({ uid: { $in: room.memberIds || [] } }).toArray(),
      userCollection
        .find({ uid: { $in: (room.teacherSessions || []).map((s) => s.teacherId) } })
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

  const spendStudentCredit = async (studentId, amount) => {
    const { credit, isValid } = await getStudentCreditPackage(studentId);
    if (!isValid)
      return { ok: false, status: 403, message: "No active package found for this student." };
    if (credit < amount)
      return { ok: false, status: 402, message: `At least ${amount} credit is required.` };
    await activepackages.updateOne({ uid: studentId }, { $inc: { credit: -amount } });
    return { ok: true, credit: credit - amount };
  };

  const renewRoomMembership = async (room, userId) => {
    if (!(room.memberIds || []).includes(userId))
      return { ok: false, status: 404, message: "Student is not a member of this room." };

    const creditResult = await spendStudentCredit(userId, STUDY_ROOM_JOIN_CREDIT);
    if (!creditResult.ok) return creditResult;

    const now = new Date();
    const nextBillingAt = new Date(now.getTime() + STUDY_ROOM_MONTH_MS);
    const membership = {
      joinedAt: getRoomMembership(room, userId).joinedAt,
      lastPaymentAt: now,
      nextBillingAt,
      isActive: true,
    };

    await studyRooms.updateOne(
      { _id: room._id },
      {
        $set: {
          [`memberStatuses.${userId}`]: membership,
          updatedAt: Date.now(),
        },
      }
    );
    return { ok: true, membership, credit: creditResult.credit };
  };

  return {
    getRoomMembership,
    buildMemberStatuses,
    hydrateRoomProgress,
    hydrateStudyRoom,
    hydrateTeacherRoomChat,
    createStudyRoomChat,
    ensureRoomChatSubscriptions,
    makeRoomKeyword,
    getUniqueRoomKeyword,
    getStudentCreditPackage,
    spendStudentCredit,
    renewRoomMembership,
  };
};

module.exports = { makeRoomHelpers };
