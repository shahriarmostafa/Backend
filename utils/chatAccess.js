/**
 * Who belongs to a chat.
 *
 * Every participant - both sides of a direct chat, and each subscribed room
 * member or teacher - has an entry for the chat in their own `chatCollection`
 * document. That entry is the membership record the socket already trusts, so
 * the REST routes check the same thing.
 */

/** The caller's own chat-list entry for this chat, or null if they are not in it. */
const findChatEntry = async (databaseinmongo, uid, chatId) => {
  if (!uid || !chatId) return null;
  const doc = await databaseinmongo
    .collection("chatCollection")
    .findOne({ _id: uid }, { projection: { chats: 1 } });
  return (doc?.chats || []).find((entry) => String(entry.chatId) === String(chatId)) || null;
};

/** The direct (non-room) chat between two people, from the first person's list. */
const findDirectChatEntry = async (databaseinmongo, uid, otherUid) => {
  if (!uid || !otherUid) return null;
  const doc = await databaseinmongo
    .collection("chatCollection")
    .findOne({ _id: uid }, { projection: { chats: 1 } });
  return (
    (doc?.chats || []).find(
      (entry) => entry.receiverId === otherUid && !entry.roomId && !entry.roomChat
    ) || null
  );
};

/**
 * Whether a user may join a call's audio channel or whiteboard.
 *
 * Channel names are a chatId (direct and room calls) or
 * `course_<courseId>_<sessionId>` (course classes). Tokens used to be minted
 * for any channel name to anyone signed in.
 */
const canUseCallChannel = async (databaseinmongo, uid, channelName) => {
  if (!uid || !channelName || typeof channelName !== "string") return false;
  const { ObjectId } = require("mongodb");

  const courseMatch = /^course_([a-f0-9]{24})_(.+)$/i.exec(channelName);
  if (courseMatch) {
    const course = await databaseinmongo.collection("courses").findOne({ _id: new ObjectId(courseMatch[1]) });
    if (!course) return false;
    if (course.teacherId === uid) return true;
    const courseHelpers = require("./courseHelpers");
    if (typeof courseHelpers.hasCourseSessionAccess === "function") {
      return Boolean(courseHelpers.hasCourseSessionAccess(course, uid, courseMatch[2]));
    }
    return (course.enrollments || []).some(
      (enrollment) => (enrollment.studentId || enrollment.student?.uid) === uid
    );
  }

  if (!ObjectId.isValid(channelName)) return false;
  if (await findChatEntry(databaseinmongo, uid, channelName)) return true;

  // A room member whose chat list has not been hydrated yet has no entry.
  const chat = await databaseinmongo
    .collection("chatDB")
    .findOne({ _id: new ObjectId(channelName) }, { projection: { roomChat: 1, roomId: 1 } });
  if (!chat?.roomChat || !chat.roomId || !ObjectId.isValid(String(chat.roomId))) return false;
  const room = await databaseinmongo
    .collection("studyRooms")
    .findOne({ _id: new ObjectId(String(chat.roomId)) }, { projection: { memberIds: 1, teacherSessions: 1 } });
  return Boolean(
    room &&
      ((room.memberIds || []).includes(uid) ||
        (room.teacherSessions || []).some((session) => session.teacherId === uid))
  );
};

module.exports = { findChatEntry, findDirectChatEntry, canUseCallChannel };
