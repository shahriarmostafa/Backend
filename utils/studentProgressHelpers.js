const buildMetric = ({ id, label, value, suffix = "", progress = 0 }) => ({
  id,
  label,
  value,
  suffix,
  progress: Math.min(100, Math.max(0, Math.round(progress))),
});

const safePercent = (value, total) => (total ? Math.round((value / total) * 100) : 0);

const makeStudentProgressHelpers = ({
  userCollection,
  databaseinmongo,
  studyRooms,
  roomQuizzes,
  publicQuizzes,
}) => {
  const callSession = databaseinmongo.collection("callSession");
  const chatCollection = databaseinmongo.collection("chatCollection");
  const chatDB = databaseinmongo.collection("chatDB");

  const getQuizStats = async (collection, studentId, extraMatch = {}) => {
    const result = await collection
      .aggregate([
        { $match: { ...extraMatch, "attempts.studentId": studentId } },
        { $unwind: "$attempts" },
        { $match: { "attempts.studentId": studentId } },
        {
          $group: {
            _id: null,
            joined: { $sum: 1 },
            submitted: {
              $sum: { $cond: [{ $ifNull: ["$attempts.submittedAt", false] }, 1, 0] },
            },
            totalScore: { $sum: { $ifNull: ["$attempts.score", 0] } },
            totalMaxScore: { $sum: { $ifNull: ["$attempts.maxScore", 0] } },
            totalRewards: { $sum: { $ifNull: ["$attempts.rewardCredit", 0] } },
            lastSubmittedAt: { $max: "$attempts.submittedAt" },
          },
        },
      ])
      .toArray();

    const stats = result[0] || {};
    return {
      joined: stats.joined || 0,
      submitted: stats.submitted || 0,
      totalScore: stats.totalScore || 0,
      totalMaxScore: stats.totalMaxScore || 0,
      averageScore: safePercent(stats.totalScore || 0, stats.totalMaxScore || 0),
      totalRewards: stats.totalRewards || 0,
      lastSubmittedAt: stats.lastSubmittedAt || null,
    };
  };

  const getQuizResults = async (collection, studentId, source, extraMatch = {}) => {
    const quizzes = await collection
      .find({ ...extraMatch, "attempts.studentId": studentId })
      .sort({ "attempts.submittedAt": -1, scheduledAt: -1, createdAt: -1 })
      .limit(80)
      .toArray();

    return quizzes
      .map((quiz) => {
        const attempt = (quiz.attempts || []).find((item) => item.studentId === studentId);
        if (!attempt?.submittedAt) return null;
        return {
          id: quiz._id.toString(),
          source,
          roomId: quiz.roomId || null,
          roomName: quiz.roomName || "",
          title: quiz.title || `${quiz.subject || "Quiz"} quiz`,
          subject: quiz.subject || "General",
          score: Number(attempt.score) || 0,
          maxScore: Number(attempt.maxScore) || 0,
          percent: safePercent(Number(attempt.score) || 0, Number(attempt.maxScore) || 0),
          rewardCredit: Number(attempt.rewardCredit) || 0,
          submittedAt: attempt.submittedAt,
          scheduledAt: quiz.scheduledAt || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.submittedAt || b.scheduledAt || 0) - new Date(a.submittedAt || a.scheduledAt || 0));
  };

  const getCallStats = async (studentId, roomOnly) => {
    const match = roomOnly
      ? { studentId, roomId: { $exists: true, $ne: null }, seconds: { $gt: 0 } }
      : {
          studentId,
          $or: [{ roomId: { $exists: false } }, { roomId: null }],
          seconds: { $gt: 0 },
        };

    const result = await callSession
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            classes: { $sum: 1 },
            totalSeconds: { $sum: "$seconds" },
            totalCredit: { $sum: { $ifNull: ["$creditDeducted", 0] } },
            lastClassAt: { $max: "$endedAt" },
          },
        },
      ])
      .toArray();

    const stats = result[0] || {};
    return {
      classes: stats.classes || 0,
      totalSeconds: stats.totalSeconds || 0,
      totalMinutes: Math.round((stats.totalSeconds || 0) / 60),
      totalCredit: stats.totalCredit || 0,
      lastClassAt: stats.lastClassAt || null,
    };
  };

  const getRoomStats = async (studentId) => {
    const rooms = await studyRooms.find({ memberIds: studentId }).toArray();
    const roomIds = rooms.map((room) => room._id.toString());
    const goals = rooms.flatMap((room) => room.progress?.goals || []);
    const completedGoals = goals.filter((goal) => goal.votes?.[studentId] === true).length;
    const roomQuizStats = await getQuizStats(roomQuizzes, studentId, { roomId: { $in: roomIds } });
    const roomCallStats = await getCallStats(studentId, true);

    return {
      joinedRooms: rooms.length,
      activeRooms: rooms.filter((room) => {
        const status = room.memberStatuses?.[studentId];
        return status?.isActive !== false && (!status?.nextBillingAt || new Date(status.nextBillingAt) > new Date());
      }).length,
      totalGoals: goals.length,
      completedGoals,
      goalCompletionRate: safePercent(completedGoals, goals.length),
      quizzes: roomQuizStats,
      classes: roomCallStats,
      rooms: rooms.map((room) => ({
        id: room._id.toString(),
        name: room.name,
        keyword: room.keyword,
        category: room.category,
        type: room.type,
        goalsDone: (room.progress?.goals || []).filter((goal) => goal.votes?.[studentId] === true).length,
        totalGoals: (room.progress?.goals || []).length,
      })),
    };
  };

  const getChatStats = async (studentId) => {
    const chatDoc = await chatCollection.findOne({ _id: studentId });
    const chats = chatDoc?.chats || [];
    const chatIds = chats.map((chat) => chat.chatId).filter(Boolean);
    if (!chatIds.length) {
      return {
        generalChats: 0,
        roomChats: 0,
        sentMessages: 0,
        generalMessages: 0,
        roomMessages: 0,
        lastMessageAt: null,
      };
    }

    const objectIds = chatIds.map((chatId) => {
      try {
        return new (require("mongodb").ObjectId)(chatId);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const roomChatIds = new Set(chats.filter((chat) => chat.roomChat).map((chat) => chat.chatId));

    const docs = objectIds.length
      ? await chatDB.find({ _id: { $in: objectIds } }).project({ messages: 1 }).toArray()
      : [];

    let sentMessages = 0;
    let generalMessages = 0;
    let roomMessages = 0;
    let lastMessageAt = null;
    docs.forEach((doc) => {
      const chatId = doc._id.toString();
      (doc.messages || []).forEach((message) => {
        if (message.senderId !== studentId) return;
        sentMessages += 1;
        if (roomChatIds.has(chatId)) roomMessages += 1;
        else generalMessages += 1;
        const createdAt = message.createdAt ? new Date(message.createdAt) : null;
        if (createdAt && !Number.isNaN(createdAt.getTime())) {
          if (!lastMessageAt || createdAt > lastMessageAt) lastMessageAt = createdAt;
        }
      });
    });

    return {
      generalChats: chats.filter((chat) => !chat.roomChat).length,
      roomChats: chats.filter((chat) => chat.roomChat).length,
      sentMessages,
      generalMessages,
      roomMessages,
      lastMessageAt,
    };
  };

  const getStudentProgress = async (studentId) => {
    const student = await userCollection.findOne({ uid: studentId, role: "student" });
    if (!student) return null;

    const [generalClasses, publicQuizzesStats, roomStats, chatStats, publicQuizResults] = await Promise.all([
      getCallStats(studentId, false),
      getQuizStats(publicQuizzes, studentId),
      getRoomStats(studentId),
      getChatStats(studentId),
      getQuizResults(publicQuizzes, studentId, "public"),
    ]);
    const roomIds = (roomStats.rooms || []).map((room) => room.id);
    const roomQuizResults = await getQuizResults(roomQuizzes, studentId, "room", {
      roomId: { $in: roomIds },
    });
    const quizResults = [...publicQuizResults, ...roomQuizResults].sort(
      (a, b) => new Date(b.submittedAt || b.scheduledAt || 0) - new Date(a.submittedAt || a.scheduledAt || 0)
    );

    const totalQuizSubmitted = publicQuizzesStats.submitted + roomStats.quizzes.submitted;
    const totalQuizScore = publicQuizzesStats.totalScore + roomStats.quizzes.totalScore;
    const totalQuizMaxScore = publicQuizzesStats.totalMaxScore + roomStats.quizzes.totalMaxScore;
    const totalClasses = generalClasses.classes + roomStats.classes.classes;
    const totalMinutes = generalClasses.totalMinutes + roomStats.classes.totalMinutes;

    const summary = {
      studentId,
      displayName: student.displayName,
      category: student.category || "school",
      type: student.type || "bangla_medium",
      totalClasses,
      totalMinutes,
      totalQuizSubmitted,
      quizAverage: safePercent(totalQuizScore, totalQuizMaxScore),
      joinedRooms: roomStats.joinedRooms,
      activeRooms: roomStats.activeRooms,
      completedRoomGoals: roomStats.completedGoals,
      sentMessages: chatStats.sentMessages,
      totalRewards: publicQuizzesStats.totalRewards + roomStats.quizzes.totalRewards,
    };

    return {
      summary,
      metrics: [
        buildMetric({
          id: "classes",
          label: "Classes",
          value: totalClasses,
          progress: Math.min(totalClasses * 5, 100),
        }),
        buildMetric({
          id: "minutes",
          label: "Learning minutes",
          value: totalMinutes,
          progress: Math.min(totalMinutes / 6, 100),
        }),
        buildMetric({
          id: "quizAverage",
          label: "Quiz average",
          value: summary.quizAverage,
          suffix: "%",
          progress: summary.quizAverage,
        }),
        buildMetric({
          id: "roomGoals",
          label: "Room goals",
          value: roomStats.goalCompletionRate,
          suffix: "%",
          progress: roomStats.goalCompletionRate,
        }),
      ],
      breakdowns: {
        generalClasses,
        publicQuizzes: publicQuizzesStats,
        rooms: roomStats,
        chats: chatStats,
        quizResults,
        latestQuizResult: quizResults[0] || null,
      },
    };
  };

  return { getStudentProgress };
};

module.exports = { makeStudentProgressHelpers };
