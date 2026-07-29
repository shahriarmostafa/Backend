const test = require("node:test");
const assert = require("node:assert/strict");

const { getPublicQuizWinnerCount } = require("../utils/quizHelpers");
const {
  PUBLIC_QUIZ_REWARD_MAX_WINNERS,
  PUBLIC_QUIZ_REWARD_BASE_WINNERS,
} = require("../utils/constants");

test("no submissions means no winners", () => {
  assert.equal(getPublicQuizWinnerCount(0), 0);
  assert.equal(getPublicQuizWinnerCount(-5), 0);
});

test("tiny quizzes reward a single winner", () => {
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(getPublicQuizWinnerCount(n), 1, `${n} submissions`);
  }
});

test("small quizzes reward three winners up to the step size", () => {
  for (const n of [6, 20, 49, 50]) {
    assert.equal(getPublicQuizWinnerCount(n), 3, `${n} submissions`);
  }
});

/**
 * These are the tiers as implemented. They do NOT match the prose in
 * AGENTS.md ("above 100 use 15, above 150 use 20, above 200 use 25,
 * up to/above 300 use 30") in two ways:
 *
 *   1. Boundaries are inclusive: exactly 100 already gets 15, not 10.
 *   2. The 25-winner tier only covers 201-249. From 250 onwards the count
 *      jumps straight to 30, because `step` is capped at 5 and
 *      floor(250 / 50) already reaches that cap.
 *
 * Locked to current behaviour deliberately: students have already been paid
 * under these tiers, so the documentation was corrected instead. Change this
 * test first if the tiers should be reshaped.
 */
test("large quiz tiers match the implemented ladder", () => {
  const expected = [
    [51, 10], [99, 10],
    [100, 15], [149, 15],
    [150, 20], [199, 20],
    [200, 25], [249, 25],
    [250, 30], [299, 30], [300, 30], [1000, 30],
  ];
  for (const [submitted, winners] of expected) {
    assert.equal(getPublicQuizWinnerCount(submitted), winners, `${submitted} submissions`);
  }
});

test("winner count never exceeds the configured maximum", () => {
  for (let n = 1; n <= 2000; n += 7) {
    assert.ok(
      getPublicQuizWinnerCount(n) <= PUBLIC_QUIZ_REWARD_MAX_WINNERS,
      `${n} submissions exceeded the cap`
    );
  }
});

test("winner count never exceeds the number of people who submitted", () => {
  // otherwise settlement would try to pay more winners than there are students
  for (let n = 1; n <= 400; n += 1) {
    assert.ok(
      getPublicQuizWinnerCount(n) <= n,
      `${n} submissions produced ${getPublicQuizWinnerCount(n)} winners`
    );
  }
});

test("winner count never decreases as more students submit", () => {
  let previous = 0;
  for (let n = 0; n <= 1000; n += 1) {
    const current = getPublicQuizWinnerCount(n);
    assert.ok(current >= previous, `dropped from ${previous} to ${current} at ${n}`);
    previous = current;
  }
});

test("the base winner tier is honoured at the first large step", () => {
  assert.equal(getPublicQuizWinnerCount(51), PUBLIC_QUIZ_REWARD_BASE_WINNERS);
});
