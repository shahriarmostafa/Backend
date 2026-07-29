const test = require("node:test");
const assert = require("node:assert/strict");

const { makeTeacherQualityHelpers, getMonthKey } = require("../utils/teacherQualityHelpers");
const { createDb } = require("./helpers/fakeMongo");
const {
  TEACHER_QUALITY_SOURCE_CAPS,
  TEACHER_QUALITY_MAX_BONUS_RATE,
  TEACHER_QUALITY_MAX_PENALTY_RATE,
  TEACHER_QUALITY_REACTION_DELTAS,
} = require("../utils/constants");

const setup = () => {
  const db = createDb({ teacherQualityEvents: [] });
  const helpers = makeTeacherQualityHelpers({ databaseinmongo: db, userCollection: db.collection("userCollection") });
  return { db, helpers, events: db.collection("teacherQualityEvents") };
};

const reaction = (overrides = {}) => ({
  teacherId: "teacher-1",
  studentId: "student-1",
  source: "chat_reaction",
  sourceId: "chat-1:0",
  dedupeKey: "chat_reaction:chat-1:0:student-1",
  reaction: "helpful",
  isLike: true,
  ...overrides,
});

/**
 * The regression that broke chat reactions, call reviews, quiz ratings and
 * first-reply-speed for months: `updatedAt` sat in both $setOnInsert and $set,
 * which Mongo rejects outright. Every quality event threw, and three of the
 * four callers swallowed it inside a try/catch.
 */
test("recording an event does not put one path under two update operators", async () => {
  const { helpers } = setup();
  const result = await helpers.recordReactionEvent(reaction());
  assert.equal(result.ok, true);
  assert.equal(result.inserted, true);
});

test("a recorded reaction stores the configured delta", async () => {
  const { helpers, events } = setup();
  await helpers.recordReactionEvent(reaction({ reaction: "helpful" }));
  const stored = await events.findOne({ teacherId: "teacher-1" });
  assert.equal(stored.delta, TEACHER_QUALITY_REACTION_DELTAS.helpful);
  assert.equal(stored.monthKey, getMonthKey());
});

test("the same reaction recorded twice only counts once", async () => {
  const { helpers, events } = setup();
  const first = await helpers.recordReactionEvent(reaction());
  const second = await helpers.recordReactionEvent(reaction());

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false, "a repeat must not insert a second event");
  assert.equal(events._all().length, 1);
});

test("different students reacting to the same message both count", async () => {
  const { helpers, events } = setup();
  await helpers.recordReactionEvent(reaction({ studentId: "student-1" }));
  await helpers.recordReactionEvent(
    reaction({ studentId: "student-2", dedupeKey: "chat_reaction:chat-1:0:student-2" })
  );
  assert.equal(events._all().length, 2);
});

test("a negative reaction records a negative delta", async () => {
  const { helpers, events } = setup();
  await helpers.recordReactionEvent(reaction({ reaction: "confusing", isLike: false }));
  const stored = await events.findOne({ teacherId: "teacher-1" });
  assert.ok(stored.delta < 0, `expected a penalty, got ${stored.delta}`);
});

test("a source stops accruing once its monthly cap is reached", async () => {
  const { helpers } = setup();
  const cap = TEACHER_QUALITY_SOURCE_CAPS.chat_reaction;

  let capped = false;
  for (let i = 0; i < 200 && !capped; i += 1) {
    const result = await helpers.recordReactionEvent(
      reaction({ sourceId: `chat-1:${i}`, dedupeKey: `chat_reaction:chat-1:${i}:student-1` })
    );
    if (result.capped) capped = true;
  }
  assert.ok(capped, `chat reactions never hit the cap of ${cap}`);
});

/**
 * The cap is checked before an event is written but the delta is not trimmed to
 * fit, so the total can overshoot by up to one event. Pinned as current
 * behaviour - trimming would be the alternative.
 */
