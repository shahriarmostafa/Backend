const test = require("node:test");
const assert = require("node:assert/strict");

process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || "https://files.example.com";
const BASE_URL = process.env.R2_PUBLIC_BASE_URL.replace(/\/+$/g, "");

const { makeRoomHelpers } = require("../utils/roomHelpers");
const { countXpEligibleGoals } = require("../utils/studentProgressHelpers");
const { sanitizeAnnouncementAttachments } = require("../utils/notificationHelpers");
const { createDb, matches } = require("./helpers/fakeMongo");
const {
  STUDY_ROOM_JOIN_CREDIT,
  STUDY_ROOM_MONTH_MS,
  ROOM_GOAL_XP_DAILY_CAP,
} = require("../utils/constants");

const DAY = 24 * 60 * 60 * 1000;

/**
 * fakeMongo compares a whole array against a scalar and stores Dates as JSON
 * strings, so `{ memberIds: uid }`, `{ memberIds: { $ne: uid } }` and a Date
 * equality never behave as they do in Mongo. The membership code depends on
 * exactly those, so this matcher handles them and defers to fakeMongo otherwise.
 */
const readPath = (doc, path) =>
  path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), doc);

const matchesLikeMongo = (doc, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = readPath(doc, key);
    if (condition instanceof Date) return value != null && new Date(value).getTime() === condition.getTime();
    if (Array.isArray(value) && !/\.\d+$/.test(key)) {
      if (condition && typeof condition === "object" && "$ne" in condition) return !value.includes(condition.$ne);
      if (condition === null || typeof condition !== "object") return value.includes(condition);
    }
    return matches(doc, { [key]: condition });
  });

/**
 * ...and it has no $addToSet/$pull/`$[]`, which the join path relies on. This
 * adds just those, with Mongo's semantics, on top of a fake collection.
 */
const withArrayOps = (collection) => ({
  ...collection,
  async updateOne(filter = {}, update = {}, options = {}) {
    const { $addToSet, $pull, ...rest } = update;
    const target = collection._raw().find((doc) => matchesLikeMongo(doc, filter));
    if (!target) return { matchedCount: 0, modifiedCount: 0 };
    const eachArray = (path, fn) => {
      const [head, tail] = path.split(".$[].");
      if (!tail) {
        target[head] = fn(Array.isArray(target[head]) ? target[head] : []);
        return;
      }
      (target[head] || []).forEach((item) => {
        item[tail] = fn(Array.isArray(item[tail]) ? item[tail] : []);
      });
    };
    Object.entries($addToSet || {}).forEach(([path, value]) =>
      eachArray(path, (list) => (list.includes(value) ? list : [...list, value]))
    );
    Object.entries($pull || {}).forEach(([path, value]) =>
      eachArray(path, (list) => list.filter((item) => item !== value))
    );
    if (Object.keys(rest).length) await collection.updateOne({ _id: target._id }, rest, options);
    return { matchedCount: 1, modifiedCount: 1 };
  },
});

/** findOneAndUpdate on top of the fake, as spendStudentCredit uses it. */
const withFindOneAndUpdate = (collection) => ({
  ...collection,
  async findOneAndUpdate(filter, update) {
    const result = await collection.updateOne(filter, update);
    if (!result.matchedCount) return null;
    const uid = filter.uid;
    return collection.findOne({ uid });
  },
});

const activePackage = (uid, credit) => ({
  uid,
  credit,
  isActive: true,
  expiryDate: new Date(Date.now() + 30 * DAY).toISOString(),
});

const setup = ({ rooms = [], packages = [] } = {}) => {
  const db = createDb({ studyRooms: rooms, activePackages: packages, userCollection: [] });
  const studyRooms = withArrayOps(db.collection("studyRooms"));
  const activepackages = withFindOneAndUpdate(db.collection("activePackages"));
  const helpers = makeRoomHelpers({
    userCollection: db.collection("userCollection"),
    databaseinmongo: db,
    studyRooms,
    activepackages,
  });
  const room = () => db.collection("studyRooms")._all()[0];
  const creditOf = (uid) => db.collection("activePackages")._all().find((item) => item.uid === uid)?.credit;
  return { helpers, room, creditOf };
};

const baseRoom = (overrides = {}) => ({
  _id: "room-1",
  name: "Room",
  memberIds: ["owner"],
  maxStudents: 3,
  memberStatuses: {},
  chats: [
    { chatId: "c1", type: "students", participantIds: ["owner"] },
    { chatId: "c2", type: "teacher", teacherId: "t1", participantIds: ["owner", "t1"] },
  ],
  createdAt: new Date(),
  ...overrides,
});

// --- credit -----------------------------------------------------------------

