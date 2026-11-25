const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || "https://files.example.com";
const BASE_URL = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/g, "");

const { makeQuizHelpers, makePublicQuizHelpers, getAttemptDeadline } = require("../utils/quizHelpers");
const { collectQuizStoragePaths } = require("../utils/r2Storage");
const { createDb } = require("./helpers/fakeMongo");
const { QUIZ_SUBMIT_GRACE_MS, ROOM_QUIZ_ATTEND_CREDIT } = require("../utils/constants");

const MINUTE = 60 * 1000;
const QUIZ_ID = new ObjectId();
const ROOM_ID = "room-1";
const TEACHER_ID = "teacher-1";

const questions = [
  { id: "q1", type: "mcq", prompt: "2 + 2?", options: ["1", "2", "3", "4"], correctOption: 3 },
  { id: "q2", type: "open", prompt: "Explain", answerText: "because" },
  { id: "q3", type: "image", prompt: "Draw it" },
];

const makeQuiz = (overrides = {}) => ({
  _id: QUIZ_ID,
  roomId: ROOM_ID,
  teacherId: TEACHER_ID,
  status: "scheduled",
  scheduledAt: new Date(Date.now() - 5 * MINUTE),
  endsAt: new Date(Date.now() + 15 * MINUTE),
  timeLimitMinutes: 20,
  questions,
  attempts: [],
  ...overrides,
});

const setup = (activePackages = []) => {
  const db = createDb({ activePackages, userCollection: [] });
  const helpers = makeQuizHelpers({
    userCollection: db.collection("userCollection"),
    activepackages: db.collection("activePackages"),
    roomQuizzes: db.collection("roomQuizzes"),
    databaseinmongo: db,
  });
  return { db, helpers };
};

// --- what a student can see -------------------------------------------------

test("a paid quiz shows no questions before it opens, even to a joined student", () => {
  const { helpers } = setup();
  const quiz = makeQuiz({
    scheduledAt: new Date(Date.now() + 60 * MINUTE),
    endsAt: new Date(Date.now() + 80 * MINUTE),
    attempts: [{ studentId: "s1", joinedAt: new Date() }],
  });
  const view = helpers.publicQuiz(quiz, "s1");
  assert.equal(view.status, "scheduled");
  assert.deepEqual(view.questions, []);
  assert.equal(view.questionsHidden, true);
  assert.equal(view.questionCount, 3);
});

test("an open paid quiz hides its questions until the student has attended", () => {
  const { helpers } = setup();
  const quiz = makeQuiz({ attempts: [{ studentId: "paid", joinedAt: new Date() }] });

  const stranger = helpers.publicQuiz(quiz, "not-paid");
  assert.equal(stranger.status, "open");
  assert.deepEqual(stranger.questions, []);

  const attendee = helpers.publicQuiz(quiz, "paid");
  assert.equal(attendee.questions.length, 3);
  assert.equal(attendee.questions[0].prompt, "2 + 2?");
  // never the answers while the quiz runs
  assert.equal(attendee.questions[0].correctOption, undefined);
  assert.equal(attendee.questions[1].answerText, undefined);
});

test("a free quiz shows its questions to everyone once open", () => {
  const { helpers } = setup();
  const view = helpers.publicQuiz(makeQuiz({ quizExpenseEnabled: false }), "anyone");
  assert.equal(view.questions.length, 3);
});

test("the quiz teacher sees questions and answers at any status", () => {
  const { helpers } = setup();
  const view = helpers.publicQuiz(makeQuiz({ status: "draft" }), TEACHER_ID);
  assert.equal(view.questions[0].correctOption, 3);
  assert.equal(view.questions[1].answerText, "because");
});

test("after completion a student sees other attempts without their answers", () => {
  const { helpers } = setup();
  const quiz = makeQuiz({
    status: "completed",
    attempts: [
      { studentId: "s1", score: 2, answers: { q2: { text: "mine" } } },
      { studentId: "s2", score: 1, answers: { q2: { text: "theirs" } } },
    ],
  });
  const view = helpers.publicQuiz(quiz, "s1");
  const own = view.attempts.find((item) => item.studentId === "s1");
  const other = view.attempts.find((item) => item.studentId === "s2");
  assert.equal(own.answers.q2.text, "mine");
  assert.equal(other.answers, undefined);
  assert.equal(other.score, 1);

  const teacherView = helpers.publicQuiz(quiz, TEACHER_ID);
  assert.equal(teacherView.attempts.find((item) => item.studentId === "s2").answers.q2.text, "theirs");
});

// --- late submissions -------------------------------------------------------

test("submissions are accepted until endsAt plus the grace period", () => {
  const { helpers } = setup();
  const endsAt = Date.now() - QUIZ_SUBMIT_GRACE_MS / 2;
  const quiz = makeQuiz({ scheduledAt: new Date(endsAt - 20 * MINUTE), endsAt: new Date(endsAt) });
  const attempt = { studentId: "s1", joinedAt: new Date(endsAt - 19 * MINUTE) };
  assert.equal(helpers.getQuizStatus(quiz), "ended");
  assert.equal(helpers.checkSubmissionWindow(quiz, attempt).ok, true);
});

