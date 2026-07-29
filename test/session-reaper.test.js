const test = require("node:test");
const assert = require("node:assert/strict");

const { makeSessionReaper } = require("../utils/sessionReaper");
const { createDb } = require("./helpers/fakeMongo");

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

const setup = (sessions = [], packages = []) => {
  const db = createDb({ callSession: sessions, activePackages: packages });
  const reaper = makeSessionReaper({
    databaseinmongo: db,
    activepackages: db.collection("activePackages"),
    userCollection: db.collection("userCollection"),
    now: () => NOW,
  });
  return { db, reaper, sessions: db.collection("callSession") };
};

const liveSession = (overrides = {}) => ({
  sessionId: "s1",
  studentId: "student-1",
  teacherId: "teacher-1",
  startTime: NOW - 30 * MINUTE,
  lastHeartbeatAt: NOW - 20 * MINUTE,
  creditRate: 1,
  ...overrides,
});

test("a session silent past the threshold is closed", async () => {
  const { reaper, sessions } = setup([liveSession()]);
  const { reaped } = await reaper.reapOnce();

  assert.equal(reaped, 1);
  const closed = await sessions.findOne({ sessionId: "s1" });
  assert.ok(closed.endTime, "endTime should be set");
  assert.equal(closed.endedByReaper, true);
});

test("a session still sending heartbeats is left alone", async () => {
  const { reaper, sessions } = setup([liveSession({ lastHeartbeatAt: NOW - MINUTE })]);
  const { reaped } = await reaper.reapOnce();

  assert.equal(reaped, 0);
  const untouched = await sessions.findOne({ sessionId: "s1" });
  assert.equal(untouched.endTime, undefined);
});

test("an already ended session is not touched again", async () => {
  const { reaper } = setup([
    liveSession({ endTime: NOW - 10 * MINUTE, seconds: 600, creditFinalized: true }),
  ]);
  const { reaped } = await reaper.reapOnce();
  assert.equal(reaped, 0);
});

/**
 * Billing to "now" would charge a student for every hour since their phone
 * died. Charge only up to the last sign of life.
 */
test("billing stops at the last heartbeat, not at reaping time", async () => {
  const { reaper, sessions } = setup([
    liveSession({ startTime: NOW - 30 * MINUTE, lastHeartbeatAt: NOW - 20 * MINUTE }),
  ]);
  await reaper.reapOnce();

  const closed = await sessions.findOne({ sessionId: "s1" });
  assert.equal(closed.seconds, 10 * 60, "should bill the 10 minutes actually attended");
  assert.equal(closed.endTime, NOW - 20 * MINUTE);
});

test("the student is charged for the time they were present", async () => {
  const { reaper, db } = setup(
    [liveSession({ startTime: NOW - 30 * MINUTE, lastHeartbeatAt: NOW - 20 * MINUTE })],
    [{ uid: "student-1", credit: 500 }]
  );
  await reaper.reapOnce();

  const pkg = db.collection("activePackages")._all()[0];
  // 600 seconds at one credit per ten seconds
  assert.equal(pkg.credit, 500 - 60);
});

test("a student is never charged twice", async () => {
  const { reaper, db } = setup(
    [liveSession({ creditFinalized: true, creditDeducted: 60 })],
    [{ uid: "student-1", credit: 500 }]
  );
  await reaper.reapOnce();
  assert.equal(db.collection("activePackages")._all()[0].credit, 500);
});

test("running the reaper twice does not double charge", async () => {
  const { reaper, db } = setup([liveSession()], [{ uid: "student-1", credit: 500 }]);
  await reaper.reapOnce();
  const afterFirst = db.collection("activePackages")._all()[0].credit;
  await reaper.reapOnce();
  assert.equal(db.collection("activePackages")._all()[0].credit, afterFirst);
});

test("a charge never pushes a balance negative", async () => {
  const { reaper, db } = setup(
    [liveSession({ startTime: NOW - 120 * MINUTE, lastHeartbeatAt: NOW - 20 * MINUTE })],
    [{ uid: "student-1", credit: 5 }]
  );
  await reaper.reapOnce();
  assert.ok(db.collection("activePackages")._all()[0].credit >= 0);
});

test("a session with no student closes without charging anyone", async () => {
  const { reaper, sessions } = setup([liveSession({ studentId: null })]);
  const { reaped } = await reaper.reapOnce();
  assert.equal(reaped, 1);
  assert.ok((await sessions.findOne({ sessionId: "s1" })).endTime);
});

test("a session with no heartbeat falls back to its start time", async () => {
  const { reaper, sessions } = setup([
    liveSession({ lastHeartbeatAt: undefined, startTime: NOW - 45 * MINUTE }),
  ]);
  const { reaped } = await reaper.reapOnce();
  assert.equal(reaped, 1);
  const closed = await sessions.findOne({ sessionId: "s1" });
  assert.equal(closed.seconds, 0, "no heartbeat means no provable attendance");
});

test("teacher points are recorded for the reaped call", async () => {
  const { reaper, sessions } = setup([
    liveSession({ startTime: NOW - 40 * MINUTE, lastHeartbeatAt: NOW - 20 * MINUTE }),
  ]);
  await reaper.reapOnce();
  const closed = await sessions.findOne({ sessionId: "s1" });
  assert.ok(closed.callPoints > 0, "a 20 minute call should be worth points");
});

test("several abandoned sessions are all closed", async () => {
  const { reaper } = setup([
    liveSession({ sessionId: "a" }),
    liveSession({ sessionId: "b", studentId: "student-2" }),
    liveSession({ sessionId: "c", studentId: "student-3", lastHeartbeatAt: NOW - MINUTE }),
  ]);
  const { reaped } = await reaper.reapOnce();
  assert.equal(reaped, 2, "the one still alive should survive");
});
