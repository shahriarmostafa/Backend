const test = require("node:test");
const assert = require("node:assert/strict");

const { makeRoomHelpers } = require("../utils/roomHelpers");

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

/**
 * Counts every query the helpers issue. The point of hydrateStudyRoomLite is
 * that this stays at zero: the full hydrator fans out four queries per room,
 * and the list route ran it over 50 rooms twice per page load.
 */
const makeCountingHelpers = () => {
  const queries = [];
  const spy = (name) => ({
    find: (filter) => {
      queries.push({ name, op: "find", filter });
      return { toArray: async () => [] };
    },
    aggregate: (pipeline) => {
      queries.push({ name, op: "aggregate", pipeline });
      return { toArray: async () => [] };
    },
    findOne: async (filter) => {
      queries.push({ name, op: "findOne", filter });
      return null;
    },
  });

  const helpers = makeRoomHelpers({
    userCollection: spy("userCollection"),
    databaseinmongo: { collection: (name) => spy(name) },
    studyRooms: spy("studyRooms"),
    activepackages: spy("activepackages"),
    roomQuizzes: spy("roomQuizzes"),
  });

  return { helpers, queries };
};

const room = (overrides = {}) => ({
  _id: { toString: () => "room-1" },
  name: "Brazil",
  keyword: "BRAZIL1",
  category: "university",
  type: "english_medium",
  visibility: "public",
  memberIds: ["student-1", "student-2"],
  maxStudents: 8,
  memberStatuses: {
    "student-1": { isActive: true, nextBillingAt: new Date(NOW + 20 * DAY).toISOString() },
    "student-2": { isActive: true, nextBillingAt: new Date(NOW - DAY).toISOString() },
  },
  createdAt: new Date(NOW - 30 * DAY).toISOString(),
  // things the card never reads and the lite shape must not ship
  chats: [{ chatId: "c1" }, { chatId: "c2" }],
  progress: { goals: [{ id: "g1", votes: { "student-1": true } }] },
  teacherSessions: [{ chatId: "c2", teacherId: "teacher-1" }],
  ...overrides,
});

test("the lite hydrator issues no queries at all", () => {
  const { helpers, queries } = makeCountingHelpers();
  helpers.hydrateStudyRoomLite(room());
  assert.equal(queries.length, 0);
});

test("it carries every field a room card renders", () => {
  const { helpers } = makeCountingHelpers();
  const lite = helpers.hydrateStudyRoomLite(room());

  // exactly what Rooms.jsx reads off a room object
  for (const key of [
    "id", "name", "keyword", "category", "type",
    "visibility", "memberIds", "memberCount", "memberStatuses", "maxStudents",
  ]) {
    assert.ok(key in lite, `missing ${key}`);
  }
  assert.equal(lite.id, "room-1");
  assert.equal(lite.memberCount, 2);
  assert.equal(lite.maxStudents, 8);
});

test("it ships none of the heavy fields the card never reads", () => {
  const { helpers } = makeCountingHelpers();
  const lite = helpers.hydrateStudyRoomLite(room());
  for (const key of ["members", "progress", "teacherSessions", "chats"]) {
    assert.ok(!(key in lite), `${key} should not be in the list payload`);
  }
});

test("membership status matches what the full hydrator would compute", () => {
  const { helpers } = makeCountingHelpers();
  const lite = helpers.hydrateStudyRoomLite(room());
  // billing in the future -> active; billing in the past -> lapsed
  assert.equal(lite.memberStatuses["student-1"].isActive, true);
  assert.equal(lite.memberStatuses["student-2"].isActive, false);
});

test("freeAccess and creditExpenseEnabled still reach the membership check", () => {
  const { helpers } = makeCountingHelpers();
  // both are in STUDY_ROOM_LIST_PROJECTION for exactly this reason - drop either
  // and a lapsed-but-free member would read as inactive in the list only
  const lapsed = room({ freeAccess: true });
  assert.equal(helpers.hydrateStudyRoomLite(lapsed).memberStatuses["student-2"].isActive, true);

  const noCredit = room({ creditExpenseEnabled: false });
  assert.equal(helpers.hydrateStudyRoomLite(noCredit).memberStatuses["student-2"].isActive, true);
});

test("the projection covers every field the lite hydrator reads", () => {
  const { helpers } = makeCountingHelpers();
  const projection = helpers.STUDY_ROOM_LIST_PROJECTION;
  for (const key of [
    "name", "keyword", "category", "type", "visibility",
    "memberIds", "maxStudents", "memberStatuses",
    "freeAccess", "creditExpenseEnabled", "createdAt",
  ]) {
    assert.equal(projection[key], 1, `projection is missing ${key}`);
  }
  // _id is implicit in Mongo and is what `id` derives from
  assert.ok(!("_id" in projection) || projection._id !== 0);
});

test("a missing or empty room degrades instead of throwing", () => {
  const { helpers } = makeCountingHelpers();
  assert.equal(helpers.hydrateStudyRoomLite(null), null);
  assert.equal(helpers.hydrateStudyRoomLite(undefined), null);

  const bare = helpers.hydrateStudyRoomLite({ _id: { toString: () => "r" } });
  assert.deepEqual(bare.memberIds, []);
  assert.equal(bare.memberCount, 0);
  assert.deepEqual(bare.memberStatuses, {});
  assert.ok(bare.maxStudents > 0, "falls back to the configured room size");
});
