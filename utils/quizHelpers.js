const { ObjectId } = require("mongodb");
const {
  ROOM_QUIZ_ATTEND_CREDIT,
  ROOM_QUIZ_REWARD_POOL_RATE,
  ROOM_QUIZ_MAX_QUESTIONS,
  PUBLIC_QUIZ_ATTEND_CREDIT,
  PUBLIC_QUIZ_REWARD_POOL_RATE,
  PUBLIC_QUIZ_MAX_QUESTIONS,
  PUBLIC_QUIZ_REWARD_STEP_SIZE,
  PUBLIC_QUIZ_REWARD_BASE_WINNERS,
  PUBLIC_QUIZ_REWARD_WINNER_STEP,
  PUBLIC_QUIZ_REWARD_MAX_WINNERS,
  QUIZ_SUBMIT_GRACE_MS,
} = require("./constants");
const { makeTeacherQualityHelpers } = require("./teacherQualityHelpers");
const {
  extractStoragePath,
  normalizePath,
  getQuizStorageFolder,
  isStoragePathWithin,
} = require("./r2Storage");

const MAX_OPEN_ANSWER_LENGTH = 4000;

/**
 * Where a student's image answers for a quiz must live. Matches the paths the
 * app uploads to (RoomQuizPanel / PublicQuizzes):
 *   rooms/{roomId}/quizzes/{quizId}/answers/{uid}/...
 *   public-quizzes/{quizId}/answers/{uid}/...
 */
const getAnswerStorageFolder = (quiz, studentId) => {
  const folder = getQuizStorageFolder(quiz);
  return folder && studentId ? `${folder}/answers/${studentId}` : "";
};

/**
 * The latest moment an attempt may still be submitted, before grace: the quiz's
 * own end, or the attempt's time limit counted from when it could first see the
 * questions (join time, or the scheduled start for students who joined early) -
 * whichever comes first. 0 means the quiz carries no timing at all.
 */
const getAttemptDeadline = (quiz = {}, attempt = null) => {
  const endsAt = quiz.endsAt ? new Date(quiz.endsAt).getTime() : 0;
  const scheduledAt = quiz.scheduledAt ? new Date(quiz.scheduledAt).getTime() : 0;
  const joinedAt = attempt?.joinedAt ? new Date(attempt.joinedAt).getTime() : 0;
  const limitMs = Number(quiz.timeLimitMinutes) > 0 ? Number(quiz.timeLimitMinutes) * 60 * 1000 : 0;
  const startedAt = Math.max(joinedAt || 0, scheduledAt || 0);
  const attemptEnd = limitMs && startedAt ? startedAt + limitMs : 0;
  const candidates = [endsAt, attemptEnd].filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.min(...candidates) : 0;
};

/**
 * Splits a reward pool across winners. Three winners share it 3:2:1, any other
 * count splits it evenly. Floor-rounding leftovers are handed back out one
 * credit at a time from the top, so the payouts always sum to the pool exactly.
 *
 * Module scope so it can be unit tested without building the helper factory.
 */
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

