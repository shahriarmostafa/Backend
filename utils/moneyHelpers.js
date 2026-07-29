/**
 * Pure money arithmetic, kept at module scope so it can be tested without
 * constructing routes or a database connection.
 *
 * Extracted from routes/admin.js unchanged - behaviour must stay identical.
 */
const {
  TEACHER_WITHDRAW_EARNING_RATE,
  TEACHER_WITHDRAW_PLATFORM_BONUS_RATE,
  TEACHER_WITHDRAW_PLATFORM_PROFIT_RATE,
  STUDY_ROOM_TEACHER_CREDIT_RATE,
} = require("./constants");

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Teacher points earned from a call, banded by length. Calls under 40s earn nothing. */
const getGeneralCallPoints = (totalSeconds) => {
  if (totalSeconds < 40) return 0;
  if (totalSeconds < 180) return 3;
  if (totalSeconds < 300) return 5;
  if (totalSeconds < 600) return 8;
  if (totalSeconds < 900) return 12;
  if (totalSeconds < 1200) return 16;
  if (totalSeconds < 1800) return 22;
  return 28;
};

/** Group room calls are discounted; a solo student pays the full rate. */
const getRoomCallCreditRate = (studentCount) =>
  Number(studentCount) > 1 ? STUDY_ROOM_TEACHER_CREDIT_RATE : 1;

/** One credit per ten seconds, scaled by the rate and rounded up. */
const getCallCreditForSeconds = (seconds, rate = 1) => {
  const safeSeconds = Math.max(Number(seconds) || 0, 0);
  const safeRate = Number(rate) || 0;
  return Math.ceil(Math.floor(safeSeconds / 10) * safeRate);
};

/** Per-student rate on a direct call, clamped to the billable range. */
const clampCreditRate = (rate) => Math.min(Math.max(Number(rate) || 1, 0.1), 1);

/**
 * Splits a money pool across a teacher's points.
 *
 * The teacher is paid `earningRate` of the gross value of their points, the
 * platform keeps `profitRate`, and the remaining `bonusRate` is distributed
 * separately by calculatePlatformMoney - it deliberately does not appear here.
 */
const getTeacherWithdrawalBreakdown = ({
  points,
  totalTeacherPoints,
  moneyPool,
  qualityAdjustedPoints = points,
}) => {
  const safePoints = Number(points) || 0;
  const safeQualityAdjustedPoints = Math.max(Number(qualityAdjustedPoints) || safePoints, 0);
  const safeTotalTeacherPoints = Number(totalTeacherPoints) || 0;
  const safeMoneyPool = Math.max(Number(moneyPool) || 0, 0);
  const grossPointValue = safeTotalTeacherPoints > 0 ? safeMoneyPool / safeTotalTeacherPoints : 0;
  const earningPointValue = grossPointValue * TEACHER_WITHDRAW_EARNING_RATE;
  const profitPointValue = grossPointValue * TEACHER_WITHDRAW_PLATFORM_PROFIT_RATE;
  const earningsAmount = roundMoney(safePoints * earningPointValue);
  const qualityAdjustmentPoints = roundMoney(safeQualityAdjustedPoints - safePoints);
  const qualityAdjustmentAmount = roundMoney(qualityAdjustmentPoints * earningPointValue);
  const adjustedEarningsAmount = roundMoney(safeQualityAdjustedPoints * earningPointValue);
  const platformProfitAmount = roundMoney(safePoints * profitPointValue);
  const amount = Math.max(roundMoney(adjustedEarningsAmount), 0);

  return {
    amount,
    earningsAmount,
    adjustedEarningsAmount,
    qualityAdjustmentPoints,
    qualityAdjustmentAmount,
    platformProfitAmount,
    grossPointValue,
    earningPointValue,
    profitPointValue,
    rates: {
      teacherEarningRate: TEACHER_WITHDRAW_EARNING_RATE,
      platformProfitRate: TEACHER_WITHDRAW_PLATFORM_PROFIT_RATE,
    },
  };
};

module.exports = {
  roundMoney,
  getTeacherWithdrawalBreakdown,
  getGeneralCallPoints,
  getRoomCallCreditRate,
  getCallCreditForSeconds,
  clampCreditRate,
  WITHDRAW_RATES: {
    earning: TEACHER_WITHDRAW_EARNING_RATE,
    bonus: TEACHER_WITHDRAW_PLATFORM_BONUS_RATE,
    profit: TEACHER_WITHDRAW_PLATFORM_PROFIT_RATE,
  },
};
