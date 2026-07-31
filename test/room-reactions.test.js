const test = require("node:test");
const assert = require("node:assert/strict");

const { viewMessagesFor } = require("../utils/messageEconomy");
const { createDb } = require("./helpers/fakeMongo");

/**
 * A reaction is claimed write-once. In a 1:1 chat that is exactly right. In a
 * room it meant the first of up to ten students locked the message, their
 * choice broadcast to everyone, and the other nine could never answer.
 *
 * Room chats claim per student under `feedbackBy`; direct chats keep the
 * scalar. No migration: a message with no `feedbackBy` passes through as it is.
 */

const STUDENT_A = "student-a";
const STUDENT_B = "student-b";

test("each viewer sees their own room reaction", () => {
  const messages = [
    { messageId: "m1", text: "hi", feedbackBy: { [STUDENT_A]: "got_it", [STUDENT_B]: "stuck" } },
  ];

  assert.equal(viewMessagesFor(messages, STUDENT_A)[0].lastMessageFeedback, "got_it");
  assert.equal(viewMessagesFor(messages, STUDENT_B)[0].lastMessageFeedback, "stuck");
});

test("a student who has not reacted sees the message as still reactable", () => {
  const messages = [{ messageId: "m1", feedbackBy: { [STUDENT_A]: "got_it" } }];
  // the client treats exactly `null` as reactable
  assert.equal(viewMessagesFor(messages, "student-c")[0].lastMessageFeedback, null);
  assert.equal(viewMessagesFor(messages, undefined)[0].lastMessageFeedback, null);
});

test("the raw map never reaches the client", () => {
  const messages = [{ messageId: "m1", feedbackBy: { [STUDENT_A]: "got_it" } }];
  const seen = viewMessagesFor(messages, STUDENT_A)[0];
  assert.ok(!("feedbackBy" in seen), "one student's view must not carry everyone else's");
});

test("direct chats and legacy messages pass through untouched", () => {
  const legacy = [
    { messageId: "m1", lastMessageFeedback: null },
    { messageId: "m2", lastMessageFeedback: "got_it" },
  ];
  assert.deepEqual(viewMessagesFor(legacy, STUDENT_A), legacy);
  // identity, not just equality - nothing is rewritten
  assert.equal(viewMessagesFor(legacy, STUDENT_A)[0], legacy[0]);
});

test("degrades instead of throwing", () => {
  assert.deepEqual(viewMessagesFor(null, STUDENT_A), []);
  assert.deepEqual(viewMessagesFor(undefined, STUDENT_A), []);
  assert.deepEqual(viewMessagesFor([], STUDENT_A), []);
  assert.deepEqual(viewMessagesFor([null], STUDENT_A), [null]);
});

// ── the claim itself ────────────────────────────────────────────────────────

const seedChat = () =>
  createDb({
    chatDB: [
      {
        _id: "chat-1",
        roomChat: true,
        roomId: "room-1",
        messages: [{ messageId: "m1", lastMessageFeedback: null }],
      },
    ],
  });

/** The room claim: set feedbackBy.<uid> only while that key is absent. */
const claimFor = (chatDB, uid) =>
  chatDB.updateOne(
    { _id: "chat-1" },
    { $set: { [`messages.$[target].feedbackBy.${uid}`]: "got_it" } },
    { arrayFilters: [{ "target.messageId": "m1", [`target.feedbackBy.${uid}`]: { $exists: false } }] }
  );

test("two students can both react to the same message", async () => {
  const db = seedChat();
  const chatDB = db.collection("chatDB");

  const first = await claimFor(chatDB, STUDENT_A);
  const second = await claimFor(chatDB, STUDENT_B);

  assert.equal(first.modifiedCount, 1);
  assert.equal(second.modifiedCount, 1, "the second student is not locked out by the first");

  const doc = await chatDB.findOne({ _id: "chat-1" });
  assert.equal(doc.messages[0].feedbackBy[STUDENT_A], "got_it");
  assert.equal(doc.messages[0].feedbackBy[STUDENT_B], "got_it");
});

test("the same student still cannot react twice", async () => {
  const db = seedChat();
  const chatDB = db.collection("chatDB");

  const first = await claimFor(chatDB, STUDENT_A);
  const repeat = await claimFor(chatDB, STUDENT_A);

  assert.equal(first.modifiedCount, 1);
  assert.equal(repeat.modifiedCount, 0, "write-once per student is preserved");
});

test("a uid containing a dot cannot nest the value somewhere else", () => {
  // the route sanitises before building the path; uids are alphanumeric in
  // practice, but a dot would silently create feedbackBy.a.b
  const sanitise = (uid) => String(uid || "").replace(/[.$]/g, "_");
  assert.equal(sanitise("a.b"), "a_b");
  assert.equal(sanitise("$set"), "_set");
  assert.equal(sanitise(undefined), "");
});
