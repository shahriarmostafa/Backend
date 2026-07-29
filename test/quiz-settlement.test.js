const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const { makeQuizHelpers, getPublicQuizWinnerCount } = require("../utils/quizHelpers");
const { createDb } = require("./helpers/fakeMongo");
const { ROOM_QUIZ_REWARD_POOL_RATE, ROOM_QUIZ_ATTEND_CREDIT } = require("../utils/constants");

const QUIZ_ID = new ObjectId();
const TEACHER_ID = "teacher-1";

const mcq = (id) => ({ id, type: "mcq", question: `q${id}`, options: ["a", "b"], correctOption: 0 });

const attempt = (studentId, score, overrides = {}) => ({
  studentId,
  score,
  submittedAt: new Date("2026-07-01T10:00:00Z"),
  creditDeducted: ROOM_QUIZ_ATTEND_CREDIT,
  answers: {},
  ...overrides,
});

const setup = ({ attempts = [], questions = [mcq("1"), mcq("2")], quiz = {} } = {}) => {
  const db = createDb({
    roomQuizzes: [
      {
        _id: QUIZ_ID,
        teacherId: TEACHER_ID,
        status: "open",
        questions,
        attempts,
        ...quiz,
      },
    ],
    activePackages: attempts.map((item) => ({ uid: item.studentId, credit: 0 })),
    userCollection: [{ uid: TEACHER_ID, role: "teacher", points: 0 }],
  });

  const helpers = makeQuizHelpers({
    userCollection: db.collection("userCollection"),
    activepackages: db.collection("activePackages"),
    roomQuizzes: db.collection("roomQuizzes"),
    databaseinmongo: db,
    getWinnerCount: getPublicQuizWinnerCount,
  });

  return { db, helpers };
};

const creditOf = (db, uid) =>
  db.collection("activePackages")._all().find((item) => item.uid === uid)?.credit ?? 0;

test("settling pays every winner and records the settlement", async () => {
  const attempts = [attempt("s1", 10), attempt("s2", 8), attempt("s3", 6)];
  const { db, helpers } = setup({ attempts });

  const result = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(result.ok, true);

  const settlement = result.quiz.settlement;
  const collected = 3 * ROOM_QUIZ_ATTEND_CREDIT;
  assert.equal(settlement.totalCollectedCredit, collected);
  assert.equal(settlement.rewardPool, Math.round(collected * ROOM_QUIZ_REWARD_POOL_RATE));
  assert.equal(result.quiz.status, "completed");
});

test("the reward pool never exceeds what students paid in", async () => {
  const attempts = [attempt("s1", 10), attempt("s2", 8), attempt("s3", 6), attempt("s4", 4)];
  const { helpers } = setup({ attempts });
  const { quiz } = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.ok(
    quiz.settlement.rewardPool < quiz.settlement.totalCollectedCredit,
    "the platform must retain a share"
  );
});

test("credit paid to winners equals the reward pool exactly", async () => {
  const attempts = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((id, i) => attempt(id, 10 - i));
  const { db, helpers } = setup({ attempts });
  const { quiz } = await helpers.settleQuiz(QUIZ_ID.toString());

  const paidOut = attempts.reduce((total, item) => total + creditOf(db, item.studentId), 0);
  assert.equal(paidOut, quiz.settlement.rewardPool, "credit was invented or lost in settlement");
});

test("winners are ranked by score, ties broken by who submitted first", async () => {
  // six submissions so the ladder awards three places to compare
  const attempts = [
    attempt("slow", 10, { submittedAt: new Date("2026-07-01T12:00:00Z") }),
    attempt("fast", 10, { submittedAt: new Date("2026-07-01T09:00:00Z") }),
    attempt("third", 7),
    attempt("d", 5),
    attempt("e", 3),
    attempt("f", 1),
  ];
  const { helpers } = setup({ attempts });
  const { quiz } = await helpers.settleQuiz(QUIZ_ID.toString());

  const [first, second, third] = quiz.settlement.winners;
  assert.equal(quiz.settlement.winners.length, 3);
  assert.equal(first.studentId, "fast", "the earlier submission should win the tie");
  assert.equal(second.studentId, "slow");
  assert.equal(third.studentId, "third");
  assert.ok(first.rewardCredit >= second.rewardCredit, "first place should not earn less");
  assert.deepEqual([first.position, second.position, third.position], [1, 2, 3]);
});

