const {
  TEACHER_QUALITY_MAX_BONUS_RATE,
  TEACHER_QUALITY_MAX_PENALTY_RATE,
  TEACHER_QUALITY_REPLY_FAST_MINUTES,
  TEACHER_QUALITY_REPLY_OK_MINUTES,
  TEACHER_QUALITY_REPLY_LATE_MINUTES,
  TEACHER_QUALITY_REACTION_DELTAS,
  TEACHER_QUALITY_RATING_DELTAS,
  TEACHER_QUALITY_SOURCE_CAPS,
} = require("./constants");

const roundQuality = (value) => Math.round((Number(value) || 0) * 100) / 100;

const getMonthKey = (date = new Date()) => {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

const getRatingDelta = (rating) => {
  const normalized = Math.min(Math.max(Math.round(Number(rating) || 0), 1), 5);
  return Number(TEACHER_QUALITY_RATING_DELTAS[normalized]) || 0;
};

const getReactionDelta = (reaction, isLike = null) => {
  const normalized = String(
    reaction || (isLike === true ? "liked" : isLike === false ? "disliked" : "")
  ).toLowerCase();
  return Number(TEACHER_QUALITY_REACTION_DELTAS[normalized]) || 0;
};

const getReplySpeedDelta = (minutes) => {
  const safeMinutes = Math.max(Number(minutes) || 0, 0);
  if (safeMinutes <= TEACHER_QUALITY_REPLY_FAST_MINUTES) return 1;
  if (safeMinutes <= TEACHER_QUALITY_REPLY_OK_MINUTES) return 0.45;
  if (safeMinutes <= TEACHER_QUALITY_REPLY_LATE_MINUTES) return 0;
  return -1;
};

const makeTeacherQualityHelpers = ({ databaseinmongo, userCollection } = {}) => {
  const qualityEvents = databaseinmongo?.collection("teacherQualityEvents");

  const recordQualityEvent = async ({
    teacherId,
    studentId = null,
    source,
    sourceId,
    dedupeKey = null,
    delta = 0,
    rating = null,
    reaction = null,
    metadata = {},
    session = null,
    createdAt = new Date(),
  } = {}) => {
    if (!qualityEvents || !teacherId || !source || !sourceId) {
      return { ok: false, reason: "missing_required_fields" };
    }

    const monthKey = getMonthKey(createdAt);
    const normalizedDelta = roundQuality(delta);
    const cap = Math.abs(Number(TEACHER_QUALITY_SOURCE_CAPS[source]) || 0);
    const uniqueKey = dedupeKey || `${source}:${sourceId}:${studentId || "system"}`;

    if (cap > 0) {
      const existing = await qualityEvents
        .aggregate(
          [
            { $match: { teacherId, source, monthKey } },
            { $group: { _id: null, total: { $sum: "$delta" } } },
          ],
          { session }
        )
        .toArray();
      const sourceTotal = Number(existing[0]?.total) || 0;
      const remaining = normalizedDelta >= 0 ? cap - sourceTotal : cap + sourceTotal;
      if (remaining <= 0) return { ok: true, capped: true, delta: 0 };
    }

    const event = {
      teacherId,
      studentId,
      source,
      sourceId: String(sourceId),
      dedupeKey: uniqueKey,
      monthKey,
      delta: normalizedDelta,
      rating,
      reaction,
      metadata,
      createdAt,
      updatedAt: new Date(),
    };

    await qualityEvents.updateOne(
      { dedupeKey: uniqueKey },
      {
        $setOnInsert: event,
        $set: { updatedAt: new Date() },
      },
      { upsert: true, session }
    );

    return { ok: true, delta: normalizedDelta, monthKey };
  };

  const recordRatingEvent = (payload = {}) =>
    recordQualityEvent({ ...payload, delta: getRatingDelta(payload.rating) });

  const recordReactionEvent = (payload = {}) =>
    recordQualityEvent({
      ...payload,
      reaction: payload.reaction || (payload.isLike ? "liked" : "disliked"),
      delta: getReactionDelta(payload.reaction, payload.isLike),
    });

  const recordFirstReplySpeedEvent = (payload = {}) =>
    recordQualityEvent({
      ...payload,
      source: "first_reply_speed",
      delta: getReplySpeedDelta(payload.minutes),
      metadata: { ...(payload.metadata || {}), minutes: Math.round(Number(payload.minutes) || 0) },
    });

  const getTeacherQualitySummary = async ({ teacherId, basePoints = 0, monthKey = getMonthKey(), session = null } = {}) => {
    if (!qualityEvents || !teacherId) {
      return {
        monthKey,
        rawQualityPoints: 0,
        qualityAdjustmentPoints: 0,
        maxBonusRate: TEACHER_QUALITY_MAX_BONUS_RATE,
        maxPenaltyRate: TEACHER_QUALITY_MAX_PENALTY_RATE,
        eventCount: 0,
      };
    }

    const events = await qualityEvents
      .find({ teacherId, monthKey }, session ? { session } : undefined)
      .project({ delta: 1, source: 1, studentId: 1 })
      .toArray();
    const rawQualityPoints = roundQuality(events.reduce((sum, item) => sum + (Number(item.delta) || 0), 0));
    const safeBasePoints = Math.max(Number(basePoints) || 0, 0);
    const maxBonus = safeBasePoints * TEACHER_QUALITY_MAX_BONUS_RATE;
    const maxPenalty = safeBasePoints * TEACHER_QUALITY_MAX_PENALTY_RATE;
    const qualityAdjustmentPoints = roundQuality(clamp(rawQualityPoints, -maxPenalty, maxBonus));

    return {
      monthKey,
      rawQualityPoints,
      qualityAdjustmentPoints,
      maxBonusRate: TEACHER_QUALITY_MAX_BONUS_RATE,
      maxPenaltyRate: TEACHER_QUALITY_MAX_PENALTY_RATE,
      eventCount: events.length,
      uniqueStudentCount: new Set(events.map((item) => item.studentId).filter(Boolean)).size,
    };
  };

  const applyTeacherQualitySnapshot = async ({ teacherId, basePoints = 0, session = null } = {}) => {
    const summary = await getTeacherQualitySummary({ teacherId, basePoints, session });
    if (!userCollection || !teacherId) return summary;
    await userCollection.updateOne(
      { uid: teacherId },
      {
        $set: {
          qualitySummary: summary,
          qualitySummaryUpdatedAt: new Date(),
        },
      },
      { session }
    );
    return summary;
  };

  return {
    getMonthKey,
    getRatingDelta,
    getReactionDelta,
    getReplySpeedDelta,
    recordQualityEvent,
    recordRatingEvent,
    recordReactionEvent,
    recordFirstReplySpeedEvent,
    getTeacherQualitySummary,
    applyTeacherQualitySnapshot,
  };
};

module.exports = {
  makeTeacherQualityHelpers,
  getMonthKey,
  getRatingDelta,
  getReactionDelta,
  getReplySpeedDelta,
};
