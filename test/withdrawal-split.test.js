const test = require("node:test");
const assert = require("node:assert/strict");

const { getTeacherWithdrawalBreakdown, WITHDRAW_RATES } = require("../utils/moneyHelpers");

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} (got ${actual}, expected ~${expected})`
  );

test("a teacher is paid in proportion to their share of all points", () => {
  // 100 of 1000 points against a 50,000 pool: gross value 50/point, 80% earned
  const breakdown = getTeacherWithdrawalBreakdown({
    points: 100,
    totalTeacherPoints: 1000,
    moneyPool: 50000,
  });
  assert.equal(breakdown.grossPointValue, 50);
  assert.equal(breakdown.earningPointValue, 40);
  assert.equal(breakdown.earningsAmount, 4000);
  assert.equal(breakdown.amount, 4000);
  assert.equal(breakdown.platformProfitAmount, 500);
});

test("two teachers with equal points are paid equally", () => {
  const args = { totalTeacherPoints: 500, moneyPool: 10000 };
  const first = getTeacherWithdrawalBreakdown({ ...args, points: 250 });
  const second = getTeacherWithdrawalBreakdown({ ...args, points: 250 });
  assert.equal(first.amount, second.amount);
});

test("doubling a teacher's points doubles their payout", () => {
  const args = { totalTeacherPoints: 2000, moneyPool: 80000 };
  const single = getTeacherWithdrawalBreakdown({ ...args, points: 100 });
  const double = getTeacherWithdrawalBreakdown({ ...args, points: 200 });
  close(double.amount, single.amount * 2, 0.01, "payout should scale linearly");
});

/**
 * The whole platform having zero points is a real state on a quiet month.
 * It must not produce Infinity or NaN payouts.
 */
test("an empty point pool pays nothing instead of dividing by zero", () => {
  const breakdown = getTeacherWithdrawalBreakdown({
    points: 100,
    totalTeacherPoints: 0,
    moneyPool: 50000,
  });
  assert.equal(breakdown.grossPointValue, 0);
  assert.equal(breakdown.amount, 0);
  for (const [key, value] of Object.entries(breakdown)) {
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value), `${key} was ${value}`);
    }
  }
});

test("an empty money pool pays nothing", () => {
  const breakdown = getTeacherWithdrawalBreakdown({
    points: 500,
    totalTeacherPoints: 1000,
    moneyPool: 0,
  });
  assert.equal(breakdown.amount, 0);
});

test("a negative money pool is floored at zero rather than clawing back", () => {
  const breakdown = getTeacherWithdrawalBreakdown({
    points: 500,
    totalTeacherPoints: 1000,
    moneyPool: -50000,
  });
  assert.equal(breakdown.amount, 0);
  assert.ok(breakdown.amount >= 0);
});

test("missing or unparseable inputs never produce NaN", () => {
  for (const bad of [undefined, null, "", "abc", NaN]) {
    const breakdown = getTeacherWithdrawalBreakdown({
      points: bad,
      totalTeacherPoints: bad,
      moneyPool: bad,
    });
    assert.ok(Number.isFinite(breakdown.amount), `points=${String(bad)} gave ${breakdown.amount}`);
    assert.equal(breakdown.amount, 0);
  }
});

test("a payout is never negative", () => {
  for (const points of [-500, -1, 0, 1]) {
    const breakdown = getTeacherWithdrawalBreakdown({
      points,
      totalTeacherPoints: 1000,
      moneyPool: 50000,
    });
    assert.ok(breakdown.amount >= 0, `points ${points} produced ${breakdown.amount}`);
  }
});

test("a quality bonus increases the payout above raw points", () => {
  const base = { points: 100, totalTeacherPoints: 1000, moneyPool: 50000 };
  const bonused = getTeacherWithdrawalBreakdown({ ...base, qualityAdjustedPoints: 115 });
  assert.ok(bonused.amount > 4000, "a bonus should pay more than raw points");
  assert.equal(bonused.qualityAdjustmentPoints, 15);
  assert.equal(bonused.qualityAdjustmentAmount, 600);
  assert.equal(bonused.adjustedEarningsAmount, 4600);
});

test("a quality penalty reduces the payout below raw points", () => {
  const penalised = getTeacherWithdrawalBreakdown({
    points: 100,
    totalTeacherPoints: 1000,
    moneyPool: 50000,
    qualityAdjustedPoints: 85,
  });
  assert.ok(penalised.amount < 4000);
  assert.equal(penalised.qualityAdjustmentPoints, -15);
  assert.equal(penalised.amount, 3400);
});

test("a penalty cannot drive the payout below zero", () => {
  const breakdown = getTeacherWithdrawalBreakdown({
    points: 100,
    totalTeacherPoints: 1000,
    moneyPool: 50000,
    qualityAdjustedPoints: -9999,
  });
  assert.ok(breakdown.amount >= 0, `got ${breakdown.amount}`);
});

test("omitting the quality figure falls back to raw points", () => {
  const withOut = getTeacherWithdrawalBreakdown({
    points: 250,
    totalTeacherPoints: 1000,
    moneyPool: 40000,
  });
  const withExplicit = getTeacherWithdrawalBreakdown({
    points: 250,
    totalTeacherPoints: 1000,
    moneyPool: 40000,
    qualityAdjustedPoints: 250,
  });
  assert.deepEqual(withOut, withExplicit);
});

/**
 * Conservation across the whole platform. Teacher earnings take 80% of the
 * pool and platform profit 10%; the remaining 10% is the bonus pool that
 * calculatePlatformMoney distributes separately. The three must account for
 * the entire pool and never overspend it.
 */
test("teacher earnings plus platform profit plus bonus equal the whole pool", () => {
  const moneyPool = 100000;
  const teachers = [400, 250, 150, 120, 80];
  const totalTeacherPoints = teachers.reduce((total, points) => total + points, 0);

  const breakdowns = teachers.map((points) =>
    getTeacherWithdrawalBreakdown({ points, totalTeacherPoints, moneyPool })
  );
  const paidToTeachers = breakdowns.reduce((total, item) => total + item.amount, 0);
  const platformProfit = breakdowns.reduce((total, item) => total + item.platformProfitAmount, 0);
  const bonusPool = moneyPool * WITHDRAW_RATES.bonus;

  close(paidToTeachers, moneyPool * WITHDRAW_RATES.earning, 0.05, "teacher earnings share");
  close(platformProfit, moneyPool * WITHDRAW_RATES.profit, 0.05, "platform profit share");
  close(paidToTeachers + platformProfit + bonusPool, moneyPool, 0.05, "total allocation");
  assert.ok(paidToTeachers + platformProfit <= moneyPool, "the platform must not overspend");
});

test("the configured rates account for exactly the whole pool", () => {
  const total = WITHDRAW_RATES.earning + WITHDRAW_RATES.bonus + WITHDRAW_RATES.profit;
  close(total, 1, 1e-9, "earning + bonus + profit should be 100% of the pool");
});

test("payout amounts are rounded to whole paisa", () => {
  const breakdown = getTeacherWithdrawalBreakdown({
    points: 37,
    totalTeacherPoints: 993,
    moneyPool: 71234.567,
  });
  assert.equal(breakdown.amount, Math.round(breakdown.amount * 100) / 100);
});