test("room credit is spent with a conditional decrement", async () => {
  const { helpers, creditOf } = setup({ packages: [activePackage("s1", STUDY_ROOM_JOIN_CREDIT + 1)] });
  const first = await helpers.spendStudentCredit("s1", STUDY_ROOM_JOIN_CREDIT);
  assert.deepEqual(first, { ok: true, credit: 1 });
  const second = await helpers.spendStudentCredit("s1", STUDY_ROOM_JOIN_CREDIT);
  assert.equal(second.ok, false);
  assert.equal(second.status, 402);
  assert.equal(creditOf("s1"), 1);
});

// --- joining ----------------------------------------------------------------

test("joining adds the student to memberIds and every chat without rewriting them", async () => {
  const { helpers, room } = setup({ rooms: [baseRoom()] });
  const claimed = await helpers.claimRoomSeat(baseRoom(), "s1", { isActive: true });
  assert.equal(claimed, true);
  assert.deepEqual(room().memberIds, ["owner", "s1"]);
  assert.deepEqual(room().chats.map((chat) => chat.participantIds), [["owner", "s1"], ["owner", "t1", "s1"]]);
  assert.equal(room().memberStatuses.s1.isActive, true);
});

test("two joins from a stale copy keep both students", async () => {
  // the old route $set memberIds from the copy it read, so the second write
  // dropped the first student after charging them
  const stale = baseRoom();
  const { helpers, room } = setup({ rooms: [baseRoom()] });
  await Promise.all([
    helpers.claimRoomSeat(stale, "s1", { isActive: true }),
    helpers.claimRoomSeat(stale, "s2", { isActive: true }),
  ]);
  assert.deepEqual(room().memberIds.sort(), ["owner", "s1", "s2"]);
});

