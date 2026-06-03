const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeRoomHelpers } = require("../utils/roomHelpers");
const { makeQuizHelpers, makePublicQuizHelpers } = require("../utils/quizHelpers");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");
const { makeSupabaseStorage } = require("../utils/supabaseStorage");
const {
  ROOM_QUIZ_ATTEND_CREDIT,
  ROOM_QUIZ_MAX_QUESTIONS,
  ROOM_QUIZ_REWARD_POOL_RATE,
  PUBLIC_QUIZ_ATTEND_CREDIT,
  PUBLIC_QUIZ_MAX_QUESTIONS,
  PUBLIC_QUIZ_REWARD_POOL_RATE,
} = require("../utils/constants");

module.exports = ({ userCollection, studyRooms, roomQuizzes, publicQuizzes, activepackages, databaseinmongo, client }) => {
  const router = Router();
  const supabaseStorage = makeSupabaseStorage();
  const { createRoomNotification } = makeNotificationHelpers({
    databaseinmongo,
    userCollection,
    studyRooms,
  });
  const { getRoomMembership } = makeRoomHelpers({
    userCollection,
    databaseinmongo,
    studyRooms,
    activepackages,
  });
  const {
    validateQuestions,
    scoreAnswers,
    getQuizStatus,
    getAttempt,
    spendQuizCredit,
    settleQuiz,
    applyQuizRating,
    isAttemptFullyMarked,
    publicQuiz,
  } = makeQuizHelpers({ userCollection, activepackages, roomQuizzes });
  const publicHelpers = makePublicQuizHelpers({ userCollection, activepackages, publicQuizzes });

  const getRoom = async (roomId) => studyRooms.findOne({ _id: new ObjectId(roomId) });

  const isRoomTeacher = (room, teacherId, subject = null) =>
    (room.teacherSessions || []).some(
      (session) =>
        session.teacherId === teacherId &&
        (!subject || String(session.subject || "").toLowerCase() === String(subject).toLowerCase())
    );

  const assertActiveStudent = (room, userId) =>
    userId && (room.memberIds || []).includes(userId) && getRoomMembership(room, userId).isActive;

  const publicRoomQuiz = (quiz, viewerId, room) =>
    publicQuiz(
      quiz && room ? { ...quiz, quizExpenseEnabled: room.quizExpenseEnabled !== false } : quiz,
      viewerId
    );

  router.get("/api/study-rooms/:roomId/quizzes", async (req, res) => {
    try {
      const { userId } = req.query;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      const isAllowed =
        (room.memberIds || []).includes(userId) ||
        (room.teacherSessions || []).some((session) => session.teacherId === userId);
      if (!isAllowed) return res.status(403).json({ error: "Join this room to view quizzes." });
      const quizEconomyEnabled = room.quizExpenseEnabled !== false;

      const quizzes = await roomQuizzes
        .find({ roomId: req.params.roomId })
        .sort({ scheduledAt: -1, createdAt: -1 })
        .limit(80)
        .toArray();

      const visibleQuizzes = quizzes.filter(
        (quiz) => quiz.status !== "draft" || quiz.teacherId === userId
      );

      res.json({
        success: true,
        quizzes: visibleQuizzes.map((quiz) => publicRoomQuiz(quiz, userId, room)),
        constants: {
          attendCredit: quizEconomyEnabled ? ROOM_QUIZ_ATTEND_CREDIT : 0,
          rewardRate: quizEconomyEnabled ? ROOM_QUIZ_REWARD_POOL_RATE : 0,
          maxQuestions: ROOM_QUIZ_MAX_QUESTIONS,
          economyEnabled: quizEconomyEnabled,
        },
      });
    } catch (err) {
      console.error("Error fetching room quizzes:", err);
      res.status(500).json({ error: "Failed to fetch quizzes." });
    }
  });

  router.get("/api/study-rooms/:roomId/quizzes/:quizId", async (req, res) => {
    try {
      const { userId } = req.query;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      const quiz = await roomQuizzes.findOne({
        _id: new ObjectId(req.params.quizId),
        roomId: req.params.roomId,
      });
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      res.json({ success: true, quiz: publicRoomQuiz(quiz, userId, room) });
    } catch (err) {
      console.error("Error fetching room quiz:", err);
      res.status(500).json({ error: "Failed to fetch quiz." });
    }
  });

  router.get("/api/admin/study-rooms/:roomId/quizzes", async (req, res) => {
    try {
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      const quizzes = await roomQuizzes
        .find({ roomId: req.params.roomId })
        .sort({ scheduledAt: -1, createdAt: -1 })
        .limit(120)
        .toArray();
      res.json({
        success: true,
        quizzes: quizzes.map((quiz) => publicRoomQuiz(quiz, quiz.teacherId, room)),
      });
    } catch (err) {
      console.error("Error fetching admin room quizzes:", err);
      res.status(500).json({ error: "Failed to fetch room quizzes." });
    }
  });

  router.post("/api/study-rooms/:roomId/quiz-requests", async (req, res) => {
    try {
      const { userId, teacherId, subject, title = "" } = req.body;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      if (!assertActiveStudent(room, userId))
        return res.status(403).json({ error: "Only active room students can request quizzes." });
      if (!teacherId || !isRoomTeacher(room, teacherId, subject))
        return res.status(404).json({ error: "Teacher is not available in this room subject." });

      const now = new Date();
      const doc = {
        roomId: req.params.roomId,
        roomName: room.name,
        subject: String(subject || "General").trim(),
        title: String(title || `${subject || "Room"} quiz`).trim().slice(0, 120),
        teacherId,
        requestedBy: userId,
        requesters: [userId],
        quizExpenseEnabled: room.quizExpenseEnabled !== false,
        status: "requested",
        questions: [],
        attempts: [],
        createdAt: now,
        updatedAt: now,
      };
      const result = await roomQuizzes.insertOne(doc);
      await createRoomNotification({
        room,
        type: "room_quiz_requested",
        title: "Quiz requested",
        message: `${doc.title} was requested for ${doc.subject}.`,
        actorId: userId,
        actorRole: "student",
        metadata: { quizId: result.insertedId.toString(), teacherId, subject: doc.subject },
      });
      const quiz = await roomQuizzes.findOne({ _id: result.insertedId });
      res.status(201).json({ success: true, quiz: publicRoomQuiz(quiz, userId, room) });
    } catch (err) {
      console.error("Error requesting room quiz:", err);
      res.status(500).json({ error: "Failed to request quiz." });
    }
  });

  router.post("/api/study-rooms/:roomId/quizzes", async (req, res) => {
    try {
      const { teacherId, subject, title = "" } = req.body;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      if (room.teacherControl !== true)
        return res.status(403).json({ error: "Teachers can create quizzes directly only in teacher-controlled rooms." });
      if (!teacherId || !isRoomTeacher(room, teacherId, subject))
        return res.status(404).json({ error: "Teacher is not available in this room subject." });

      const cleanSubject = String(subject || "General").trim();
      const now = new Date();
      const doc = {
        roomId: req.params.roomId,
        roomName: room.name,
        subject: cleanSubject,
        title: String(title || `${cleanSubject} quiz`).trim().slice(0, 120),
        teacherId,
        requestedBy: teacherId,
        requesters: [],
        teacherCreated: true,
        quizExpenseEnabled: room.quizExpenseEnabled !== false,
        status: "draft",
        questions: [],
        attempts: [],
        createdAt: now,
        updatedAt: now,
      };
      const result = await roomQuizzes.insertOne(doc);
      const quiz = await roomQuizzes.findOne({ _id: result.insertedId });
      res.status(201).json({ success: true, quiz: publicRoomQuiz(quiz, teacherId, room) });
    } catch (err) {
      console.error("Error creating controlled room quiz:", err);
      res.status(500).json({ error: "Failed to create quiz." });
    }
  });

  router.patch("/api/study-rooms/:roomId/quizzes/:quizId", async (req, res) => {
    try {
      const {
        teacherId,
        title,
        subject,
        scheduledAt,
        timeLimitMinutes,
        questions = [],
      } = req.body;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      const quiz = await roomQuizzes.findOne({
        _id: new ObjectId(req.params.quizId),
        roomId: req.params.roomId,
      });
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      if (quiz.teacherId !== teacherId || !isRoomTeacher(room, teacherId, subject || quiz.subject))
        return res.status(403).json({ error: "Only this room teacher can prepare the quiz." });

      const { cleanQuestions, invalid } = validateQuestions(questions);
      if (!cleanQuestions.length || invalid)
        return res.status(400).json({ error: "Add valid questions and answers before scheduling." });

      const cleanTimeLimit = Math.max(1, Math.min(Number(timeLimitMinutes) || 10, 240));
      const start = scheduledAt ? new Date(scheduledAt) : new Date();
      if (Number.isNaN(start.getTime()))
        return res.status(400).json({ error: "Valid scheduled time is required." });
      const endsAt = new Date(start.getTime() + cleanTimeLimit * 60 * 1000);

      await roomQuizzes.updateOne(
        { _id: quiz._id },
        {
          $set: {
            title: String(title || quiz.title || "Room quiz").trim().slice(0, 120),
            subject: String(subject || quiz.subject || "General").trim(),
            scheduledAt: start,
            endsAt,
            timeLimitMinutes: cleanTimeLimit,
            questions: cleanQuestions,
            quizExpenseEnabled: room.quizExpenseEnabled !== false,
            status: start.getTime() <= Date.now() ? "open" : "scheduled",
            updatedAt: new Date(),
          },
        }
      );

      const updatedQuiz = await roomQuizzes.findOne({ _id: quiz._id });
      const quizStarted = updatedQuiz.status === "open";
      await createRoomNotification({
        room,
        type: quizStarted ? "room_quiz_started" : "room_quiz_published",
        title: quizStarted ? "Quiz started" : "Quiz published",
        message: `${updatedQuiz.title || "Room quiz"} is ${quizStarted ? "open now" : "scheduled"}.`,
        actorId: teacherId,
        actorRole: "teacher",
        metadata: {
          quizId: updatedQuiz._id.toString(),
          subject: updatedQuiz.subject,
          scheduledAt: updatedQuiz.scheduledAt,
        },
        dedupeKey: `room-quiz-${quizStarted ? "started" : "published"}:${updatedQuiz._id.toString()}`,
      });
      res.json({ success: true, quiz: publicRoomQuiz(updatedQuiz, teacherId, room) });
    } catch (err) {
      console.error("Error preparing room quiz:", err);
      res.status(500).json({ error: "Failed to prepare quiz." });
    }
  });

  router.post("/api/study-rooms/:roomId/quizzes/:quizId/attend", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { userId } = req.body;
      let responsePayload = null;
      let startedNotification = null;

      await mongoSession.withTransaction(async () => {
        const room = await getRoom(req.params.roomId);
        if (!room) {
          responsePayload = { status: 404, body: { error: "Room not found." } };
          return;
        }
        if (!assertActiveStudent(room, userId)) {
          responsePayload = {
            status: 403,
            body: { error: "Only active room students can attend quizzes." },
          };
          return;
        }
        const quiz = await roomQuizzes.findOne(
          { _id: new ObjectId(req.params.quizId), roomId: req.params.roomId },
          { session: mongoSession }
        );
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const status = getQuizStatus(quiz);
        if (!["scheduled", "open"].includes(status)) {
          responsePayload = { status: 409, body: { error: "This quiz is not available to join right now." } };
          return;
        }
        if (status === "open") {
          startedNotification = {
            room,
            quiz,
          };
        }
        if (getAttempt(quiz, userId)) {
          responsePayload = { status: 200, body: { success: true, quiz: publicRoomQuiz(quiz, userId, room) } };
          return;
        }

        let creditResult = { ok: true, remainingCredit: null };
        if (quizEconomyEnabled) {
          creditResult = await spendQuizCredit(userId, mongoSession);
          if (!creditResult.ok) {
            responsePayload = { status: creditResult.status, body: { error: creditResult.message } };
            return;
          }
        }

        const attempt = {
          studentId: userId,
          joinedAt: new Date(),
          creditDeducted: quizEconomyEnabled ? ROOM_QUIZ_ATTEND_CREDIT : 0,
          answers: {},
          score: 0,
          maxScore: (quiz.questions || []).length,
        };
        await roomQuizzes.updateOne(
          { _id: quiz._id, "attempts.studentId": { $ne: userId } },
          { $push: { attempts: attempt }, $set: { updatedAt: new Date() } },
          { session: mongoSession }
        );
        const updatedQuiz = await roomQuizzes.findOne({ _id: quiz._id }, { session: mongoSession });
        responsePayload = {
          status: 201,
          body: {
            success: true,
            quiz: publicRoomQuiz(updatedQuiz, userId, room),
            remainingCredit: creditResult.remainingCredit,
          },
        };
      });

      if (startedNotification) {
        await createRoomNotification({
          room: startedNotification.room,
          type: "room_quiz_started",
          title: "Quiz started",
          message: `${startedNotification.quiz.title || "Room quiz"} is open now.`,
          actorId: startedNotification.quiz.teacherId,
          actorRole: "teacher",
          metadata: {
            quizId: startedNotification.quiz._id.toString(),
            subject: startedNotification.quiz.subject,
            scheduledAt: startedNotification.quiz.scheduledAt,
          },
          dedupeKey: `room-quiz-started:${startedNotification.quiz._id.toString()}`,
        });
      }
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error attending room quiz:", err);
      res.status(500).json({ error: "Failed to attend quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.post("/api/study-rooms/:roomId/quizzes/:quizId/submit", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { userId, answers = {} } = req.body;
      let responsePayload = null;
      await mongoSession.withTransaction(async () => {
        const room = await getRoom(req.params.roomId);
        if (!room) {
          responsePayload = { status: 404, body: { error: "Room not found." } };
          return;
        }
        const quizEconomyEnabled = room.quizExpenseEnabled !== false;
        const quiz = await roomQuizzes.findOne(
          { _id: new ObjectId(req.params.quizId), roomId: req.params.roomId },
          { session: mongoSession }
        );
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const attempt = getAttempt(quiz, userId);
        if (!attempt) {
          responsePayload = { status: 403, body: { error: "Attend this quiz before submitting." } };
          return;
        }
        if (attempt.submittedAt) {
          responsePayload = { status: 409, body: { error: "Quiz already submitted." } };
          return;
        }
        if (getQuizStatus(quiz) === "completed") {
          responsePayload = { status: 409, body: { error: "This quiz is already completed." } };
          return;
        }

        const scored = scoreAnswers(quiz.questions || [], answers);
        await roomQuizzes.updateOne(
          { _id: quiz._id, "attempts.studentId": userId },
          {
            $set: {
              "attempts.$.answers": scored.checkedAnswers,
              "attempts.$.score": scored.score,
              "attempts.$.maxScore": scored.maxScore,
              "attempts.$.submittedAt": new Date(),
              updatedAt: new Date(),
            },
          },
          { session: mongoSession }
        );

        const updatedQuiz = await roomQuizzes.findOne({ _id: quiz._id }, { session: mongoSession });
        responsePayload = { status: 200, body: { success: true, quiz: publicRoomQuiz(updatedQuiz, userId, room) } };
      });
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error submitting room quiz:", err);
      res.status(500).json({ error: "Failed to submit quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.post("/api/study-rooms/:roomId/quizzes/:quizId/marks", async (req, res) => {
    try {
      const { teacherId, marks = {} } = req.body;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      const quiz = await roomQuizzes.findOne({
        _id: new ObjectId(req.params.quizId),
        roomId: req.params.roomId,
      });
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      if (quiz.teacherId !== teacherId)
        return res.status(403).json({ error: "Only the quiz teacher can submit marks." });

      const manualQuestionIds = new Set((quiz.questions || [])
        .filter((question) => ["open", "image"].includes(question.type))
        .map((question) => question.id));
      const updatedAttempts = (quiz.attempts || []).map((attempt) => {
        if (!attempt.submittedAt) return attempt;
        let score = 0;
        const answers = { ...(attempt.answers || {}) };
        (quiz.questions || []).forEach((question) => {
          const answer = answers[question.id] || {};
          if (question.type === "mcq") {
            if (answer.isCorrect) score += 1;
            return;
          }
          const rawScore = marks?.[attempt.studentId]?.[question.id];
          const manualScore = rawScore === undefined ? answer.manualScore : Math.min(Math.max(Number(rawScore) || 0, 0), 1);
          answers[question.id] = { ...answer, manualScore, markedAt: new Date(), markedBy: teacherId };
          score += manualScore;
        });
        return {
          ...attempt,
          answers,
          score,
          maxScore: (quiz.questions || []).length,
          manuallyMarkedAt: new Date(),
        };
      });
      const allMarked = updatedAttempts
        .filter((attempt) => attempt.submittedAt)
        .every((attempt) => isAttemptFullyMarked({ ...quiz, attempts: updatedAttempts }, attempt));

      await roomQuizzes.updateOne(
        { _id: quiz._id },
        {
          $set: {
            attempts: updatedAttempts,
            markingCompletedAt: allMarked ? new Date() : null,
            markingCompletedBy: allMarked ? teacherId : null,
            manualQuestionCount: manualQuestionIds.size,
            updatedAt: new Date(),
          },
        }
      );
      const updatedQuiz = await roomQuizzes.findOne({ _id: quiz._id });
      res.json({ success: true, allMarked, quiz: publicRoomQuiz(updatedQuiz, teacherId, room) });
    } catch (err) {
      console.error("Error marking room quiz:", err);
      res.status(500).json({ error: "Failed to submit marks." });
    }
  });

  router.post("/api/admin/study-rooms/:roomId/quizzes/:quizId/settle", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { adminId } = req.body;
      let responsePayload = null;
      let resultsNotification = null;
      await mongoSession.withTransaction(async () => {
        const adminUser = adminId ? await userCollection.findOne({ uid: adminId }, { session: mongoSession }) : null;
        if (adminId && !["admin", "owner"].includes(adminUser?.role)) {
          responsePayload = { status: 403, body: { error: "Only admin can calculate quiz rewards and points." } };
          return;
        }
        const room = await getRoom(req.params.roomId);
        if (!room) {
          responsePayload = { status: 404, body: { error: "Room not found." } };
          return;
        }
        const quizEconomyEnabled = room.quizExpenseEnabled !== false;
        const quiz = await roomQuizzes.findOne(
          { _id: new ObjectId(req.params.quizId), roomId: req.params.roomId },
          { session: mongoSession }
        );
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const settled = await settleQuiz(quiz._id.toString(), mongoSession, { economyEnabled: quizEconomyEnabled });
        if (settled.ok) {
          resultsNotification = {
            type: "room_quiz_results",
            title: "Quiz results published",
            message: `${settled.quiz.title || "Room quiz"} results are ready.`,
            actorId: adminId || "admin",
            actorRole: "admin",
            metadata: { quizId: quiz._id.toString(), subject: quiz.subject },
            dedupeKey: `room-quiz-results:${quiz._id.toString()}`,
          };
        }
        responsePayload = {
          status: settled.ok ? 200 : settled.status,
          body: settled.ok
            ? { success: true, quiz: publicRoomQuiz(settled.quiz, adminId || quiz.teacherId, room) }
            : { error: settled.message },
        };
      });
      if (resultsNotification) {
        await createRoomNotification({
          room: await getRoom(req.params.roomId),
          ...resultsNotification,
        });
      }
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error settling room quiz:", err);
      res.status(500).json({ error: "Failed to finish quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.post("/api/study-rooms/:roomId/quizzes/:quizId/settle", async (req, res) => {
    res.status(403).json({ error: "Quiz reward and point calculation is handled by admin after teacher marking." });
  });

  router.delete("/api/admin/study-rooms/:roomId/quizzes/:quizId", async (req, res) => {
    try {
      const { adminId } = req.body || {};
      const adminUser = adminId ? await userCollection.findOne({ uid: adminId }) : null;
      if (adminId && !["admin", "owner"].includes(adminUser?.role))
        return res.status(403).json({ error: "Only admin can delete room quizzes." });

      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });
      const quiz = await roomQuizzes.findOne({
        _id: new ObjectId(req.params.quizId),
        roomId: req.params.roomId,
      });
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });

      await supabaseStorage.deletePaths(supabaseStorage.collectQuizStoragePaths(quiz));
      await supabaseStorage.deleteFolders([`rooms/${req.params.roomId}/quizzes/${quiz._id.toString()}`]);
      await roomQuizzes.deleteOne({ _id: quiz._id });
      await createRoomNotification({
        room,
        type: "room_quiz_deleted",
        title: "Quiz removed",
        message: `${quiz.title || "Room quiz"} was removed by admin.`,
        actorId: adminId || "admin",
        actorRole: "admin",
        metadata: { quizId: quiz._id.toString(), subject: quiz.subject },
      });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting room quiz as admin:", err);
      res.status(500).json({ error: "Failed to delete quiz." });
    }
  });

  router.post("/api/study-rooms/:roomId/quizzes/:quizId/rate", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { userId, rating } = req.body;
      let responsePayload = null;
      await mongoSession.withTransaction(async () => {
        const room = await getRoom(req.params.roomId);
        if (!room) {
          responsePayload = { status: 404, body: { error: "Room not found." } };
          return;
        }
        const quizEconomyEnabled = room.quizExpenseEnabled !== false;
        const quiz = await roomQuizzes.findOne(
          { _id: new ObjectId(req.params.quizId), roomId: req.params.roomId },
          { session: mongoSession }
        );
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const result = await applyQuizRating({ quiz, studentId: userId, rating, session: mongoSession, economyEnabled: quizEconomyEnabled });
        if (!result.ok) {
          responsePayload = { status: result.status, body: { error: result.message } };
          return;
        }
        const updatedQuiz = await roomQuizzes.findOne({ _id: quiz._id }, { session: mongoSession });
        responsePayload = { status: 200, body: { success: true, quiz: publicRoomQuiz(updatedQuiz, userId, room) } };
      });
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error rating room quiz:", err);
      res.status(500).json({ error: "Failed to rate quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.delete("/api/study-rooms/:roomId/quizzes/:quizId", async (req, res) => {
    try {
      const { userId } = req.body;
      const room = await getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: "Room not found." });

      const quiz = await roomQuizzes.findOne({
        _id: new ObjectId(req.params.quizId),
        roomId: req.params.roomId,
      });
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      if (getQuizStatus(quiz) !== "completed")
        return res.status(409).json({ error: "Only published/completed quiz results can be deleted." });

      const canDelete = quiz.teacherId === userId || room.createdBy === userId;
      if (!canDelete)
        return res.status(403).json({ error: "Only the quiz teacher or room creator can delete this quiz." });

      await supabaseStorage.deletePaths(supabaseStorage.collectQuizStoragePaths(quiz));
      await supabaseStorage.deleteFolders([`rooms/${req.params.roomId}/quizzes/${quiz._id.toString()}`]);
      await roomQuizzes.deleteOne({ _id: quiz._id });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting room quiz:", err);
      res.status(500).json({ error: "Failed to delete quiz." });
    }
  });

  const getPublicQuiz = async (quizId, session = null) =>
    publicQuizzes.findOne({ _id: new ObjectId(quizId) }, { session });

  router.get("/api/public-quizzes", async (req, res) => {
    try {
      const { userId, teacherId, category, type, subject } = req.query;
      const filter = {};

      if (teacherId) {
        filter.teacherId = teacherId;
      } else if (userId) {
        const userDoc = await userCollection.findOne({ uid: userId });
        if (!userDoc) return res.status(404).json({ error: "User not found." });
        if (userDoc.role === "teacher") filter.teacherId = userId;
        else {
          filter.category = category || userDoc.category || "school";
          filter.type = type || userDoc.type || "bangla_medium";
          filter.status = { $in: ["scheduled", "open", "completed"] };
        }
      }

      if (category) filter.category = category;
      if (type) filter.type = type;
      if (subject) filter.subject = subject;

      const quizzes = await publicQuizzes
        .find(filter)
        .sort({ scheduledAt: -1, createdAt: -1 })
        .limit(100)
        .toArray();

      res.json({
        success: true,
        quizzes: quizzes.map((quiz) => publicHelpers.publicQuiz(quiz, userId || teacherId)),
        constants: {
          attendCredit: PUBLIC_QUIZ_ATTEND_CREDIT,
          rewardRate: PUBLIC_QUIZ_REWARD_POOL_RATE,
          maxQuestions: PUBLIC_QUIZ_MAX_QUESTIONS,
        },
      });
    } catch (err) {
      console.error("Error fetching public quizzes:", err);
      res.status(500).json({ error: "Failed to fetch public quizzes." });
    }
  });

  router.get("/api/public-quizzes/:quizId", async (req, res) => {
    try {
      const { userId } = req.query;
      const quiz = await getPublicQuiz(req.params.quizId);
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      res.json({ success: true, quiz: publicHelpers.publicQuiz(quiz, userId) });
    } catch (err) {
      console.error("Error fetching public quiz:", err);
      res.status(500).json({ error: "Failed to fetch public quiz." });
    }
  });

  router.patch("/api/public-quizzes/:quizId", async (req, res) => {
    try {
      const { teacherId, title, scheduledAt, timeLimitMinutes, questions = [] } = req.body;
      const quiz = await getPublicQuiz(req.params.quizId);
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      if (quiz.teacherId !== teacherId)
        return res.status(403).json({ error: "Only the assigned teacher can prepare this quiz." });
      if (quiz.status === "completed")
        return res.status(409).json({ error: "Completed quizzes cannot be edited." });

      const { cleanQuestions, invalid } = publicHelpers.validateQuestions(questions);
      if (!cleanQuestions.length || invalid)
        return res.status(400).json({ error: "Add valid questions and answers before scheduling." });

      const cleanTimeLimit = Math.max(1, Math.min(Number(timeLimitMinutes) || 10, 240));
      const start = scheduledAt ? new Date(scheduledAt) : new Date();
      if (Number.isNaN(start.getTime()))
        return res.status(400).json({ error: "Valid scheduled time is required." });
      const endsAt = new Date(start.getTime() + cleanTimeLimit * 60 * 1000);

      await publicQuizzes.updateOne(
        { _id: quiz._id },
        {
          $set: {
            title: String(title || quiz.title || "Public quiz").trim().slice(0, 120),
            scheduledAt: start,
            endsAt,
            timeLimitMinutes: cleanTimeLimit,
            questions: cleanQuestions,
            status: start.getTime() <= Date.now() ? "open" : "scheduled",
            updatedAt: new Date(),
          },
        }
      );

      const updatedQuiz = await getPublicQuiz(req.params.quizId);
      res.json({ success: true, quiz: publicHelpers.publicQuiz(updatedQuiz, teacherId) });
    } catch (err) {
      console.error("Error preparing public quiz:", err);
      res.status(500).json({ error: "Failed to prepare public quiz." });
    }
  });

  router.post("/api/public-quizzes/:quizId/attend", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { userId } = req.body;
      let responsePayload = null;

      await mongoSession.withTransaction(async () => {
        const userDoc = await userCollection.findOne({ uid: userId, role: "student" }, { session: mongoSession });
        if (!userDoc) {
          responsePayload = { status: 403, body: { error: "Only students can attend public quizzes." } };
          return;
        }
        const quiz = await getPublicQuiz(req.params.quizId, mongoSession);
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        if (
          quiz.category !== (userDoc.category || "school") ||
          quiz.type !== (userDoc.type || "bangla_medium")
        ) {
          responsePayload = { status: 403, body: { error: "This quiz is not available for your category and medium." } };
          return;
        }
        const status = publicHelpers.getQuizStatus(quiz);
        if (!["scheduled", "open"].includes(status)) {
          responsePayload = { status: 409, body: { error: "This quiz is not available to join right now." } };
          return;
        }
        if (publicHelpers.getAttempt(quiz, userId)) {
          responsePayload = { status: 200, body: { success: true, quiz: publicHelpers.publicQuiz(quiz, userId) } };
          return;
        }

        const creditResult = await publicHelpers.spendQuizCredit(userId, mongoSession);
        if (!creditResult.ok) {
          responsePayload = { status: creditResult.status, body: { error: creditResult.message } };
          return;
        }

        const attempt = {
          studentId: userId,
          joinedAt: new Date(),
          creditDeducted: PUBLIC_QUIZ_ATTEND_CREDIT,
          answers: {},
          score: 0,
          maxScore: (quiz.questions || []).length,
        };
        await publicQuizzes.updateOne(
          { _id: quiz._id, "attempts.studentId": { $ne: userId } },
          { $push: { attempts: attempt }, $set: { updatedAt: new Date() } },
          { session: mongoSession }
        );
        const updatedQuiz = await getPublicQuiz(req.params.quizId, mongoSession);
        responsePayload = {
          status: 201,
          body: {
            success: true,
            quiz: publicHelpers.publicQuiz(updatedQuiz, userId),
            remainingCredit: creditResult.remainingCredit,
          },
        };
      });

      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error attending public quiz:", err);
      res.status(500).json({ error: "Failed to attend public quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.post("/api/public-quizzes/:quizId/submit", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { userId, answers = {} } = req.body;
      let responsePayload = null;
      await mongoSession.withTransaction(async () => {
        const quiz = await getPublicQuiz(req.params.quizId, mongoSession);
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const attempt = publicHelpers.getAttempt(quiz, userId);
        if (!attempt) {
          responsePayload = { status: 403, body: { error: "Attend this quiz before submitting." } };
          return;
        }
        if (attempt.submittedAt) {
          responsePayload = { status: 409, body: { error: "Quiz already submitted." } };
          return;
        }
        if (publicHelpers.getQuizStatus(quiz) === "completed") {
          responsePayload = { status: 409, body: { error: "This quiz is already completed." } };
          return;
        }

        const scored = publicHelpers.scoreAnswers(quiz.questions || [], answers);
        await publicQuizzes.updateOne(
          { _id: quiz._id, "attempts.studentId": userId },
          {
            $set: {
              "attempts.$.answers": scored.checkedAnswers,
              "attempts.$.score": scored.score,
              "attempts.$.maxScore": scored.maxScore,
              "attempts.$.submittedAt": new Date(),
              updatedAt: new Date(),
            },
          },
          { session: mongoSession }
        );

        const updatedQuiz = await getPublicQuiz(req.params.quizId, mongoSession);
        responsePayload = { status: 200, body: { success: true, quiz: publicHelpers.publicQuiz(updatedQuiz, userId) } };
      });
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error submitting public quiz:", err);
      res.status(500).json({ error: "Failed to submit public quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.post("/api/admin/public-quizzes/:quizId/settle", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { adminId } = req.body || {};
      let responsePayload = null;
      await mongoSession.withTransaction(async () => {
        const adminUser = adminId ? await userCollection.findOne({ uid: adminId }, { session: mongoSession }) : null;
        if (adminId && !["admin", "owner"].includes(adminUser?.role)) {
          responsePayload = { status: 403, body: { error: "Only admin can calculate public quiz rewards and points." } };
          return;
        }
        const quiz = await getPublicQuiz(req.params.quizId, mongoSession);
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const settled = await publicHelpers.settleQuiz(quiz._id.toString(), mongoSession);
        responsePayload = {
          status: settled.ok ? 200 : settled.status,
          body: settled.ok
            ? { success: true, quiz: publicHelpers.publicQuiz(settled.quiz, adminId || quiz.teacherId) }
            : { error: settled.message },
        };
      });
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error settling public quiz:", err);
      res.status(500).json({ error: "Failed to finish public quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  router.post("/api/public-quizzes/:quizId/settle", async (req, res) => {
    res.status(403).json({ error: "Quiz reward and point calculation is handled by admin after teacher marking." });
  });

  router.post("/api/public-quizzes/:quizId/marks", async (req, res) => {
    try {
      const { teacherId, marks = {} } = req.body;
      const quiz = await getPublicQuiz(req.params.quizId);
      if (!quiz) return res.status(404).json({ error: "Quiz not found." });
      if (quiz.teacherId !== teacherId)
        return res.status(403).json({ error: "Only the assigned quiz teacher can submit marks." });

      const manualQuestionIds = new Set((quiz.questions || [])
        .filter((question) => ["open", "image"].includes(question.type))
        .map((question) => question.id));
      const updatedAttempts = (quiz.attempts || []).map((attempt) => {
        if (!attempt.submittedAt) return attempt;
        let score = 0;
        const answers = { ...(attempt.answers || {}) };
        (quiz.questions || []).forEach((question) => {
          const answer = answers[question.id] || {};
          if (question.type === "mcq") {
            if (answer.isCorrect) score += 1;
            return;
          }
          const rawScore = marks?.[attempt.studentId]?.[question.id];
          const manualScore = rawScore === undefined ? answer.manualScore : Math.min(Math.max(Number(rawScore) || 0, 0), 1);
          answers[question.id] = { ...answer, manualScore, markedAt: new Date(), markedBy: teacherId };
          score += manualScore;
        });
        return {
          ...attempt,
          answers,
          score,
          maxScore: (quiz.questions || []).length,
          manuallyMarkedAt: new Date(),
        };
      });
      const allMarked = updatedAttempts
        .filter((attempt) => attempt.submittedAt)
        .every((attempt) => publicHelpers.isAttemptFullyMarked({ ...quiz, attempts: updatedAttempts }, attempt));

      await publicQuizzes.updateOne(
        { _id: quiz._id },
        {
          $set: {
            attempts: updatedAttempts,
            markingCompletedAt: allMarked ? new Date() : null,
            markingCompletedBy: allMarked ? teacherId : null,
            manualQuestionCount: manualQuestionIds.size,
            updatedAt: new Date(),
          },
        }
      );
      const updatedQuiz = await getPublicQuiz(req.params.quizId);
      res.json({ success: true, allMarked, quiz: publicHelpers.publicQuiz(updatedQuiz, teacherId) });
    } catch (err) {
      console.error("Error marking public quiz:", err);
      res.status(500).json({ error: "Failed to submit marks." });
    }
  });

  router.post("/api/public-quizzes/:quizId/rate", async (req, res) => {
    const mongoSession = client.startSession();
    try {
      const { userId, rating } = req.body;
      let responsePayload = null;
      await mongoSession.withTransaction(async () => {
        const quiz = await getPublicQuiz(req.params.quizId, mongoSession);
        if (!quiz) {
          responsePayload = { status: 404, body: { error: "Quiz not found." } };
          return;
        }
        const result = await publicHelpers.applyQuizRating({ quiz, studentId: userId, rating, session: mongoSession });
        if (!result.ok) {
          responsePayload = { status: result.status, body: { error: result.message } };
          return;
        }
        const updatedQuiz = await getPublicQuiz(req.params.quizId, mongoSession);
        responsePayload = { status: 200, body: { success: true, quiz: publicHelpers.publicQuiz(updatedQuiz, userId) } };
      });
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error rating public quiz:", err);
      res.status(500).json({ error: "Failed to rate public quiz." });
    } finally {
      await mongoSession.endSession();
    }
  });

  return router;
};
