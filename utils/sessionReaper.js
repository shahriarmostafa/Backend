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
const { getGeneralCallPoints, getCallCreditForSeconds, clampCreditRate } = require("./moneyHelpers");

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

      if (session.studentId && !session.creditFinalized) {
        const rate = session.roomId ? Number(session.creditRate) || 1 : clampCreditRate(session.creditRate);
        const credit = getCallCreditForSeconds(seconds, rate);
        if (credit > 0 && activepackages) {
          await activepackages.updateOne(
            { uid: session.studentId, credit: { $gte: credit } },
            { $inc: { credit: -credit } }
          );
        }
        await callSession.updateOne(
          { sessionId: session.sessionId },
          { $set: { creditDeducted: credit, creditFinalized: true } }
        );
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