test("a losing student receives no reward", async () => {
  const attempts = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((id, i) => attempt(id, 10 - i));
  const { db, helpers } = setup({ attempts });
  const { quiz } = await helpers.settleQuiz(QUIZ_ID.toString());

  const winnerIds = quiz.settlement.winners.map((item) => item.studentId);
  const loser = attempts.map((item) => item.studentId).find((id) => !winnerIds.includes(id));
  assert.ok(loser, "expected at least one non-winner");
  assert.equal(creditOf(db, loser), 0);
});

/**
 * Settlement is triggered from both an admin route and a room route, so it has
 * to be safe to run twice. A second run must not pay anyone again.
 */
test("settling an already settled quiz is a no-op", async () => {
  const attempts = [attempt("s1", 10), attempt("s2", 5)];
  const { db, helpers } = setup({ attempts });

  await helpers.settleQuiz(QUIZ_ID.toString());
  const creditAfterFirst = creditOf(db, "s1");

  const second = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(second.alreadySettled, true);
  assert.equal(creditOf(db, "s1"), creditAfterFirst, "a second settlement paid out again");
});

test("a quiz already marked completed is never re-settled", async () => {
  const { db, helpers } = setup({
    attempts: [attempt("s1", 10)],
    quiz: { status: "completed" },
  });
  const result = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(result.alreadySettled, true);
  assert.equal(creditOf(db, "s1"), 0);
});

test("settlement is blocked while open answers are unmarked", async () => {
  const { db, helpers } = setup({
    questions: [mcq("1"), { id: "2", type: "open", question: "explain" }],
    attempts: [attempt("s1", 5, { answers: { 2: { text: "an answer" } } })],
  });

  const result = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(creditOf(db, "s1"), 0, "nothing may be paid before marking is finished");
});

test("settlement proceeds once open answers carry a manual score", async () => {
  const { helpers } = setup({
    questions: [mcq("1"), { id: "2", type: "open", question: "explain" }],
    attempts: [attempt("s1", 5, { answers: { 2: { text: "an answer", manualScore: 1 } } })],
  });
  const result = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(result.ok, true);
});

test("a manual score of zero still counts as marked", async () => {
  const { helpers } = setup({
    questions: [{ id: "1", type: "open", question: "explain" }],
    attempts: [attempt("s1", 0, { answers: { 1: { text: "wrong", manualScore: 0 } } })],
  });
  const result = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(result.ok, true, "a zero mark must not be mistaken for unmarked");
});

/**
 * quizExpenseEnabled false means the quiz is free: no student rewards and no
 * teacher points, per the room rules in AGENTS.md.
 */
test("a free quiz pays no rewards and no teacher points", async () => {
  const attempts = [attempt("s1", 10, { creditDeducted: 0 }), attempt("s2", 5, { creditDeducted: 0 })];
  const { db, helpers } = setup({ attempts, quiz: { quizExpenseEnabled: false } });

  const { quiz } = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(quiz.settlement.rewardPool, 0);
  assert.equal(quiz.settlement.winners.length, 0);
  assert.equal(quiz.settlement.teacherBasePoints, 0);
  assert.equal(creditOf(db, "s1"), 0);

  const teacher = db.collection("userCollection")._all().find((u) => u.uid === TEACHER_ID);
  assert.equal(teacher.points, 0, "a free quiz must not award teacher points");
});

test("a paid quiz awards the teacher points for their questions", async () => {
  const { db, helpers } = setup({
    questions: [mcq("1"), mcq("2"), mcq("3"), mcq("4")],
    attempts: [attempt("s1", 4)],
  });
  await helpers.settleQuiz(QUIZ_ID.toString());
  const teacher = db.collection("userCollection")._all().find((u) => u.uid === TEACHER_ID);
  assert.equal(teacher.points, 2, "four questions should be worth two points");
});

test("a quiz nobody submitted settles cleanly with no payouts", async () => {
  const { helpers } = setup({ attempts: [] });
  const { ok, quiz } = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(ok, true);
  assert.equal(quiz.settlement.rewardPool, 0);
  assert.equal(quiz.settlement.winners.length, 0);
});

test("attempts that were never submitted are excluded from the pool", async () => {
  const attempts = [
    attempt("submitted", 10),
    { studentId: "abandoned", score: 0, submittedAt: null, creditDeducted: ROOM_QUIZ_ATTEND_CREDIT, answers: {} },
  ];
  const { helpers } = setup({ attempts });
  const { quiz } = await helpers.settleQuiz(QUIZ_ID.toString());
  assert.equal(quiz.settlement.totalCollectedCredit, ROOM_QUIZ_ATTEND_CREDIT);
});

test("a missing quiz reports not found rather than throwing", async () => {
  const { helpers } = setup({});
  const result = await helpers.settleQuiz(new ObjectId().toString());
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});
