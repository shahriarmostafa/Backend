/**
 * Closes call sessions whose client never called /end-call.
 *
 * `lastHeartbeatAt` was already being written but never read, so a browser
 * crash, a killed app or a dropped connection left the session open forever:
 * `endTime` was never set, `creditFinalized` stayed false, and the student was
 * never charged. Room calls partly escaped this because the teacher ending the
 * call finalises orphaned student sessions, but direct calls had no backstop.
 *
 * Deliberately conservative: it only finalises sessions that have been silent
 * well past any plausible network hiccup, and bills using the last heartbeat
 * rather than "now" so a student is not charged for hours they were absent.
 */
const {
  getGeneralCallPoints,
  getCallCreditForSeconds,
  getBillableCallSeconds,
  getRoomCallCreditRate,
  clampCreditRate,
} = require("./moneyHelpers");

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000; // silent for ten minutes
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const makeSessionReaper = ({
  databaseinmongo,
  activepackages,
  userCollection,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = () => Date.now(),
} = {}) => {
  const callSession = databaseinmongo?.collection("callSession");

  const reapOnce = async () => {
    if (!callSession) return { reaped: 0 };

    const cutoff = now() - staleAfterMs;
    // Judge staleness by the heartbeat when there is one. Falling back to
    // startTime unconditionally would kill healthy long calls, because a two
    // hour class always has an old start time.
    // `lastHeartbeatAt: null` matches both a null and a missing field in Mongo.
    const stale = await callSession
      .find({
        endTime: { $exists: false },
        $or: [
          { lastHeartbeatAt: { $lt: cutoff } },
          { lastHeartbeatAt: null, startTime: { $lt: cutoff } },
        ],
      })
      .toArray();

    let reaped = 0;

    for (const session of stale) {
      // bill only up to the last sign of life, never up to now
      const lastSeen = Number(session.lastHeartbeatAt) || Number(session.startTime) || 0;
      const startTime = Number(session.startTime) || lastSeen;
      const seconds = Math.max(Math.floor((lastSeen - startTime) / 1000), 0);
      const callPoints = getGeneralCallPoints(seconds);

      const closed = await callSession.updateOne(
        { sessionId: session.sessionId, endTime: { $exists: false } },
        {
          $set: {
            endTime: lastSeen,
            seconds,
            callPoints,
            endedAt: new Date(lastSeen),
            endedByReaper: true,
          },
        }
      );
      // another process (or a late /end-call) got there first
      if (closed.modifiedCount === 0) continue;

      const isDirectCall = Boolean(session.studentId && session.teacherId && !session.roomId && !session.courseId);

      if (session.studentId && !session.creditFinalized && !session.courseId) {
        // A room class abandoned by the teacher is still a group class: bill
        // it at the group rate, not each student at the solo rate.
        let rate = clampCreditRate(session.creditRate);
        if (session.roomId && session.roomCallId) {
          const groupSessions = await callSession
            .find({ roomId: session.roomId, roomCallId: session.roomCallId })
            .toArray();
          const groupSize = new Set(groupSessions.map((item) => item.studentId).filter(Boolean)).size;
          rate = getRoomCallCreditRate(groupSize);
        }
        // Bill what the balance covers. This used to charge nothing at all when
        // the student was short, yet record the full amount as deducted.
        const pkg = activepackages
          ? await activepackages.findOne({ uid: session.studentId }, { projection: { credit: 1 } })
          : null;
        const billableSeconds = getBillableCallSeconds(seconds, pkg?.credit, rate);
        const credit = getCallCreditForSeconds(billableSeconds, rate);
        let deducted = 0;
        if (credit > 0 && activepackages) {
          const paid = await activepackages.updateOne(
            { uid: session.studentId, credit: { $gte: credit } },
            { $inc: { credit: -credit } }
          );
          if (paid.modifiedCount > 0) deducted = credit;
        }
        await callSession.updateOne(
          { sessionId: session.sessionId },
          { $set: { creditDeducted: deducted, billedSeconds: billableSeconds, creditFinalized: true } }
        );

        // /end-call pays the teacher of a direct class; when neither side got
        // to call it, the teacher used to earn nothing for the class.
        if (isDirectCall && !session.teacherPointsFinalized && userCollection) {
          const teacherPoints = deducted > 0 ? getGeneralCallPoints(billableSeconds) : 0;
          if (teacherPoints > 0) {
            await userCollection.updateOne({ uid: session.teacherId, role: "teacher" }, { $inc: { points: teacherPoints } });
          }
          await callSession.updateOne(
            { sessionId: session.sessionId },
            { $set: { teacherPointsAdded: teacherPoints, teacherPointsFinalized: true, teacherPointsFinalizedAt: new Date() } }
          );
        }
      }

      reaped += 1;
    }

    if (reaped > 0) console.log(`[reaper] closed ${reaped} abandoned call session(s)`);
    return { reaped };
  };

  const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
    const timer = setInterval(() => {
      reapOnce().catch((err) => console.error("[reaper] failed:", err));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { reapOnce, start };
};

module.exports = { makeSessionReaper, DEFAULT_STALE_AFTER_MS, DEFAULT_INTERVAL_MS };