test("the cap may be overshot by at most a single event", async () => {
  const { helpers, events } = setup();
  const cap = TEACHER_QUALITY_SOURCE_CAPS.chat_reaction;
  const largestDelta = Math.max(...Object.values(TEACHER_QUALITY_REACTION_DELTAS));

  for (let i = 0; i < 200; i += 1) {
    await helpers.recordReactionEvent(
      reaction({ sourceId: `chat-1:${i}`, dedupeKey: `chat_reaction:chat-1:${i}:student-1` })
    );
  }
  const total = events._all().reduce((sum, item) => sum + item.delta, 0);
  assert.ok(total <= cap + largestDelta, `total ${total} overshot cap ${cap} by more than one event`);
});

test("quality bonus is clamped to its share of base points", async () => {
  const { helpers, events } = setup();
  for (let i = 0; i < 50; i += 1) {
    await events.insertOne({
      teacherId: "teacher-1",
      studentId: `student-${i}`,
      source: "call_review",
      monthKey: getMonthKey(),
      delta: 1,
    });
  }
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "teacher-1", basePoints: 100 });
  assert.ok(
    summary.qualityAdjustmentPoints <= 100 * TEACHER_QUALITY_MAX_BONUS_RATE + 1e-9,
    `bonus ${summary.qualityAdjustmentPoints} exceeded the cap`
  );
});

test("quality penalty is clamped to its share of base points", async () => {
  const { helpers, events } = setup();
  for (let i = 0; i < 50; i += 1) {
    await events.insertOne({
      teacherId: "teacher-1",
      studentId: `student-${i}`,
      source: "call_review",
      monthKey: getMonthKey(),
      delta: -1.5,
    });
  }
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "teacher-1", basePoints: 100 });
  assert.ok(
    summary.qualityAdjustmentPoints >= -100 * TEACHER_QUALITY_MAX_PENALTY_RATE - 1e-9,
    `penalty ${summary.qualityAdjustmentPoints} exceeded the cap`
  );
});

test("a teacher with no points cannot earn a quality bonus", async () => {
  const { helpers, events } = setup();
  await events.insertOne({
    teacherId: "teacher-1",
    source: "call_review",
    monthKey: getMonthKey(),
    delta: 5,
  });
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "teacher-1", basePoints: 0 });
  assert.equal(summary.qualityAdjustmentPoints, 0);
});

test("negative base points do not invert the clamp", async () => {
  const { helpers, events } = setup();
  await events.insertOne({
    teacherId: "teacher-1",
    source: "call_review",
    monthKey: getMonthKey(),
    delta: 5,
  });
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "teacher-1", basePoints: -500 });
  assert.ok(Number.isFinite(summary.qualityAdjustmentPoints));
  assert.equal(summary.qualityAdjustmentPoints, 0);
});

test("a teacher with no events has no adjustment", async () => {
  const { helpers } = setup();
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "nobody", basePoints: 500 });
  assert.equal(summary.rawQualityPoints, 0);
  assert.equal(summary.qualityAdjustmentPoints, 0);
  assert.equal(summary.eventCount, 0);
});

test("events from other teachers never leak into a summary", async () => {
  const { helpers, events } = setup();
  await events.insertOne({
    teacherId: "someone-else",
    source: "call_review",
    monthKey: getMonthKey(),
    delta: 5,
  });
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "teacher-1", basePoints: 500 });
  assert.equal(summary.eventCount, 0);
});

test("events from a different month never leak into a summary", async () => {
  const { helpers, events } = setup();
  await events.insertOne({
    teacherId: "teacher-1",
    source: "call_review",
    monthKey: "1999-01",
    delta: 5,
  });
  const summary = await helpers.getTeacherQualitySummary({ teacherId: "teacher-1", basePoints: 500 });
  assert.equal(summary.eventCount, 0);
});

test("missing required fields are rejected rather than written", async () => {
  const { helpers, events } = setup();
  const result = await helpers.recordReactionEvent(reaction({ teacherId: null }));
  assert.equal(result.ok, false);
  assert.equal(events._all().length, 0);
});