test("a double tap claims the seat once", async () => {
  const { helpers } = setup({ rooms: [baseRoom()] });
  const results = await Promise.all([
    helpers.claimRoomSeat(baseRoom(), "s1", { isActive: true }),
    helpers.claimRoomSeat(baseRoom(), "s1", { isActive: true }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("a full room refuses the seat", async () => {
  const full = baseRoom({ memberIds: ["owner", "a", "b"] });
  const { helpers, room } = setup({ rooms: [full] });
  assert.equal(await helpers.claimRoomSeat(full, "s1", { isActive: true }), false);
  assert.deepEqual(room().memberIds, ["owner", "a", "b"]);
});

test("releasing a seat undoes the claim", async () => {
  const { helpers, room } = setup({ rooms: [baseRoom()] });
  await helpers.claimRoomSeat(baseRoom(), "s1", { isActive: true });
  await helpers.releaseRoomSeat(baseRoom(), "s1");
  assert.deepEqual(room().memberIds, ["owner"]);
  assert.deepEqual(room().chats[0].participantIds, ["owner"]);
  assert.equal(room().memberStatuses.s1, undefined);
});

// --- renewing ---------------------------------------------------------------

const lapsedRoom = () =>
  baseRoom({
    memberIds: ["owner", "s1"],
    memberStatuses: {
      s1: {
        joinedAt: new Date(Date.now() - 40 * DAY),
        nextBillingAt: new Date(Date.now() - 10 * DAY),
        isActive: true,
      },
    },
  });

test("renewing an active membership is refused and costs nothing", async () => {
  const active = baseRoom({
    memberIds: ["owner", "s1"],
    memberStatuses: { s1: { nextBillingAt: new Date(Date.now() + 10 * DAY), isActive: true } },
  });
  const { helpers, creditOf } = setup({ rooms: [active], packages: [activePackage("s1", 100)] });
  const result = await helpers.renewRoomMembership(active, "s1");
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(creditOf("s1"), 100);
});

test("two concurrent renewals charge once", async () => {
  const stale = lapsedRoom();
  const { helpers, room, creditOf } = setup({ rooms: [lapsedRoom()], packages: [activePackage("s1", 100)] });
  const results = await Promise.all([
    helpers.renewRoomMembership(stale, "s1"),
    helpers.renewRoomMembership(stale, "s1"),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(creditOf("s1"), 100 - STUDY_ROOM_JOIN_CREDIT);
  const nextBillingAt = new Date(room().memberStatuses.s1.nextBillingAt).getTime();
  assert.ok(Math.abs(nextBillingAt - (Date.now() + STUDY_ROOM_MONTH_MS)) < 5000);
});

test("a renewal that cannot be paid for is put back", async () => {
  const { helpers, room, creditOf } = setup({ rooms: [lapsedRoom()], packages: [activePackage("s1", 1)] });
  const result = await helpers.renewRoomMembership(lapsedRoom(), "s1");
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(creditOf("s1"), 1);
  assert.ok(new Date(room().memberStatuses.s1.nextBillingAt).getTime() < Date.now());
});

// --- payload ----------------------------------------------------------------

test("room payloads project member and teacher docs to display fields", async () => {
  const projections = [];
  const spy = {
    find: (filter, options) => {
      projections.push(options?.projection);
      return { toArray: async () => [] };
    },
    aggregate: () => ({ toArray: async () => [] }),
  };
  const helpers = makeRoomHelpers({
    userCollection: spy,
    databaseinmongo: { collection: () => spy },
    studyRooms: spy,
    activepackages: spy,
    roomQuizzes: spy,
  });
  await helpers.hydrateStudyRoom(baseRoom({ teacherSessions: [{ teacherId: "t1" }] }));
  assert.equal(projections.length, 2);
  for (const projection of projections) {
    assert.ok(projection, "user lookups must be projected");
    for (const field of ["email", "FCMToken", "points", "totalPoints", "phone"]) {
      assert.ok(!projection[field], `${field} must not be shipped`);
    }
    assert.equal(projection.displayName, 1);
  }
});

test("the list payload says what joining costs", () => {
  const { helpers } = setup();
  assert.equal(helpers.hydrateStudyRoomLite(baseRoom()).joinCost, STUDY_ROOM_JOIN_CREDIT);
  assert.equal(helpers.hydrateStudyRoomLite(baseRoom({ freeAccess: true })).joinCost, 0);
  assert.equal(helpers.hydrateStudyRoomLite(baseRoom({ creditExpenseEnabled: false })).joinCost, 0);
});

// --- goal XP ----------------------------------------------------------------

const goal = (id, votes, extra = {}) => ({
  id,
  votes,
  createdBy: "s1",
  createdAt: new Date("2026-11-02T06:00:00Z"),
  ...extra,
});

test("self-confirmed goals earn no XP", () => {
  const room = {
    memberIds: ["s1"],
    progress: { goals: [goal("g1", { s1: true }), goal("g2", { s1: true })] },
  };
  assert.equal(countXpEligibleGoals(room, "s1"), 0);
});

test("goals confirmed by two members earn XP, capped per room per day", () => {
  const goals = Array.from({ length: ROOM_GOAL_XP_DAILY_CAP + 3 }, (_, index) =>
    goal(`g${index}`, { s1: true, s2: true })
  );
  const room = { memberIds: ["s1", "s2"], progress: { goals } };
  assert.equal(countXpEligibleGoals(room, "s1"), ROOM_GOAL_XP_DAILY_CAP);

  const nextDay = goal("later", { s1: true, s2: true }, { createdAt: new Date("2026-11-03T06:00:00Z") });
  assert.equal(countXpEligibleGoals({ ...room, progress: { goals: [...goals, nextDay] } }, "s1"), ROOM_GOAL_XP_DAILY_CAP + 1);
});

test("votes from people who left the room do not confirm a goal", () => {
  const room = { memberIds: ["s1"], progress: { goals: [goal("g1", { s1: true, gone: true })] } };
  assert.equal(countXpEligibleGoals(room, "s1"), 0);
});

test("teacher-set goals in teacher-controlled rooms count without peer votes", () => {
  const room = {
    memberIds: ["s1"],
    teacherControl: true,
    teacherSessions: [{ teacherId: "t1" }],
    progress: { goals: [goal("g1", { s1: true, t1: false }, { createdBy: "t1" })] },
  };
  assert.equal(countXpEligibleGoals(room, "s1"), 1);
  assert.equal(countXpEligibleGoals({ ...room, teacherControl: false }, "s1"), 0);
});

// --- announcement attachments -------------------------------------------------

test("announcement attachments must be this scope's own uploads", () => {
  const roomPath = "rooms/room-1/announcements/123_notes.pdf";
  const attachment = (path, url = `${BASE_URL}/${path}`) => ({ name: "notes.pdf", type: "application/pdf", path, url });

  const kept = sanitizeAnnouncementAttachments([attachment(roomPath)], { scope: "room", scopeId: "room-1" });
  assert.equal(kept.length, 1);

  const rejected = sanitizeAnnouncementAttachments(
    [
      attachment("rooms/room-2/announcements/x.pdf"), // another room's file
      attachment(roomPath, "https://evil.example/notes.pdf"), // outside link
      attachment(roomPath, `${BASE_URL}/rooms/room-1/announcements/other.pdf`), // url and path disagree
      attachment("rooms/room-1/announcements/../chats/x.pdf"),
    ],
    { scope: "room", scopeId: "room-1" }
  );
  assert.deepEqual(rejected, []);

  const coursePath = "announcements/course/course-1/1_a.png";
  const course = sanitizeAnnouncementAttachments(
    [{ name: "a.png", type: "image/png", path: coursePath, url: `${BASE_URL}/${coursePath}` }],
    { scope: "course", scopeId: "course-1" }
  );
  assert.equal(course.length, 1);
});
