const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMonthKey,
  getRatingDelta,
  getReactionDelta,
  getReplySpeedDelta,
} = require("../utils/teacherQualityHelpers");
const {
  TEACHER_QUALITY_REACTION_DELTAS,
  TEACHER_QUALITY_REPLY_FAST_MINUTES,
  TEACHER_QUALITY_REPLY_OK_MINUTES,
  TEACHER_QUALITY_REPLY_LATE_MINUTES,
} = require("../utils/constants");

test("each configured reaction maps to its delta", () => {
  for (const [reaction, delta] of Object.entries(TEACHER_QUALITY_REACTION_DELTAS)) {
    assert.equal(getReactionDelta(reaction), delta, reaction);
  }
});

test("positive reactions help and negative ones hurt", () => {
  for (const key of ["helpful", "clear", "thanks", "liked"]) {
    assert.ok(getReactionDelta(key) > 0, `${key} should be positive`);
  }
  for (const key of ["disliked", "confusing"]) {
    assert.ok(getReactionDelta(key) < 0, `${key} should be negative`);
  }
});

test("reaction lookup is case insensitive", () => {
  assert.equal(getReactionDelta("HELPFUL"), TEACHER_QUALITY_REACTION_DELTAS.helpful);
});

test("an unknown reaction is worth nothing rather than NaN", () => {
  // a NaN delta would poison the whole monthly quality sum
  for (const value of ["banana", "", null, undefined, 42, {}]) {
    const delta = getReactionDelta(value);
    assert.ok(Number.isFinite(delta), `${String(value)} produced ${delta}`);
    assert.equal(delta, 0);
  }
});

test("isLike falls back to liked/disliked when no reaction is named", () => {
  assert.equal(getReactionDelta(null, true), TEACHER_QUALITY_REACTION_DELTAS.liked);
  assert.equal(getReactionDelta(null, false), TEACHER_QUALITY_REACTION_DELTAS.disliked);
  assert.equal(getReactionDelta(null, null), 0);
});

test("star ratings map monotonically", () => {
  const deltas = [1, 2, 3, 4, 5].map(getRatingDelta);
  for (let i = 1; i < deltas.length; i += 1) {
    assert.ok(deltas[i] >= deltas[i - 1], `rating ${i + 1} was worth less than ${i}`);
  }
  assert.ok(getRatingDelta(5) > 0);
  assert.ok(getRatingDelta(1) < 0);
  assert.equal(getRatingDelta(3), 0, "three stars should be neutral");
});

test("out of range ratings clamp instead of extrapolating", () => {
  assert.equal(getRatingDelta(9), getRatingDelta(5));
  assert.equal(getRatingDelta(-4), getRatingDelta(1));
  assert.ok(Number.isFinite(getRatingDelta("nonsense")));
});

test("reply speed is rewarded in bands", () => {
  assert.equal(getReplySpeedDelta(0), 1);
  assert.equal(getReplySpeedDelta(TEACHER_QUALITY_REPLY_FAST_MINUTES), 1);
  assert.equal(getReplySpeedDelta(TEACHER_QUALITY_REPLY_FAST_MINUTES + 1), 0.45);
  assert.equal(getReplySpeedDelta(TEACHER_QUALITY_REPLY_OK_MINUTES), 0.45);
  assert.equal(getReplySpeedDelta(TEACHER_QUALITY_REPLY_OK_MINUTES + 1), 0);
  assert.equal(getReplySpeedDelta(TEACHER_QUALITY_REPLY_LATE_MINUTES), 0);
  assert.equal(getReplySpeedDelta(TEACHER_QUALITY_REPLY_LATE_MINUTES + 1), -1);
});

test("a negative reply time is treated as instant, not as a penalty", () => {
  // clock skew between client and server should never punish a teacher
  assert.equal(getReplySpeedDelta(-30), 1);
});

test("month keys are zero padded and sort chronologically", () => {
  assert.equal(getMonthKey(new Date("2026-01-15T12:00:00Z")), "2026-01");
  assert.equal(getMonthKey(new Date("2026-12-15T12:00:00Z")), "2026-12");
  const keys = ["2026-09", "2026-10", "2026-11"];
  assert.deepEqual([...keys].sort(), keys);
});

/**
 * Monthly caps bucket by UTC, but the platform's students are in UTC+6. An
 * event just after local midnight therefore counts against the PREVIOUS
 * month's cap. Pinned so the behaviour is a decision rather than a surprise.
 */
test("month bucketing is UTC, not local time", () => {
  const justAfterLocalMidnight = new Date("2026-08-01T02:00:00+06:00");
  assert.equal(getMonthKey(justAfterLocalMidnight), "2026-07");

  const justBeforeLocalMidnight = new Date("2026-07-31T23:00:00+06:00");
  assert.equal(getMonthKey(justBeforeLocalMidnight), "2026-07");
});

test("month key accepts a parseable string as well as a Date", () => {
  assert.equal(getMonthKey("2026-03-09T00:00:00Z"), "2026-03");
});
