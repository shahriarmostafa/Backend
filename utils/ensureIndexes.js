/**
 * Index definitions, created once on startup.
 *
 * Before this existed the database had only the default `_id` indexes, so every
 * lookup by `uid` (34 call sites) was a full collection scan. createIndex is
 * idempotent, so running this on every boot is cheap.
 *
 * Index creation must never take the server down: a failure here degrades
 * performance, it does not break correctness.
 */

const INDEXES = [
  // hottest path in the app: resolving a user from a firebase uid
  ["userCollection", { uid: 1 }, { name: "uid_1" }],
  ["userCollection", { role: 1 }, { name: "role_1" }],
  ["userCollection", { email: 1 }, { name: "email_1" }],

  // checked on every admin/owner-gated request
  ["owner", { uid: 1 }, { name: "uid_1" }],

  ["activePackages", { uid: 1 }, { name: "uid_1" }],
  ["subscriptions", { uid: 1 }, { name: "uid_1" }],
  ["referrals", { referredUid: 1 }, { name: "referredUid_1" }],
  ["referrals", { referrerUid: 1 }, { name: "referrerUid_1" }],

  ["callSession", { sessionId: 1 }, { name: "sessionId_1" }],
  ["callSession", { roomCallId: 1 }, { name: "roomCallId_1" }],
  ["callSession", { studentId: 1, startTime: -1 }, { name: "studentId_startTime" }],
  ["callSession", { teacherId: 1, startTime: -1 }, { name: "teacherId_startTime" }],

  // quality events are read per teacher per month and deduped by key
  ["teacherQualityEvents", { teacherId: 1, monthKey: 1, source: 1 }, { name: "teacher_month_source" }],

  ["leaderboardSnapshots", { scope: 1, scopeId: 1, studentId: 1 }, { name: "scope_scopeId_student" }],
  ["leaderboardSnapshots", { scope: 1, scopeId: 1, xp: -1 }, { name: "scope_scopeId_xp" }],

  ["notifications", { scope: 1, scopeId: 1, createdAt: -1 }, { name: "scope_scopeId_created" }],
  ["notifications", { recipients: 1 }, { name: "recipients_1" }],

  ["studyRooms", { roomCode: 1 }, { name: "roomCode_1" }],
  ["studyRooms", { category: 1, type: 1 }, { name: "category_type" }],

  ["roomQuizzes", { roomId: 1 }, { name: "roomId_1" }],
  ["publicQuizzes", { category: 1, type: 1 }, { name: "category_type" }],

  ["salaryHistory", { teacherId: 1 }, { name: "teacherId_1" }],
  ["coursePayments", { studentId: 1 }, { name: "studentId_1" }],
  ["courses", { teacherId: 1 }, { name: "teacherId_1" }],
];

const ensureIndexes = async (db) => {
  if (!db) return { created: 0, failed: 0 };
  let created = 0;
  let failed = 0;

  for (const [collectionName, keys, options] of INDEXES) {
    try {
      await db.collection(collectionName).createIndex(keys, { background: true, ...options });
      created += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[indexes] ${collectionName} ${JSON.stringify(keys)} failed: ${err.message}`);
    }
  }

  // dedupeKey is what makes quality events (and therefore chat reactions)
  // idempotent. A unique index enforces that in the database rather than in
  // application code, but it cannot be created if duplicates already exist.
  try {
    await db
      .collection("teacherQualityEvents")
      .createIndex({ dedupeKey: 1 }, { unique: true, background: true, name: "dedupeKey_unique" });
    created += 1;
  } catch (err) {
    console.warn(
      `[indexes] teacherQualityEvents.dedupeKey could not be made unique (${err.message}); ` +
        "falling back to a non-unique index. Clean up duplicates to enable it."
    );
    try {
      await db
        .collection("teacherQualityEvents")
        .createIndex({ dedupeKey: 1 }, { background: true, name: "dedupeKey_1" });
      created += 1;
    } catch (fallbackErr) {
      failed += 1;
      console.warn(`[indexes] teacherQualityEvents.dedupeKey failed: ${fallbackErr.message}`);
    }
  }

  console.log(`[indexes] ready (${created} ensured, ${failed} failed)`);
  return { created, failed };
};

module.exports = { ensureIndexes, INDEXES };
