const test = require("node:test");
const assert = require("node:assert/strict");

const { createCollection } = require("./helpers/fakeMongo");

/**
 * Guards the separation between a student's private chat with a teacher and the
 * room teacher chat they may share with that same teacher.
 *
 * Both live in the same `chats` array and both carry receiverId = teacherId
 * with receiverRole = "teacher", so a lookup on receiverId alone returns
 * whichever happens to sit first. A room teacher chat is subscribed by every
 * member of the room, so picking the wrong one publishes a message the student
 * believed was private.
 *
 * Mirrors the finder in the /chatExist route.
 */
const findDirectChat = (userChat, receiverId) =>
    (userChat?.chats || []).find(
        (chat) => chat.receiverId === receiverId && !chat.roomId && !chat.roomChat
    );

const TEACHER = "teacher-1";

const directEntry = (chatId = "direct-chat") => ({
    receiverRole: "teacher",
    yourRole: "teacher",
    chatId,
    receiverId: TEACHER,
    lastMessage: "",
});

const roomTeacherEntry = (chatId = "room-teacher-chat") => ({
    receiverRole: "teacher",
    yourRole: "teacher",
    chatId,
    receiverId: TEACHER,
    roomChat: true,
    roomId: "room-1",
    participantIds: ["student-1", "student-2", "student-3", TEACHER],
});

test("finds a direct chat when that is the only one", async () => {
    const chats = createCollection([{ _id: "student-1", chats: [directEntry()] }]);
    const found = findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER);
    assert.equal(found?.chatId, "direct-chat");
});

/**
 * The regression: the student joined the room first, so the room chat sits
 * earlier in the array and a receiverId-only match returned it.
 */
test("does not return the room teacher chat when it comes first", async () => {
    const chats = createCollection([
        { _id: "student-1", chats: [roomTeacherEntry(), directEntry()] },
    ]);
    const found = findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER);
    assert.equal(found?.chatId, "direct-chat", "picked the shared room chat over the private one");
});

test("reports no direct chat when only a room chat exists with that teacher", async () => {
    const chats = createCollection([{ _id: "student-1", chats: [roomTeacherEntry()] }]);
    const found = findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER);
    assert.equal(found, undefined, "a room chat must never be offered as a private one");
});

test("a room chat flagged only by roomChat is still excluded", async () => {
    const entry = roomTeacherEntry();
    delete entry.roomId;
    const chats = createCollection([{ _id: "student-1", chats: [entry] }]);
    assert.equal(findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER), undefined);
});

test("a room chat flagged only by roomId is still excluded", async () => {
    const entry = roomTeacherEntry();
    delete entry.roomChat;
    const chats = createCollection([{ _id: "student-1", chats: [entry] }]);
    assert.equal(findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER), undefined);
});

test("chats with other teachers are not returned", async () => {
    const chats = createCollection([
        { _id: "student-1", chats: [{ ...directEntry(), receiverId: "teacher-2" }] },
    ]);
    assert.equal(findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER), undefined);
});

test("a student with no chat document does not throw", async () => {
    // findOne returns null here; the route used to read .chats straight off it
    const chats = createCollection([]);
    const userChat = await chats.findOne({ _id: "brand-new-student" });
    assert.equal(userChat, null);
    assert.doesNotThrow(() => findDirectChat(userChat, TEACHER));
    assert.equal(findDirectChat(userChat, TEACHER), undefined);
});

test("a student with an empty chat list does not throw", async () => {
    const chats = createCollection([{ _id: "student-1", chats: [] }]);
    assert.equal(findDirectChat(await chats.findOne({ _id: "student-1" }), TEACHER), undefined);
});