const makeQuizHelpers = ({
  userCollection,
  activepackages,
  roomQuizzes,
  quizCollection = roomQuizzes,
  attendCredit = ROOM_QUIZ_ATTEND_CREDIT,
  rewardPoolRate = ROOM_QUIZ_REWARD_POOL_RATE,
  maxQuestions = ROOM_QUIZ_MAX_QUESTIONS,
  getWinnerCount = null,
  databaseinmongo = null,
} = {}) => {
  const { recordRatingEvent, applyTeacherQualitySnapshot } = makeTeacherQualityHelpers({
    databaseinmongo,
    userCollection,
  });
  const normalizeQuestion = (question = {}) => {
    const type = ["open", "image"].includes(question.type) ? question.type : "mcq";
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
      imageUrl: "",
      storagePath: "",
    };
  };

  const validateQuestions = (questions = []) => {
    const cleanQuestions = questions.slice(0, maxQuestions).map(normalizeQuestion);
    const invalid = cleanQuestions.some((question) => {
      if (!question.prompt) return true;
      if (question.type === "mcq") {
        return question.options.length !== 4 || question.options.some((item) => !item);
      }
      if (question.type === "open") return !question.answerText;
      return false;
    });
    return { cleanQuestions, invalid };
  };

  /**
   * `storageFolder` is the student's own answer folder for this quiz. Image
   * answers whose path or URL point anywhere else are dropped: both are stored
   * and later deleted with the quiz, so an unchecked path let a student aim the
   * quiz delete at any file in the bucket.
   */
  const scoreAnswers = (questions = [], answers = {}, { storageFolder = "" } = {}) => {
    let score = 0;
    const checkedAnswers = {};
    const safeAnswers = answers && typeof answers === "object" ? answers : {};
    questions.forEach((question) => {
      const rawAnswer = safeAnswers[question.id];
      let isCorrect = false;
      if (question.type === "mcq") {
        const selectedOption = Number(rawAnswer?.selectedOption ?? rawAnswer);
        isCorrect = selectedOption === Number(question.correctOption);
        checkedAnswers[question.id] = { selectedOption, isCorrect };
      } else if (question.type === "open") {
        const text = String(rawAnswer?.text ?? rawAnswer ?? "").trim().slice(0, MAX_OPEN_ANSWER_LENGTH);
        checkedAnswers[question.id] = { text, isCorrect: false, needsManualMarking: true };
      } else {
        const rawImageUrl = String(rawAnswer?.imageUrl ?? rawAnswer?.image ?? rawAnswer ?? "").trim();
        const rawStoragePath = normalizePath(String(rawAnswer?.storagePath || "").trim());
        const imagePath = extractStoragePath(rawImageUrl);
        const imageUrl = storageFolder && imagePath && isStoragePathWithin(imagePath, storageFolder) ? rawImageUrl : "";
        const storagePath =
          storageFolder && isStoragePathWithin(rawStoragePath, storageFolder) ? rawStoragePath : "";
        checkedAnswers[question.id] = { imageUrl, storagePath, isCorrect: false, needsManualMarking: true };
      }
      if (isCorrect) score += 1;
    });
    return { score, maxScore: questions.length, checkedAnswers };
  };

  const isAttemptFullyMarked = (quiz, attempt) => {
    const manualQuestions = (quiz.questions || []).filter((question) => ["open", "image"].includes(question.type));
    if (!attempt?.submittedAt) return true;
    return manualQuestions.every((question) => {
      const answer = attempt.answers?.[question.id];
      return answer && answer.manualScore !== undefined && answer.manualScore !== null;
    });
  };

  const getQuizStatus = (quiz, now = Date.now()) => {
    if (!quiz) return "missing";
    if (quiz.status === "completed") return "completed";
    if (quiz.status === "draft") return "draft";
    if (quiz.status === "requested") return "requested";
    if (quiz.status === "assigned") return "assigned";
    const scheduledAt = quiz.scheduledAt ? new Date(quiz.scheduledAt).getTime() : 0;
    const endsAt = quiz.endsAt ? new Date(quiz.endsAt).getTime() : 0;
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
    const insufficient = {
      ok: false,
      status: 402,
      message: `At least ${attendCredit} credit is required.`,
    };
    if (credit < attendCredit) return insufficient;
    // conditional, so two attends racing on the same balance cannot both spend it
    const result = await activepackages.updateOne(
      { uid: studentId, credit: { $gte: attendCredit } },
      { $inc: { credit: -attendCredit } },
      { session }
    );
    if (!result?.modifiedCount) return insufficient;
    return { ok: true, remainingCredit: credit - attendCredit };
  };

  /**
   * Whether `attempt` may still be submitted. Rejects before the quiz opens,
   * once it is completed, and after its deadline (see getAttemptDeadline) plus
   * QUIZ_SUBMIT_GRACE_MS. The "ended" status alone is not a rejection: it flips
   * the instant endsAt passes, which is exactly what the grace exists to cover.
   */
  const checkSubmissionWindow = (quiz, attempt, now = Date.now()) => {
    const status = getQuizStatus(quiz, now);
    if (status === "completed")
      return { ok: false, status: 409, message: "This quiz is already completed." };
    if (!["open", "ended"].includes(status))
      return { ok: false, status: 409, message: "This quiz has not started yet." };
    const deadline = getAttemptDeadline(quiz, attempt);
    if (deadline && now > deadline + QUIZ_SUBMIT_GRACE_MS)
      return { ok: false, status: 409, message: "Time is up. This quiz no longer accepts answers." };
    return { ok: true, deadline };
  };

  const settleQuiz = async (quizId, session = null, options = {}) => {
    const quiz = await quizCollection.findOne({ _id: new ObjectId(quizId) }, { session });
    if (!quiz) return { ok: false, status: 404, message: "Quiz not found." };
    const economyEnabled =
      options.economyEnabled !== undefined
        ? options.economyEnabled !== false
        : quiz.quizExpenseEnabled !== false;
    if (quiz.status === "completed" || quiz.settledAt)
      return { ok: true, alreadySettled: true, quiz };

    const submittedAttempts = (quiz.attempts || []).filter((attempt) => attempt.submittedAt);
    const hasUnmarkedAttempts = submittedAttempts.some((attempt) => !isAttemptFullyMarked(quiz, attempt));
    if (hasUnmarkedAttempts) {
      return { ok: false, status: 409, message: "Teacher must finish marking open-ended and image answers first." };
    }
    const totalCollectedCredit = submittedAttempts.reduce(
      (sum, attempt) => sum + (Number(attempt.creditDeducted) || 0),
      0
    );
    const winnerCount = economyEnabled
      ? getWinnerCount
        ? getWinnerCount(submittedAttempts.length)
        : submittedAttempts.length > 5
        ? 3
        : submittedAttempts.length
        ? 1
        : 0
      : 0;
    const sortedAttempts = [...submittedAttempts].sort((a, b) => {
      if ((Number(b.score) || 0) !== (Number(a.score) || 0))
        return (Number(b.score) || 0) - (Number(a.score) || 0);
      return new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0);
    });
    const winners = sortedAttempts.slice(0, winnerCount);
    const rewardPool = economyEnabled ? Math.round(totalCollectedCredit * rewardPoolRate) : 0;
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

    const teacherBasePoints = economyEnabled ? Math.ceil(((quiz.questions || []).length || 0) / 2) : 0;
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

    await quizCollection.updateOne(
      { _id: quiz._id },
      {
        $set: {
          attempts,
          status: "completed",
          settledAt: new Date(),
          settlement: {
            totalCollectedCredit,
            rewardPool,
            rewardRate: economyEnabled ? rewardPoolRate : 0,
            winners: winnerRewards,
            teacherBasePoints,
            economyEnabled,
          },
        },
      },
      { session }
    );

    const settledQuiz = await quizCollection.findOne({ _id: quiz._id }, { session });
    return { ok: true, quiz: settledQuiz };
  };

  const applyQuizRating = async ({ quiz, studentId, rating, session = null, economyEnabled = undefined }) => {
    const normalizedRating = Math.min(Math.max(Number(rating) || 0, 1), 5);
    const attempt = getAttempt(quiz, studentId);
    if (!attempt?.submittedAt)
      return { ok: false, status: 403, message: "Submit this quiz before rating it." };
    if (attempt.rating)
      return { ok: false, status: 409, message: "You already rated this quiz." };

    const shouldApplyEconomy =
      economyEnabled !== undefined ? economyEnabled !== false : quiz.quizExpenseEnabled !== false;
    let pointDelta = 0;
    if (shouldApplyEconomy) {
      if (normalizedRating === 5) pointDelta = 1;
      else if (normalizedRating < 4) pointDelta = normalizedRating <= 2 ? -2 : -1;
    }

    if (pointDelta !== 0 && quiz.teacherId) {
      await userCollection.updateOne(
        { uid: quiz.teacherId },
        { $inc: { points: pointDelta } },
        { session }
      );
    }

    if (quiz.teacherId) {
      await recordRatingEvent({
        teacherId: quiz.teacherId,
        studentId,
        source: "quiz_rating",
        sourceId: quiz._id,
        dedupeKey: `quiz_rating:${quiz._id}:${studentId}`,
        rating: normalizedRating,
        metadata: {
          quizId: String(quiz._id),
          roomId: quiz.roomId || null,
          publicQuiz: !quiz.roomId,
          pointDelta,
        },
        session,
      });
      const teacher = await userCollection.findOne(
        { uid: quiz.teacherId },
        { projection: { points: 1 }, session }
      );
      await applyTeacherQualitySnapshot({
        teacherId: quiz.teacherId,
        basePoints: Number(teacher?.points) || 0,
        session,
      });
    }

    await quizCollection.updateOne(
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

  /**
   * The client-facing quiz. `viewerId` must be the verified caller (see
   * utils/actor.js): it decides whether correct answers, other students'
   * attempts and the questions themselves are included.
   *
   * Students only see question prompts/options once the quiz is open and - for
   * a paid quiz - they have attended (paid). They used to arrive with the quiz
   * list, so anyone could read a paid quiz before it started without paying.
   */
  const publicQuiz = (quiz, viewerId = null, { isOwner = false } = {}) => {
    if (!quiz) return null;
    const status = getQuizStatus(quiz);
    const attempt = viewerId ? getAttempt(quiz, viewerId) : null;
    const isQuizTeacher = Boolean(viewerId && viewerId === quiz.teacherId);
    const canShowAnswers = status === "completed" || isQuizTeacher || isOwner;
    const economyEnabled = quiz.quizExpenseEnabled !== false;
    const canSeeQuestions =
      canShowAnswers ||
      (["open", "ended"].includes(status) && (!economyEnabled || Boolean(attempt)));
    const questions = quiz.questions || [];
    // Only the teacher (and admin) see every student's answers; others get the
    // result table they need, with their own attempt in full via myAttempt.
    const visibleAttempts = isQuizTeacher || isOwner
      ? quiz.attempts || []
      : (quiz.attempts || []).map(({ answers, ...rest }) =>
          rest.studentId === viewerId ? { ...rest, answers } : rest
        );
    return {
      ...quiz,
      id: quiz._id.toString(),
      status,
      questionCount: questions.length,
      questionsHidden: !canSeeQuestions,
      questions: canSeeQuestions
        ? questions.map((question) => ({
            ...question,
            correctOption: canShowAnswers ? question.correctOption : undefined,
            answerText: canShowAnswers ? question.answerText : undefined,
          }))
        : [],
      myAttempt: attempt || null,
      attempts: canShowAnswers ? visibleAttempts : undefined,
      constants: {
        attendCredit: economyEnabled ? attendCredit : 0,
        rewardRate: economyEnabled ? rewardPoolRate : 0,
        maxQuestions,
        economyEnabled,
      },
    };
  };

  return {
    normalizeQuestion,
    validateQuestions,
    scoreAnswers,
    isAttemptFullyMarked,
    getQuizStatus,
    getAttempt,
    spendQuizCredit,
    checkSubmissionWindow,
    getAnswerStorageFolder,
    settleQuiz,
    applyQuizRating,
    publicQuiz,
  };
};

const getPublicQuizWinnerCount = (submittedCount) => {
  if (submittedCount <= 0) return 0;
  if (submittedCount <= 5) return 1;
  if (submittedCount <= PUBLIC_QUIZ_REWARD_STEP_SIZE) return 3;
  const step = Math.min(Math.floor(submittedCount / PUBLIC_QUIZ_REWARD_STEP_SIZE), 5);
  return Math.min(
    PUBLIC_QUIZ_REWARD_BASE_WINNERS + (step - 1) * PUBLIC_QUIZ_REWARD_WINNER_STEP,
    PUBLIC_QUIZ_REWARD_MAX_WINNERS,
    submittedCount
  );
};

const makePublicQuizHelpers = ({ userCollection, activepackages, publicQuizzes, databaseinmongo }) =>
  makeQuizHelpers({
    userCollection,
    activepackages,
    quizCollection: publicQuizzes,
    databaseinmongo,
    attendCredit: PUBLIC_QUIZ_ATTEND_CREDIT,
    rewardPoolRate: PUBLIC_QUIZ_REWARD_POOL_RATE,
    maxQuestions: PUBLIC_QUIZ_MAX_QUESTIONS,
    getWinnerCount: getPublicQuizWinnerCount,
  });

module.exports = {
  makeQuizHelpers,
  makePublicQuizHelpers,
  getPublicQuizWinnerCount,
  distributeRewards,
  getAttemptDeadline,
  getAnswerStorageFolder,
};