test("submissions after the grace period are rejected", () => {
  const { helpers } = setup();
  const endsAt = Date.now() - QUIZ_SUBMIT_GRACE_MS - MINUTE;
  const quiz = makeQuiz({ scheduledAt: new Date(endsAt - 20 * MINUTE), endsAt: new Date(endsAt) });
  const result = helpers.checkSubmissionWindow(quiz, { studentId: "s1", joinedAt: new Date(endsAt - 19 * MINUTE) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test("a quiz cannot be submitted before it opens or after it is completed", () => {
  const { helpers } = setup();
  const future = makeQuiz({
    scheduledAt: new Date(Date.now() + 10 * MINUTE),
    endsAt: new Date(Date.now() + 30 * MINUTE),
  });
  assert.equal(helpers.checkSubmissionWindow(future, { studentId: "s1", joinedAt: new Date() }).ok, false);
  assert.equal(helpers.checkSubmissionWindow(makeQuiz({ status: "completed" }), { studentId: "s1" }).ok, false);
});

test("the time limit runs from the attempt, not just from the quiz end", () => {
  // the teacher moved the quiz later after this student had already started
  const joinedAt = Date.now() - 30 * MINUTE;
  const quiz = makeQuiz({
    scheduledAt: new Date(joinedAt - MINUTE),
    endsAt: new Date(Date.now() + 60 * MINUTE),
    timeLimitMinutes: 20,
  });
  assert.equal(getAttemptDeadline(quiz, { joinedAt: new Date(joinedAt) }), joinedAt + 20 * MINUTE);

  const { helpers } = setup();
  assert.equal(helpers.checkSubmissionWindow(quiz, { studentId: "s1", joinedAt: new Date(joinedAt) }).ok, false);
});

test("a student who joined early gets the full time limit from the start", () => {
  const scheduledAt = Date.now() - 5 * MINUTE;
  const quiz = makeQuiz({
    scheduledAt: new Date(scheduledAt),
    endsAt: new Date(scheduledAt + 20 * MINUTE),
    timeLimitMinutes: 20,
  });
  const deadline = getAttemptDeadline(quiz, { joinedAt: new Date(scheduledAt - 60 * MINUTE) });
  assert.equal(deadline, scheduledAt + 20 * MINUTE);
});

// --- image answers and storage ----------------------------------------------

test("an image answer outside the student's own quiz folder is dropped", () => {
  const { helpers } = setup();
  const folder = helpers.getAnswerStorageFolder(makeQuiz(), "s1");
  assert.equal(folder, `rooms/${ROOM_ID}/quizzes/${QUIZ_ID}/answers/s1`);

  const ownPath = `${folder}/q3-1-photo.png`;
  const good = helpers.scoreAnswers(questions, {
    q3: { imageUrl: `${BASE_URL}/${ownPath}`, storagePath: ownPath },
  }, { storageFolder: folder });
  assert.equal(good.checkedAnswers.q3.storagePath, ownPath);
  assert.equal(good.checkedAnswers.q3.imageUrl, `${BASE_URL}/${ownPath}`);

  const foreignPath = "chats/someone-else/secret.png";
  const bad = helpers.scoreAnswers(questions, {
    q3: { imageUrl: `${BASE_URL}/${foreignPath}`, storagePath: foreignPath },
  }, { storageFolder: folder });
  assert.equal(bad.checkedAnswers.q3.storagePath, "");
  assert.equal(bad.checkedAnswers.q3.imageUrl, "");

  const traversal = helpers.scoreAnswers(questions, {
    q3: { storagePath: `${folder}/../../../../../chats/x.png`, imageUrl: "https://evil.example/x.png" },
  }, { storageFolder: folder });
  assert.equal(traversal.checkedAnswers.q3.storagePath, "");
  assert.equal(traversal.checkedAnswers.q3.imageUrl, "");
});

test("public quiz answers belong under public-quizzes/<quizId>/answers/<uid>", () => {
  const db = createDb({});
  const publicHelpers = makePublicQuizHelpers({
    userCollection: db.collection("userCollection"),
    activepackages: db.collection("activePackages"),
    publicQuizzes: db.collection("publicQuizzes"),
    databaseinmongo: db,
  });
  const quiz = makeQuiz({ roomId: undefined });
  assert.equal(publicHelpers.getAnswerStorageFolder(quiz, "s1"), `public-quizzes/${QUIZ_ID}/answers/s1`);
});

test("deleting a quiz only collects files inside that quiz's folder", () => {
  const folder = `rooms/${ROOM_ID}/quizzes/${QUIZ_ID}`;
  const quiz = makeQuiz({
    attempts: [
      { studentId: "s1", answers: { q3: { storagePath: `${folder}/answers/s1/a.png` } } },
      // stored before answers were validated
      { studentId: "s2", answers: { q3: { storagePath: "chats/abc/victim.png", imageUrl: `${BASE_URL}/rooms/other/x.png` } } },
    ],
  });
  assert.deepEqual(collectQuizStoragePaths(quiz), [`${folder}/answers/s1/a.png`]);
});

// --- paying to attend -------------------------------------------------------

test("attend credit is spent with a conditional decrement", async () => {
  const { db, helpers } = setup([
    { uid: "s1", credit: ROOM_QUIZ_ATTEND_CREDIT + 5, isActive: true, expiryDate: new Date(Date.now() + 86400000).toISOString() },
  ]);
  const first = await helpers.spendQuizCredit("s1");
  assert.equal(first.ok, true);
  assert.equal(first.remainingCredit, 5);

  const second = await helpers.spendQuizCredit("s1");
  assert.equal(second.ok, false);
  assert.equal(second.status, 402);
  assert.equal(db.collection("activePackages")._all()[0].credit, 5);
});
