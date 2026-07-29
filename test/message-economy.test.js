const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMessageCreditCost,
  getMessageTeacherPoints,
  getVoiceCreditCost,
  resolveMessageEconomy,
} = require("../utils/messageEconomy");

test("an empty message costs nothing", () => {
  assert.equal(getMessageCreditCost({ text: "" }), 0);
  assert.equal(getMessageCreditCost({ text: "   " }), 0);
  assert.equal(getMessageCreditCost({}), 0);
});

test("text, image and file are each priced", () => {
  assert.equal(getMessageCreditCost({ text: "hello" }), 2);
  assert.equal(getMessageCreditCost({ hasImage: true }), 5);
  assert.equal(getMessageCreditCost({ hasFile: true }), 5);
  assert.equal(getMessageCreditCost({ text: "hi", hasImage: true, hasFile: true }), 12);
});

test("voice credit scales with length inside fixed bounds", () => {
  assert.equal(getVoiceCreditCost(1), 1, "a very short note still costs the minimum");
  assert.equal(getVoiceCreditCost(15), 1);
  assert.equal(getVoiceCreditCost(150), 10);
  assert.equal(getVoiceCreditCost(9999), 10, "a long note is capped");
});

test("voice duration is only charged when there is audio", () => {
  assert.equal(getMessageCreditCost({ text: "hi", audioDuration: null }), 2);
  assert.equal(getMessageCreditCost({ text: "hi", audioDuration: 30 }), 4);
});

test("a garbage duration does not produce a NaN charge", () => {
  for (const value of ["abc", NaN, {}, undefined]) {
    const cost = getMessageCreditCost({ text: "hi", audioDuration: value });
    assert.ok(Number.isFinite(cost), `${String(value)} gave ${cost}`);
    assert.equal(cost, 2);
  }
});

test("credit cost is never negative", () => {
  assert.ok(getMessageCreditCost({ text: "hi", audioDuration: -50 }) >= 0);
});

test("teacher points scale with reply length", () => {
  assert.equal(getMessageTeacherPoints({ text: "short" }), 0, "a token reply earns nothing");
  assert.equal(getMessageTeacherPoints({ text: "x".repeat(50) }), 2);
  assert.equal(getMessageTeacherPoints({ text: "x".repeat(150) }), 4);
  assert.equal(getMessageTeacherPoints({ text: "x".repeat(400) }), 6);
  assert.equal(getMessageTeacherPoints({ text: "x".repeat(900) }), 8);
});

test("teacher points never decrease as a reply gets longer", () => {
  let previous = 0;
  for (let length = 0; length <= 1200; length += 10) {
    const points = getMessageTeacherPoints({ text: "x".repeat(length) });
    assert.ok(points >= previous, `dropped at length ${length}`);
    previous = points;
  }
});

test("attachments add to teacher points", () => {
  assert.equal(getMessageTeacherPoints({ text: "", hasImage: true }), 5);
  assert.equal(getMessageTeacherPoints({ text: "", hasFile: true }), 3);
  assert.equal(getMessageTeacherPoints({ text: "", audioDuration: 20 }), 1);
  assert.equal(getMessageTeacherPoints({ text: "", audioDuration: 200 }), 5);
});

test("a voice note too short to count earns nothing", () => {
  assert.equal(getMessageTeacherPoints({ text: "", audioDuration: 3 }), 0);
});

// --- who pays ---

test("a teacher never spends credit and always earns points", () => {
  const economy = resolveMessageEconomy({ senderRole: "teacher" });
  assert.equal(economy.charges, false);
  assert.equal(economy.awardsPoints, true);
});

test("a student pays in a direct chat", () => {
  const economy = resolveMessageEconomy({ senderRole: "student" });
  assert.equal(economy.charges, true);
  assert.equal(economy.awardsPoints, false);
});

test("a student pays in a room teacher chat", () => {
  const economy = resolveMessageEconomy({
    senderRole: "student",
    roomId: "room-1",
    chatId: "chat-1",
    room: { teacherSessions: [{ teacherId: "t1", chatId: "chat-1" }] },
  });
  assert.equal(economy.charges, true);
});

test("students-only room chat is free", () => {
  // AGENTS.md: students-only room chat is free
  const economy = resolveMessageEconomy({
    senderRole: "student",
    roomId: "room-1",
    chatId: "students-chat",
    room: { teacherSessions: [{ teacherId: "t1", chatId: "some-other-chat" }] },
  });
  assert.equal(economy.charges, false);
});

test("a room with no teacher sessions charges nobody", () => {
  const economy = resolveMessageEconomy({
    senderRole: "student",
    roomId: "room-1",
    chatId: "chat-1",
    room: {},
  });
  assert.equal(economy.charges, false);
});

test("an unknown sender role neither pays nor earns", () => {
  const economy = resolveMessageEconomy({ senderRole: undefined });
  assert.equal(economy.charges, false);
  assert.equal(economy.awardsPoints, false);
});
