const test = require("node:test");
const assert = require("node:assert/strict");

const { makeCourseHelpers, hasCourseSessionAccess } = require("../utils/courseHelpers");
const { createDb } = require("./helpers/fakeMongo");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-10T12:00:00Z");

const course = (enrollments = [], overrides = {}) => ({
  _id: "course-1",
  title: "Physics",
  teacherId: "teacher-1",
  teacher: { uid: "teacher-1", displayName: "T", email: "teacher@example.com" },
  sessions: [
    { id: "s1", scheduledAt: new Date("2026-11-02T14:00:00Z"), studentAttendance: { a: true, b: true }, ratings: [{ studentId: "b", rating: 5 }] },
    { id: "s2", scheduledAt: new Date("2026-11-04T14:00:00Z"), studentAttendance: {}, ratings: [] },
  ],
  enrollments,
  teacherPayments: [{ amount: 100 }],
  ...overrides,
});

const enrollment = (studentId, paymentPlan, extra = {}) => ({
  studentId,
  paymentPlan,
  status: "active",
  student: { uid: studentId, email: `${studentId}@example.com` },
  enrolledAt: new Date(NOW.getTime() - DAY),
  ...extra,
});

const helpers = () => {
  const db = createDb({});
  return makeCourseHelpers({ databaseinmongo: db, courses: db.collection("courses") });
};

// --- hasCourseSessionAccess -------------------------------------------------

test("a full-course enrollment covers every session", () => {
  const c = course([enrollment("a", "full")]);
  assert.equal(hasCourseSessionAccess(c, "a", "s1", NOW), true);
  assert.equal(hasCourseSessionAccess(c, "a", "s2", NOW), true);
});

test("a monthly enrollment stops covering sessions once validUntil passes", () => {
  const c = course([enrollment("a", "monthly", { validUntil: new Date(NOW.getTime() + DAY) })]);
  assert.equal(hasCourseSessionAccess(c, "a", "s2", NOW), true);
  assert.equal(hasCourseSessionAccess(c, "a", "s2", new Date(NOW.getTime() + 2 * DAY)), false);
});

test("a single-session enrollment covers only the class that was bought", () => {
  const c = course([enrollment("a", "session", { sessionId: "s2" })]);
  assert.equal(hasCourseSessionAccess(c, "a", "s2", NOW), true);
  assert.equal(hasCourseSessionAccess(c, "a", "s1", NOW), false);
});

test("cancelled enrollments, other students and unknown sessions never count", () => {
  const c = course([enrollment("a", "full", { status: "cancelled" }), enrollment("b", "full")]);
  assert.equal(hasCourseSessionAccess(c, "a", "s1", NOW), false);
  assert.equal(hasCourseSessionAccess(c, "c", "s1", NOW), false);
  assert.equal(hasCourseSessionAccess(c, "b", "not-a-session", NOW), false);
  assert.equal(hasCourseSessionAccess(c, "b", undefined, NOW), false);
});

test("any one of several enrollments is enough", () => {
  const c = course([
    enrollment("a", "monthly", { validUntil: new Date(NOW.getTime() - DAY) }),
    enrollment("a", "session", { sessionId: "s1" }),
  ]);
  assert.equal(hasCourseSessionAccess(c, "a", "s1", NOW), true);
  assert.equal(hasCourseSessionAccess(c, "a", "s2", NOW), false);
});

// --- what the course payload reveals ----------------------------------------

test("students do not receive the roster, payouts or other students' entries", async () => {
  const c = course([enrollment("a", "session", { sessionId: "s1" }), enrollment("b", "full")]);
  const view = await helpers().hydrateCourse(c, "a");

  assert.equal(view.enrollments, undefined);
  assert.equal(view.teacherPayments, undefined);
  assert.equal(view.teacher.email, undefined);
  assert.equal(view.studentCount, 2);
  assert.equal(view.myEnrollment.studentId, "a");
  assert.deepEqual(view.sessions[0].studentAttendance, { a: true });
  assert.deepEqual(view.sessions[0].ratings, []);
  assert.equal(view.sessions[0].myAccess, true);
  assert.equal(view.sessions[1].myAccess, false);
  assert.equal(view.myAccess.coversAll, false);
});

test("the course teacher still gets the full roster", async () => {
  const c = course([enrollment("a", "full")]);
  const view = await helpers().hydrateCourse(c, "teacher-1");
  assert.equal(view.enrollments.length, 1);
  assert.equal(view.enrollments[0].student.email, "a@example.com");
  assert.equal(view.sessions[0].studentAttendance.b, true);
});

// --- the class routine ------------------------------------------------------

test("sessions land on the chosen weekdays at the schedule time in Dhaka", () => {
  const sessions = helpers().buildScheduleSessions({
    startsAt: "2026-11-02", // a Monday
    days: ["Mon", "Wed", "Fri"],
    time: "8:00 PM",
    totalClasses: 4,
  });
  assert.deepEqual(
    sessions.map((session) => session.scheduledAt.toISOString()),
    [
      // 20:00 at UTC+6
      "2026-11-02T14:00:00.000Z",
      "2026-11-04T14:00:00.000Z",
      "2026-11-06T14:00:00.000Z",
      "2026-11-09T14:00:00.000Z",
    ]
  );
  assert.deepEqual(sessions.map((session) => session.title), ["Class 1", "Class 2", "Class 3", "Class 4"]);
});

test("a client-sent offset overrides the platform zone", () => {
  const sessions = helpers().buildScheduleSessions({
    startsAt: "2026-11-02",
    days: ["Tue"],
    time: "09:30",
    totalClasses: 1,
    utcOffsetMinutes: 0,
  });
  assert.equal(sessions[0].scheduledAt.toISOString(), "2026-11-03T09:30:00.000Z");
});

test("unreadable days fall back to weekly on the start day", () => {
  const sessions = helpers().buildScheduleSessions({
    startsAt: "2026-11-02",
    days: [],
    time: "7 pm",
    totalClasses: 2,
  });
  assert.deepEqual(
    sessions.map((session) => session.scheduledAt.toISOString()),
    ["2026-11-02T13:00:00.000Z", "2026-11-09T13:00:00.000Z"]
  );
});
