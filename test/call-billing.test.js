const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getGeneralCallPoints,
  getRoomCallCreditRate,
  getCallCreditForSeconds,
  clampCreditRate,
} = require("../utils/moneyHelpers");
const { STUDY_ROOM_TEACHER_CREDIT_RATE } = require("../utils/constants");

test("calls shorter than 40 seconds earn a teacher nothing", () => {
  // otherwise a teacher could farm points by dialling and hanging up
  for (const seconds of [0, 1, 20, 39]) {
    assert.equal(getGeneralCallPoints(seconds), 0, `${seconds}s`);
  }
});

test("call point bands step up at the documented boundaries", () => {
  const bands = [
    [40, 3], [179, 3],
    [180, 5], [299, 5],
    [300, 8], [599, 8],
    [600, 12], [899, 12],
    [900, 16], [1199, 16],
    [1200, 22], [1799, 22],
    [1800, 28], [7200, 28],
  ];
  for (const [seconds, points] of bands) {
    assert.equal(getGeneralCallPoints(seconds), points, `${seconds}s`);
  }
});

test("call points never decrease as a call runs longer", () => {
  let previous = 0;
  for (let seconds = 0; seconds <= 4000; seconds += 1) {
    const points = getGeneralCallPoints(seconds);
    assert.ok(points >= previous, `dropped from ${previous} to ${points} at ${seconds}s`);
    previous = points;
  }
});

test("call points are capped for very long calls", () => {
  assert.equal(getGeneralCallPoints(86400), 28);
});

test("a solo student in a room pays the full rate", () => {
  assert.equal(getRoomCallCreditRate(1), 1);
  assert.equal(getRoomCallCreditRate(0), 1);
});

test("a group room call is discounted", () => {
  assert.equal(getRoomCallCreditRate(2), STUDY_ROOM_TEACHER_CREDIT_RATE);
  assert.equal(getRoomCallCreditRate(9), STUDY_ROOM_TEACHER_CREDIT_RATE);
  assert.ok(getRoomCallCreditRate(2) < getRoomCallCreditRate(1), "a group should never cost more");
});

test("credit is charged at one per ten seconds", () => {
  assert.equal(getCallCreditForSeconds(100, 1), 10);
  assert.equal(getCallCreditForSeconds(600, 1), 60);
});

test("part-used ten second blocks are not charged", () => {
  // 109 seconds is ten whole blocks, the trailing 9 seconds are free
  assert.equal(getCallCreditForSeconds(109, 1), 10);
  assert.equal(getCallCreditForSeconds(9, 1), 0);
});

test("a call too short to bill costs nothing", () => {
  for (const seconds of [0, 1, 9]) {
    assert.equal(getCallCreditForSeconds(seconds, 1), 0, `${seconds}s`);
  }
});

test("the discounted rate rounds up so the platform never undercharges", () => {
  // 100s at 0.7 is 7 credits exactly; 110s at 0.7 is 7.7, charged as 8
  assert.equal(getCallCreditForSeconds(100, 0.7), 7);
  assert.equal(getCallCreditForSeconds(110, 0.7), 8);
});

test("a discounted call never costs more than the full rate", () => {
  for (let seconds = 0; seconds <= 3600; seconds += 7) {
    const full = getCallCreditForSeconds(seconds, 1);
    const discounted = getCallCreditForSeconds(seconds, STUDY_ROOM_TEACHER_CREDIT_RATE);
    assert.ok(discounted <= full, `${seconds}s: discounted ${discounted} > full ${full}`);
  }
});

test("credit charged is never negative", () => {
  for (const seconds of [-500, -1, 0, 50]) {
    assert.ok(getCallCreditForSeconds(seconds, 1) >= 0, `${seconds}s`);
  }
});

test("a garbage duration is billed as zero rather than NaN", () => {
  for (const value of [undefined, null, "abc", NaN, {}]) {
    const credit = getCallCreditForSeconds(value, 1);
    assert.ok(Number.isFinite(credit), `${String(value)} produced ${credit}`);
    assert.equal(credit, 0);
  }
});

test("a rate of zero bills nothing", () => {
  assert.equal(getCallCreditForSeconds(3600, 0), 0);
});

test("credit rate is clamped to the billable range", () => {
  assert.equal(clampCreditRate(5), 1, "a rate above 1 must not overcharge");
  assert.equal(clampCreditRate(0.05), 0.1, "a rate below the floor must not undercharge");
  assert.equal(clampCreditRate(0.5), 0.5);
});

test("a missing or unparseable credit rate falls back to full rate", () => {
  for (const value of [undefined, null, 0, "abc", NaN]) {
    assert.equal(clampCreditRate(value), 1, String(value));
  }
});

test("a negative credit rate cannot refund a student", () => {
  assert.equal(clampCreditRate(-3), 0.1);
  assert.ok(getCallCreditForSeconds(600, clampCreditRate(-3)) >= 0);
});

test("a realistic group room call bills every student the same", () => {
  const seconds = 1800;
  const rate = getRoomCallCreditRate(4);
  const perStudent = getCallCreditForSeconds(seconds, rate);
  assert.equal(perStudent, getCallCreditForSeconds(seconds, rate));
  assert.ok(perStudent > 0);
  assert.ok(
    perStudent < getCallCreditForSeconds(seconds, 1),
    "the group discount should have applied"
  );
});

test("a student who joins late is billed only for their own time", () => {
  // billing is driven by each session's own seconds, so a student present for
  // half the call pays roughly half
  const teacherSeconds = 1200;
  const lateStudentSeconds = 600;
  const rate = getRoomCallCreditRate(2);
  assert.ok(
    getCallCreditForSeconds(lateStudentSeconds, rate) <
      getCallCreditForSeconds(teacherSeconds, rate),
    "a late joiner must not be charged for the whole call"
  );
});
