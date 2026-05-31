const { Router } = require("express");
const { makeStudentProgressHelpers } = require("../utils/studentProgressHelpers");

module.exports = ({ userCollection, databaseinmongo, studyRooms, roomQuizzes, publicQuizzes }) => {
  const router = Router();
  const { getStudentProgress } = makeStudentProgressHelpers({
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
    } catch (err) {
      console.error("Error fetching student progress:", err);
      res.status(500).json({ error: "Failed to fetch student progress." });
    }
  });

  return router;
};
