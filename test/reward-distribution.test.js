const test = require("node:test");
const assert = require("node:assert/strict");

const { distributeRewards, getPublicQuizWinnerCount } = require("../utils/quizHelpers");
const { ROOM_QUIZ_REWARD_POOL_RATE, ROOM_QUIZ_ATTEND_CREDIT } = require("../utils/constants");

const sum = (values) => values.reduce((total, value) => total + value, 0);

test("nothing to share means nothing is paid out", () => {
  assert.deepEqual(distributeRewards(0, 5), []);
  assert.deepEqual(distributeRewards(-100, 5), []);
  assert.deepEqual(distributeRewards(1000, 0), []);
  assert.deepEqual(distributeRewards(1000, -3), []);
});

test("a single winner takes the whole pool", () => {
  assert.deepEqual(distributeRewards(1000, 1), [1000]);
  assert.deepEqual(distributeRewards(333.4, 1), [333]);
});

test("three winners split the pool 3:2:1", () => {
  assert.deepEqual(distributeRewards(600, 3), [300, 200, 100]);
});

test("any other winner count splits evenly", () => {
  assert.deepEqual(distributeRewards(400, 4), [100, 100, 100, 100]);
  assert.deepEqual(distributeRewards(1000, 10), Array(10).fill(100));
});

/**
 * The property that actually matters: settlement must never invent credit or
 * quietly lose it to floor-rounding. Every payout array has to add back up to
 * the pool exactly.
 */
test("payouts always sum to the pool, across every shape", () => {
  for (let winners = 1; winners <= 30; winners += 1) {
    for (const pool of [1, 2, 7, 13, 99, 100, 101, 333, 1000, 4567, 99999]) {
      const rewards = distributeRewards(pool, winners);
      assert.equal(
        sum(rewards),
        Math.round(pool),
        `pool ${pool} across ${winners} winners paid out ${sum(rewards)}`
      );
    }
  }
});

test("fractional pools are settled in whole credits", () => {
  for (const pool of [100.5, 33.33, 1.99, 250.7]) {
    const rewards = distributeRewards(pool, 3);
    for (const reward of rewards) {
      assert.ok(Number.isInteger(reward), `${reward} is not a whole credit`);
    }
    assert.equal(sum(rewards), Math.round(pool));
  }
});

test("one winner is paid for every place that was awarded", () => {
  for (let winners = 1; winners <= 30; winners += 1) {
    assert.equal(distributeRewards(10000, winners).length, winners);
  }
});

test("no winner is ever paid a negative amount", () => {
  for (let winners = 1; winners <= 30; winners += 1) {
    for (const pool of [1, 5, 29, 1000]) {
      for (const reward of distributeRewards(pool, winners)) {
        assert.ok(reward >= 0, `pool ${pool} / ${winners} winners produced ${reward}`);
      }
    }
  }
});

test("earlier places are never paid less than later ones", () => {
  const rewards = distributeRewards(1000, 3);
  for (let i = 1; i < rewards.length; i += 1) {
    assert.ok(rewards[i - 1] >= rewards[i], `place ${i} outearned place ${i}`);
  }
});

test("a pool too small to cover everyone still balances", () => {
  // 5 credits across 10 winners: five get 1, five get nothing, total stays 5
  const rewards = distributeRewards(5, 10);
  assert.equal(sum(rewards), 5);
  assert.equal(rewards.length, 10);
  assert.equal(rewards.filter((value) => value === 0).length, 5);
});

test("a realistic room quiz settles without leaking credit", () => {
  // 40 students attend a room quiz, 70% of collected credit becomes the pool
  const collected = 40 * ROOM_QUIZ_ATTEND_CREDIT;
  const pool = Math.round(collected * ROOM_QUIZ_REWARD_POOL_RATE);
  const rewards = distributeRewards(pool, getPublicQuizWinnerCount(40));
  assert.equal(sum(rewards), pool);
  assert.ok(pool < collected, "the platform must retain its share");
});
