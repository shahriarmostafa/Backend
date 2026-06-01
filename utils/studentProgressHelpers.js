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
  const leaderboardSnapshots = databaseinmongo.collection("leaderboardSnapshots");

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
    };
  };

  const getRoomCallStats = async (studentId, roomId) => {
    const result = await callSession
      .aggregate([
        { $match: { studentId, roomId, seconds: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            classes: { $sum: 1 },
            totalSeconds: { $sum: "$seconds" },
          },
        },
      ])
      .toArray();
    const stats = result[0] || {};
    return {
      classes: stats.classes || 0,
      learningMinutes: Math.round((stats.totalSeconds || 0) / 60),
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

  const getStudentProgress = async (studentId) => {
    const student = await userCollection.findOne({ uid: studentId, role: "student" });
    if (!student) return null;

    const [generalClasses, publicQuizzesStats, roomStats, publicQuizResults] = await Promise.all([
      getCallStats(studentId, false),
      getQuizStats(publicQuizzes, studentId),
      getRoomStats(studentId),
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
        quizResults,
        latestQuizResult: quizResults[0] || null,
      },
    };
  };

  const calculateXpFromProgress = (progress, roomId = null, roomCallStats = null) => {
    if (!progress) return null;
    const quizResults = progress.breakdowns?.quizResults || [];
    const scopedQuizResults = roomId
      ? quizResults.filter((quiz) => quiz.source === "room" && quiz.roomId === roomId)
      : quizResults;
    const quizSubmitted = scopedQuizResults.length;
    const quizAverage = safePercent(
      scopedQuizResults.reduce((sum, quiz) => sum + (Number(quiz.score) || 0), 0),
      scopedQuizResults.reduce((sum, quiz) => sum + (Number(quiz.maxScore) || 0), 0)
    );
    const roomInfo = roomId ? (progress.breakdowns?.rooms?.rooms || []).find((room) => room.id === roomId) : null;
    const learningMinutes = roomId ? Number(roomCallStats?.learningMinutes) || 0 : Number(progress.summary.totalMinutes) || 0;
    const completedGoals = roomId ? Number(roomInfo?.goalsDone) || 0 : Number(progress.summary.completedRoomGoals) || 0;
    const classes = roomId ? Number(roomCallStats?.classes) || 0 : Number(progress.summary.totalClasses) || 0;
    const rewards = roomId
      ? scopedQuizResults.reduce((sum, quiz) => sum + (Number(quiz.rewardCredit) || 0), 0)
      : Number(progress.summary.totalRewards) || 0;
    const xp =
      quizSubmitted * 60 +
      Math.round(quizAverage * 2) +
      Math.round(learningMinutes * 1.5) +
      completedGoals * 35 +
      classes * 45 +
      rewards;

    return {
      xp: Math.max(0, Math.round(xp)),
      quizAverage,
      quizSubmitted,
      learningMinutes,
      completedGoals,
      classes,
      rewards,
    };
  };

  const upsertLeaderboardSnapshot = async ({ scope, scopeId = "public", student, stats }) => {
    if (!student?.uid || !stats) return null;
    const now = new Date();
    const doc = {
      scope,
      scopeId,
      studentId: student.uid,
      displayName: student.displayName || student.name || "Student",
      photoURL: student.photoURL || "",
      category: student.category || "school",
      type: student.type || "bangla_medium",
      xp: stats.xp,
      quizAverage: stats.quizAverage,
      quizSubmitted: stats.quizSubmitted,
      learningMinutes: stats.learningMinutes,
      completedGoals: stats.completedGoals,
      classes: stats.classes,
      rewards: stats.rewards,
      updatedAt: now,
    };
    await leaderboardSnapshots.updateOne(
      { scope, scopeId, studentId: student.uid },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    return doc;
  };

  const refreshStudentXp = async (studentId) => {
    const progress = await getStudentProgress(studentId);
    if (!progress) return null;
    const student = await userCollection.findOne(
      { uid: studentId, role: "student" },
      { projection: { uid: 1, displayName: 1, name: 1, photoURL: 1, category: 1, type: 1 } }
    );
    if (!student) return null;

    const publicStats = calculateXpFromProgress(progress);
    const publicDoc = await upsertLeaderboardSnapshot({
      scope: "public",
      scopeId: "public",
      student,
      stats: publicStats,
    });
    await userCollection.updateOne(
      { uid: studentId },
      {
        $set: {
          progressXp: {
            xp: publicStats.xp,
            quizAverage: publicStats.quizAverage,
            learningMinutes: publicStats.learningMinutes,
            updatedAt: new Date(),
          },
        },
      }
    );

    const roomDocs = [];
    for (const room of progress.breakdowns?.rooms?.rooms || []) {
      const roomCallStats = await getRoomCallStats(studentId, room.id);
      const stats = calculateXpFromProgress(progress, room.id, roomCallStats);
      roomDocs.push(await upsertLeaderboardSnapshot({
        scope: "room",
        scopeId: room.id,
        student,
        stats,
      }));
    }

    return { public: publicDoc, rooms: roomDocs.filter(Boolean) };
  };

  const refreshStudentXpInBackground = (studentId) => {
    if (!studentId) return;
    setImmediate(() => {
      refreshStudentXp(studentId).catch((err) => {
        console.error("Background XP refresh failed:", err);
      });
    });
  };

  const getLeaderboard = async ({ scope = "public", scopeId = "public", limit = 50, category, type }) => {
    const filter = { scope, scopeId };
    if (scope === "public" && category) filter.category = category;
    if (scope === "public" && type) filter.type = type;
    const items = await leaderboardSnapshots
      .find(filter)
      .sort({ xp: -1, quizAverage: -1, learningMinutes: -1, updatedAt: 1 })
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
      .toArray();
    return items.map((item, index) => ({
      id: item._id.toString(),
      rank: index + 1,
      studentId: item.studentId,
      displayName: item.displayName,
      photoURL: item.photoURL,
      category: item.category,
      type: item.type,
      xp: item.xp || 0,
      quizAverage: item.quizAverage || 0,
      quizSubmitted: item.quizSubmitted || 0,
      learningMinutes: item.learningMinutes || 0,
      completedGoals: item.completedGoals || 0,
      classes: item.classes || 0,
      rewards: item.rewards || 0,
      updatedAt: item.updatedAt,
    }));
  };

  return { getStudentProgress, refreshStudentXp, refreshStudentXpInBackground, getLeaderboard };
};

module.exports = { makeStudentProgressHelpers };
