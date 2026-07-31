const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveMessageEconomy,
  countConsecutiveTeacherMessages,
  minutesSinceLastMessage,
} = require("../utils/messageEconomy");

const TEACHER = "teacher-1";
const STUDENT = "student-1";
const EX_MEMBER = "student-removed";

// ── who pays, and WHY ───────────────────────────────────────────────────────
// Every branch reports a reason. Three of them mean a paid message was stored
// for free because something was missing rather than because the rules say so,
// and those used to be indistinguishable from a legitimate free send.

test("a teacher never pays and earns points", () => {
  const e = resolveMessageEconomy({ senderRole: "teacher" });
  assert.equal(e.charges, false);
  assert.equal(e.awardsPoints, true);
  assert.equal(e.reason, "teacher-earns-points");
});

test("a student pays in a direct chat", () => {
  const e = resolveMessageEconomy({ senderRole: "student" });
  assert.equal(e.charges, true);
  assert.equal(e.reason, "direct-teacher-chat");
});

test("the chat document's own type decides a room chat, not the room's copy", () => {
  // A room whose teacherSessions has drifted - the chat is still a teacher chat
  const roomWithNoSessions = { teacherSessions: [] };

  const paid = resolveMessageEconomy({
    senderRole: "student", roomId: "r1", chatId: "c1",
    room: roomWithNoSessions, chatType: "teacher",
  });
  assert.equal(paid.charges, true, "drifted teacherSessions must not make a teacher free");
  assert.equal(paid.reason, "room-teacher-chat");

  const free = resolveMessageEconomy({
    senderRole: "student", roomId: "r1", chatId: "c1",
    room: { teacherSessions: [{ chatId: "c1" }] }, chatType: "students",
  });
  assert.equal(free.charges, false, "students-only stays free even if listed as a session");
  assert.equal(free.reason, "students-only-room-chat");
});

test("a chat with no type falls back to the room's session list", () => {
  const viaSession = resolveMessageEconomy({
    senderRole: "student", roomId: "r1", chatId: "c1",
    room: { teacherSessions: [{ chatId: "c1" }] },
  });
  assert.equal(viaSession.charges, true);
  assert.equal(viaSession.reason, "room-teacher-chat-via-session");
});

test("the three fail-open paths are each named", () => {
  assert.equal(
    resolveMessageEconomy({ senderRole: undefined }).reason,
    "sender-role-missing"
  );
  assert.equal(
    resolveMessageEconomy({ senderRole: "owner" }).reason,
    "unknown-sender-role"
  );
  const orphan = resolveMessageEconomy({
    senderRole: "student", roomId: "r1", chatId: "c9", room: { teacherSessions: [] },
  });
  assert.equal(orphan.charges, false);
  assert.equal(orphan.reason, "room-chat-not-in-teacher-sessions");
});

// ── the consecutive-message rule ────────────────────────────────────────────

const msg = (senderId, createdAt) => ({ senderId, createdAt });

test("counts only the trailing run of teacher messages", () => {
  const messages = [msg(TEACHER), msg(STUDENT), msg(TEACHER), msg(TEACHER)];
  assert.equal(countConsecutiveTeacherMessages(messages, TEACHER), 2);
});

// The regression this file exists for. The server used to break the run only on
// a current room member and step over anyone else without counting them, while
// the client broke on the first non-teacher message.
test("anyone who is not the teacher breaks the run, including an ex-member", () => {
  const messages = [msg(TEACHER), msg(TEACHER), msg(TEACHER), msg(EX_MEMBER)];
  assert.equal(
    countConsecutiveTeacherMessages(messages, TEACHER), 0,
    "an ex-member's reply resets the count, as the composer already assumes"
  );

  const between = [msg(TEACHER), msg(TEACHER), msg(EX_MEMBER), msg(TEACHER)];
  assert.equal(
    countConsecutiveTeacherMessages(between, TEACHER), 1,
    "messages before someone else spoke are not summed across them"
  );
});

test("degrades instead of throwing on missing input", () => {
  assert.equal(countConsecutiveTeacherMessages([], TEACHER), 0);
  assert.equal(countConsecutiveTeacherMessages(null, TEACHER), 0);
  assert.equal(countConsecutiveTeacherMessages(undefined, TEACHER), 0);
  assert.equal(countConsecutiveTeacherMessages([msg(TEACHER)], null), 0);
  assert.equal(countConsecutiveTeacherMessages([{}, {}], TEACHER), 0);
});

// ── the reply window ────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

test("measures from the last message", () => {
  const messages = [
    msg(STUDENT, new Date(NOW - 600 * MIN).toISOString()),
    msg(STUDENT, new Date(NOW - 45 * MIN).toISOString()),
  ];
  assert.equal(minutesSinceLastMessage(messages, NOW), 45);
});

test("an empty or unparseable history is not treated as infinitely late", () => {
  // null means "no window to breach" - a teacher must not be locked out of a
  // chat that has no messages to be late to
  assert.equal(minutesSinceLastMessage([], NOW), null);
  assert.equal(minutesSinceLastMessage(null, NOW), null);
  assert.equal(minutesSinceLastMessage([msg(STUDENT, "not a date")], NOW), null);
  assert.equal(minutesSinceLastMessage([msg(STUDENT, undefined)], NOW), null);
});

test("a clock skew into the future clamps to zero rather than going negative", () => {
  const future = [msg(STUDENT, new Date(NOW + 5 * MIN).toISOString())];
  assert.equal(minutesSinceLastMessage(future, NOW), 0);
});

test("the room and direct windows are the ones the composer uses", () => {
  const {
    TEACHER_REPLY_WINDOW_ROOM_MINUTES,
    TEACHER_REPLY_WINDOW_DIRECT_MINUTES,
    TEACHER_CONSECUTIVE_MESSAGE_LIMIT,
  } = require("../utils/constants");
  assert.equal(TEACHER_REPLY_WINDOW_ROOM_MINUTES, 6 * 60);
  assert.equal(TEACHER_REPLY_WINDOW_DIRECT_MINUTES, 20);
  assert.equal(TEACHER_CONSECUTIVE_MESSAGE_LIMIT, 3);
});
