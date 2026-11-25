const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeStudentProgressHelpers } = require("../utils/studentProgressHelpers");
const { resolveActor } = require("../utils/actor");

module.exports = ({ userCollection, databaseinmongo, studyRooms, roomQuizzes, publicQuizzes }) => {
  const router = Router();
  const { getStudentProgress, refreshStudentXpInBackground, getLeaderboard } = makeStudentProgressHelpers({
    userCollection,
    databaseinmongo,
    studyRooms,
    roomQuizzes,
    publicQuizzes,
  });

  // a student's own progress (owners may look at anyone's)
  router.get("/api/students/:studentId/progress", async (req, res) => {
    try {
      const studentId = await resolveActor(req, res, req.params.studentId);
      if (!studentId) return;
      const progress = await getStudentProgress(studentId);
      if (!progress) return res.status(404).json({ error: "Student not found." });
      res.json({ success: true, progress });
      refreshStudentXpInBackground(studentId);
    } catch (err) {
      console.error("Error fetching student progress:", err);
      res.status(500).json({ error: "Failed to fetch student progress." });
    }
  });

  router.get("/api/leaderboard/public", async (req, res) => {
    try {
      const { category, type, limit } = req.query;
      // only used to refresh the caller's own snapshot
      const userId = await resolveActor(req, res, req.query.userId);
      if (!userId) return;
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
      const { limit } = req.query;
      const userId = await resolveActor(req, res, req.query.userId);
      if (!userId) return;
      if (!ObjectId.isValid(req.params.roomId)) return res.status(400).json({ error: "Invalid room id." });
      const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
      if (!room) return res.status(404).json({ error: "Room not found." });
      // omitting ?userId used to skip this check entirely
      const isParticipant =
        (room.memberIds || []).includes(userId) ||
        (room.teacherSessions || []).some((session) => session.teacherId === userId);
      if (!isParticipant && !(await req.isOwner?.())) {
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
