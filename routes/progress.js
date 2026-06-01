const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeStudentProgressHelpers } = require("../utils/studentProgressHelpers");

module.exports = ({ userCollection, databaseinmongo, studyRooms, roomQuizzes, publicQuizzes }) => {
  const router = Router();
  const { getStudentProgress, refreshStudentXpInBackground, getLeaderboard } = makeStudentProgressHelpers({
    userCollection,
    databaseinmongo,
    studyRooms,
    roomQuizzes,
    publicQuizzes,
  });

  router.get("/api/students/:studentId/progress", async (req, res) => {
    try {
      const progress = await getStudentProgress(req.params.studentId);
      if (!progress) return res.status(404).json({ error: "Student not found." });
      res.json({ success: true, progress });
      refreshStudentXpInBackground(req.params.studentId);
    } catch (err) {
      console.error("Error fetching student progress:", err);
      res.status(500).json({ error: "Failed to fetch student progress." });
    }
  });

  router.get("/api/leaderboard/public", async (req, res) => {
    try {
      const { userId, category, type, limit } = req.query;
      const leaderboard = await getLeaderboard({
        scope: "public",
        scopeId: "public",
        category,
        type,
        limit,
      });
      res.json({ success: true, leaderboard });
      refreshStudentXpInBackground(userId);
    } catch (err) {
      console.error("Error fetching public leaderboard:", err);
      res.status(500).json({ error: "Failed to fetch leaderboard." });
    }
  });

  router.get("/api/study-rooms/:roomId/leaderboard", async (req, res) => {
    try {
      const { userId, limit } = req.query;
      if (!ObjectId.isValid(req.params.roomId)) return res.status(400).json({ error: "Invalid room id." });
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      if (userId && !(room.memberIds || []).includes(userId) && !(room.teacherSessions || []).some((session) => session.teacherId === userId)) {
        return res.status(403).json({ error: "Join this room to view its leaderboard." });
      }
      const leaderboard = await getLeaderboard({
        scope: "room",
        scopeId: req.params.roomId,
        limit,
      });
      res.json({ success: true, leaderboard });
      if (userId && (room.memberIds || []).includes(userId)) refreshStudentXpInBackground(userId);
    } catch (err) {
      console.error("Error fetching room leaderboard:", err);
      res.status(500).json({ error: "Failed to fetch room leaderboard." });
    }
  });

  return router;
};
