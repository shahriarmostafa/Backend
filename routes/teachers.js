const { Router } = require("express");

// The tutor list card reads uid, displayName, photoURL, rating, experience,
// category, type and subjects. `{ id, ...doc }` shipped whole user documents -
// email, points, totalPoints, approval flags, everything - to every student
// browsing tutors.
const TEACHER_LIST_PROJECTION = {
  uid: 1,
  displayName: 1,
  photoURL: 1,
  rating: 1,
  experience: 1,
  category: 1,
  type: 1,
  subjects: 1,
  isActive: 1,
  role: 1,
};

module.exports = ({ userCollection }) => {
  const router = Router();

  router.get("/ActiveTeacherList", async (req, res) => {
    try {
      const { category, subject, type } = req.query;
      const filter = { role: "teacher", approved: true, isActive: true };
      if (category) filter.category = category;
      if (subject) filter.subjects = subject;
      if (type) filter.type = type;

      const result = await userCollection
        .find(filter, { projection: TEACHER_LIST_PROJECTION })
        .limit(200)
        .toArray();
      const teacherList = result.map((doc) => ({ id: doc._id, ...doc }));
      res.status(200).send({ success: true, teachers: teacherList });
    } catch (error) {
      console.error(error);
      res.status(500).send({ success: false, error: "Failed to retrieve the teacher list." });
    }
  });

  router.get("/teacherList", async (req, res) => {
    try {
      const { category, subject } = req.query;
      const filter = { role: "teacher", approved: true };
      if (category) filter.category = category;
      if (subject) filter.subjects = subject;

      const result = await userCollection.find(filter).toArray();
      const teacherList = result.map((doc) => ({ id: doc._id, ...doc }));
      res.status(200).send({ success: true, teachers: teacherList });
    } catch (error) {
      console.error(error);
      res.status(500).send({ success: false, error: "Failed to retrieve the teacher list." });
    }
  });

  router.get("/disabledTeacherList", async (req, res) => {
    try {
      const result = await userCollection.find({ role: "teacher", approved: false }).toArray();
      const teacherList = result.map((doc) => ({ id: doc._id, ...doc }));
      res.status(200).send({ success: true, teachers: teacherList });
    } catch (error) {
      console.error(error);
      res.status(500).send({ success: false, error: "Failed to retrieve the teacher list." });
    }
  });

  router.put("/disableTeacher/:uid", async (req, res) => {
    const uid = req.params.uid;
    try {
      const result = await userCollection.updateOne(
        { _id: uid, role: "teacher" },
        { $set: { approved: false } }
      );
      res.status(200).json({ success: true, result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put("/enableTeacher/:uid", async (req, res) => {
    const uid = req.params.uid;
    try {
      const result = await userCollection.updateOne(
        { _id: uid, role: "teacher" },
        { $set: { approved: true } }
      );
      res.status(200).json({ success: true, result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete("/deleteUser/:uid", async (req, res) => {
    const uid = req.params.uid;
    try {
      const result = await userCollection.deleteOne({ _id: uid });
      res.status(200).json({ success: true, result });
    } catch (err) {
      console.error(err);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.put("/subjects", async (req, res) => {
    const { subjects, uid } = req.body;
    try {
      const result = await userCollection.updateOne(
        { _id: uid, role: "teacher" },
        { $set: { subjects } }
      );
      res.status(200).json({ success: true, result });
    } catch (err) {
      console.error(err);
      res.status(400).json({ success: false, error: err.message });
    }
  });

  return router;
};
