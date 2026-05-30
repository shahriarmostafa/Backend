const { ObjectId } = require("mongodb");
const {
  ROOM_QUIZ_ATTEND_CREDIT,
  ROOM_QUIZ_REWARD_POOL_RATE,
  ROOM_QUIZ_MAX_QUESTIONS,
} = require("./constants");

const makeQuizHelpers = ({ userCollection, activepackages, roomQuizzes }) => {
  const normalizeQuestion = (question = {}) => {
    const type = question.type === "open" ? "open" : "mcq";
    const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
    return {
      id: question.id || new ObjectId().toString(),
      type,
      prompt: String(question.prompt || "").trim().slice(0, 700),
      options: type === "mcq" ? options.map((item) => String(item || "").trim()).slice(0, 4) : [],
      correctOption:
        type === "mcq" && Number.isInteger(Number(question.correctOption))
          ? Math.min(Math.max(Number(question.correctOption), 0), 3)
          : null,
      answerText: type === "open" ? String(question.answerText || "").trim().slice(0, 400) : "",
      imageUrl: String(question.imageUrl || "").trim(),
    };
  };

  const validateQuestions = (questions = []) => {
    const cleanQuestions = questions.slice(0, ROOM_QUIZ_MAX_QUESTIONS).map(normalizeQuestion);
    const invalid = cleanQuestions.some((question) => {
      if (!question.prompt) return true;
      if (question.type === "mcq") {
        return question.options.length !== 4 || question.options.some((item) => !item);
      }
      return !question.answerText;
    });
    return { cleanQuestions, invalid };
  };

  const scoreAnswers = (questions = [], answers = {}) => {
    let score = 0;
    const checkedAnswers = {};
    questions.forEach((question) => {
      const rawAnswer = answers[question.id];
      let isCorrect = false;
      if (question.type === "mcq") {
        const selectedOption = Number(rawAnswer?.selectedOption ?? rawAnswer);
        isCorrect = selectedOption === Number(question.correctOption);
        checkedAnswers[question.id] = { selectedOption, isCorrect };
      } else {
        const text = String(rawAnswer?.text ?? rawAnswer ?? "").trim();
        isCorrect =
          text.toLowerCase() === String(question.answerText || "").trim().toLowerCase();
        checkedAnswers[question.id] = { text, isCorrect };
      }
      if (isCorrect) score += 1;
    });
    return { score, maxScore: questions.length, checkedAnswers };
  };

  const getQuizStatus = (quiz) => {
    if (!quiz) return "missing";
    if (quiz.status === "completed") return "completed";
    if (quiz.status === "requested") return "requested";
    const scheduledAt = quiz.scheduledAt ? new Date(quiz.scheduledAt).getTime() : 0;
    const endsAt = quiz.endsAt ? new Date(quiz.endsAt).getTime() : 0;
    const now = Date.now();
    if (endsAt && now > endsAt) return "ended";
    if (scheduledAt && now >= scheduledAt) return "open";
    return "scheduled";
  };

  const getAttempt = (quiz, studentId) =>
    (quiz.attempts || []).find((attempt) => attempt.studentId === studentId);

  const spendQuizCredit = async (studentId, session) => {
    const activePackage = await activepackages.findOne({ uid: studentId }, { session });
    const credit = Number(activePackage?.credit) || 0;
    const isValid =
      activePackage?.isActive === true && new Date(activePackage.expiryDate) > new Date();
    if (!isValid)
      return { ok: false, status: 403, message: "No active package found for this student." };
    if (credit < ROOM_QUIZ_ATTEND_CREDIT)
      return {
        ok: false,
        status: 402,
        message: `At least ${ROOM_QUIZ_ATTEND_CREDIT} credit is required.`,
      };
    await activepackages.updateOne(
      { uid: studentId },
      { $inc: { credit: -ROOM_QUIZ_ATTEND_CREDIT } },
      { session }
    );
    return { ok: true, remainingCredit: credit - ROOM_QUIZ_ATTEND_CREDIT };
  };

  const distributeRewards = (totalRewardPool, winnerCount) => {
    if (winnerCount <= 0 || totalRewardPool <= 0) return [];
    if (winnerCount === 1) return [Math.round(totalRewardPool)];
    const weights = winnerCount === 3 ? [3, 2, 1] : Array.from({ length: winnerCount }, () => 1);
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    const rewards = weights.map((weight) => Math.floor((totalRewardPool * weight) / weightTotal));
    let remainder = Math.round(totalRewardPool) - rewards.reduce((sum, value) => sum + value, 0);
    for (let i = 0; remainder > 0 && i < rewards.length; i += 1, remainder -= 1) rewards[i] += 1;
    return rewards;
  };

  const settleQuiz = async (quizId, session = null) => {
    const quiz = await roomQuizzes.findOne({ _id: new ObjectId(quizId) }, { session });
    if (!quiz) return { ok: false, status: 404, message: "Quiz not found." };
    if (quiz.status === "completed" || quiz.settledAt)
      return { ok: true, alreadySettled: true, quiz };

    const submittedAttempts = (quiz.attempts || []).filter((attempt) => attempt.submittedAt);
    const totalCollectedCredit = submittedAttempts.reduce(
      (sum, attempt) => sum + (Number(attempt.creditDeducted) || 0),
      0
    );
    const winnerCount = submittedAttempts.length > 5 ? 3 : submittedAttempts.length ? 1 : 0;
    const sortedAttempts = [...submittedAttempts].sort((a, b) => {
      if ((Number(b.score) || 0) !== (Number(a.score) || 0))
        return (Number(b.score) || 0) - (Number(a.score) || 0);
      return new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0);
    });
    const winners = sortedAttempts.slice(0, winnerCount);
    const rewardPool = Math.round(totalCollectedCredit * ROOM_QUIZ_REWARD_POOL_RATE);
    const rewardAmounts = distributeRewards(rewardPool, winnerCount);
    const winnerRewards = winners.map((attempt, index) => ({
      studentId: attempt.studentId,
      rewardCredit: rewardAmounts[index] || 0,
      position: index + 1,
    }));

    for (const winner of winnerRewards) {
      if (winner.rewardCredit > 0) {
        await activepackages.updateOne(
          { uid: winner.studentId },
          { $inc: { credit: winner.rewardCredit } },
          { session }
        );
      }
    }

    const teacherBasePoints = Math.ceil(((quiz.questions || []).length || 0) / 2);
    if (teacherBasePoints > 0 && quiz.teacherId) {
      await userCollection.updateOne(
        { uid: quiz.teacherId },
        { $inc: { points: teacherBasePoints } },
        { session }
      );
    }

    const attempts = (quiz.attempts || []).map((attempt) => {
      const reward = winnerRewards.find((item) => item.studentId === attempt.studentId);
      return reward
        ? { ...attempt, rewardCredit: reward.rewardCredit, position: reward.position }
        : { ...attempt, rewardCredit: Number(attempt.rewardCredit) || 0 };
    });

    await roomQuizzes.updateOne(
      { _id: quiz._id },
      {
        $set: {
          attempts,
          status: "completed",
          settledAt: new Date(),
          settlement: {
            totalCollectedCredit,
            rewardPool,
            rewardRate: ROOM_QUIZ_REWARD_POOL_RATE,
            winners: winnerRewards,
            teacherBasePoints,
          },
        },
      },
      { session }
    );

    const settledQuiz = await roomQuizzes.findOne({ _id: quiz._id }, { session });
    return { ok: true, quiz: settledQuiz };
  };

  const applyQuizRating = async ({ quiz, studentId, rating, session = null }) => {
    const normalizedRating = Math.min(Math.max(Number(rating) || 0, 1), 5);
    const attempt = getAttempt(quiz, studentId);
    if (!attempt?.submittedAt)
      return { ok: false, status: 403, message: "Submit this quiz before rating it." };
    if (attempt.rating)
      return { ok: false, status: 409, message: "You already rated this quiz." };

    let pointDelta = 0;
    if (normalizedRating === 5) pointDelta = 1;
    else if (normalizedRating < 4) pointDelta = normalizedRating <= 2 ? -2 : -1;

    if (pointDelta !== 0 && quiz.teacherId) {
      await userCollection.updateOne(
        { uid: quiz.teacherId },
        { $inc: { points: pointDelta } },
        { session }
      );
    }

    await roomQuizzes.updateOne(
      { _id: quiz._id, "attempts.studentId": studentId },
      {
        $set: {
          "attempts.$.rating": normalizedRating,
          "attempts.$.ratingPointDelta": pointDelta,
          "attempts.$.ratedAt": new Date(),
        },
      },
      { session }
    );

    return { ok: true, pointDelta };
  };

  const publicQuiz = (quiz, viewerId = null) => {
    if (!quiz) return null;
    const status = getQuizStatus(quiz);
    const attempt = viewerId ? getAttempt(quiz, viewerId) : null;
    const canShowAnswers = status === "completed";
    return {
      ...quiz,
      id: quiz._id.toString(),
      status,
      questions: (quiz.questions || []).map((question) => ({
        ...question,
        correctOption: canShowAnswers ? question.correctOption : undefined,
        answerText: canShowAnswers ? question.answerText : undefined,
      })),
      myAttempt: attempt || null,
      attempts: canShowAnswers ? quiz.attempts || [] : undefined,
      constants: {
        attendCredit: ROOM_QUIZ_ATTEND_CREDIT,
        rewardRate: ROOM_QUIZ_REWARD_POOL_RATE,
        maxQuestions: ROOM_QUIZ_MAX_QUESTIONS,
      },
    };
  };

  return {
    normalizeQuestion,
    validateQuestions,
    scoreAnswers,
    getQuizStatus,
    getAttempt,
    spendQuizCredit,
    settleQuiz,
    applyQuizRating,
    publicQuiz,
  };
};

module.exports = { makeQuizHelpers };
