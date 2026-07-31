const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./helpers/fakeMongo");

/**
 * The unread counter is denormalised into each participant's chat entry as the
 * message is stored, because messages carry no per-user read marker and the
 * chat-list hydrator never opens the message collection at all.
 *
 * These exercise the update shapes /sendMessage and /mark-chat-as-seen issue,
 * against the same fake Mongo the money tests use - which rejects a path named
 * under two operators, the rule that broke reactions for months.
 */

const SENDER = "student-1";
const RECEIVER = "teacher-1";
const CHAT = "chat-1";

const seed = () =>
  createDb({
    chatCollection: [
      { _id: SENDER, chats: [{ chatId: CHAT, isSeen: true, unreadCount: 0 }] },
      { _id: RECEIVER, chats: [{ chatId: CHAT, isSeen: true, unreadCount: 0 }] },
    ],
  });

/** Exactly what routes/chat.js issues per participant after storing a message. */
const applySend = async (chatCollection, senderId, participantIds) => {
  for (const id of participantIds) {
    const isSender = id === senderId;
    await chatCollection.updateOne(
      { _id: id, "chats.chatId": CHAT },
      {
        $set: {
          "chats.$.lastMessage": "hi",
          "chats.$.isSeen": isSender,
          "chats.$.lastMessageFeedback": null,
          "chats.$.updatedAt": 1,
          ...(isSender && { "chats.$.unreadCount": 0 }),
        },
        ...(!isSender && { $inc: { "chats.$.unreadCount": 1 } }),
      }
    );
  }
};

const entryFor = async (db, uid) =>
  (await db.collection("chatCollection").findOne({ _id: uid })).chats[0];

test("each message increments the receiver and leaves the sender at zero", async () => {
  const db = seed();
  const chats = db.collection("chatCollection");

  await applySend(chats, SENDER, [SENDER, RECEIVER]);
  await applySend(chats, SENDER, [SENDER, RECEIVER]);
  await applySend(chats, SENDER, [SENDER, RECEIVER]);

  assert.equal((await entryFor(db, RECEIVER)).unreadCount, 3);
  assert.equal((await entryFor(db, SENDER)).unreadCount, 0);
  assert.equal((await entryFor(db, RECEIVER)).isSeen, false);
  assert.equal((await entryFor(db, SENDER)).isSeen, true);
});

test("opening the chat clears the count", async () => {
  const db = seed();
  const chats = db.collection("chatCollection");
  await applySend(chats, SENDER, [SENDER, RECEIVER]);
  await applySend(chats, SENDER, [SENDER, RECEIVER]);

  // /mark-chat-as-seen, positional rather than rewriting the whole array
  await chats.updateOne(
    { _id: RECEIVER, "chats.chatId": CHAT },
    { $set: { "chats.$.isSeen": true, "chats.$.unreadCount": 0 } }
  );

  assert.equal((await entryFor(db, RECEIVER)).unreadCount, 0);
  assert.equal((await entryFor(db, RECEIVER)).isSeen, true);
});

test("a reply resets the other side rather than accumulating on both", async () => {
  const db = seed();
  const chats = db.collection("chatCollection");

  await applySend(chats, SENDER, [SENDER, RECEIVER]);
  await applySend(chats, RECEIVER, [SENDER, RECEIVER]);

  assert.equal((await entryFor(db, RECEIVER)).unreadCount, 0, "replying marks yours read");
  assert.equal((await entryFor(db, SENDER)).unreadCount, 1);
});

test("the send update names no path under two operators", async () => {
  const db = seed();
  const chats = db.collection("chatCollection");
  // $set carries unreadCount only for the sender and $inc only for everyone
  // else, so the two never collide - Mongo would reject the whole update
  await assert.doesNotReject(() => applySend(chats, SENDER, [SENDER, RECEIVER]));
});

test("an entry written before the counter existed starts from zero, not NaN", async () => {
  const db = createDb({
    chatCollection: [{ _id: RECEIVER, chats: [{ chatId: CHAT, isSeen: true }] }],
  });
  const chats = db.collection("chatCollection");

  await applySend(chats, SENDER, [RECEIVER]);
  assert.equal((await entryFor(db, RECEIVER)).unreadCount, 1);
});

test("the badge sums counts across chats", () => {
  // mirrors hydrateChatListForUser's unseenCount and ChatListProvider
  const sum = (list) =>
    list.reduce((total, chat) => total + (Number(chat.unreadCount) || 0), 0);

  assert.equal(sum([{ unreadCount: 3 }, { unreadCount: 2 }, { unreadCount: 0 }]), 5);
  assert.equal(sum([{ isSeen: false }, { unreadCount: undefined }]), 0);
  assert.equal(sum([]), 0);
});
