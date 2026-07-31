/**
 * What a chat message costs a student and earns a teacher.
 *
 * This used to live only in ChatBox.jsx: the client sent the message, then made
 * a second call telling the server how much to charge. That meant a closed tab
 * between the two calls sent the message for free, and the amounts were
 * whatever the client claimed. The server now owns the arithmetic; the client
 * keeps its own copy purely to warn "not enough credit" before sending.
 *
 * Mirrors the previous client behaviour exactly - changing prices means
 * changing both this file and getMessageCreditCost in ChatBox.jsx.
 */

const getVoiceCreditCost = (duration) =>
  Math.min(Math.max(Math.round(Number(duration) / 15), 1), 10);

const hasText = (text) => Boolean(String(text ?? "").trim());

/** Credit a student spends to send this message. */
const getMessageCreditCost = ({ text, hasImage, audioDuration = null, hasFile = false } = {}) => {
  let cost = 0;
  if (hasText(text)) cost += 2;
  if (hasImage) cost += 5;
  if (audioDuration !== null && audioDuration !== undefined && Number.isFinite(Number(audioDuration))) {
    cost += getVoiceCreditCost(audioDuration);
  }
  if (hasFile) cost += 5;
  return cost;
};

/** Points a teacher earns for sending this message. */
const getVoiceMessagePoints = (duration) => {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (seconds >= 8 && seconds <= 30) return 1;
  if (seconds > 30 && seconds <= 60) return 2;
  if (seconds > 60 && seconds <= 120) return 3;
  if (seconds > 120) return 5;
  return 0;
};

const getTextMessagePoints = (text) => {
  const length = String(text ?? "").trim().length;
  if (length <= 20) return 0;
  if (length <= 80) return 2;
  if (length <= 200) return 4;
  if (length <= 500) return 6;
  return 8;
};

const getMessageTeacherPoints = ({ text, hasImage, audioDuration = null, hasFile = false } = {}) => {
  let points = getTextMessagePoints(text);
  if (hasImage) points += 5;
  points += getVoiceMessagePoints(audioDuration);
  if (hasFile) points += 3;
  return points;
};

/**
 * Who pays for a message, derived from the sender and the chat rather than
 * from a client-supplied role.
 *
 * - teachers never spend credit, they earn points
 * - students pay in direct chats and in room *teacher* chats
 * - students-only room chat is free (see AGENTS.md)
 *
 * Every branch returns a `reason`. This used to return `charges` alone, and
 * three separate paths could turn a paid message into a free one - an unknown
 * sender role, a sender who is not a student, or the room scan missing the
 * chat - each storing the message with creditSpent: 0, HTTP 200 and no log.
 * "Free by design" and "free by accident" were indistinguishable, which is
 * exactly how a billing outage stayed invisible. The caller logs the reason.
 *
 * `chatType` is the chat document's own `type` and is authoritative. The room's
 * teacherSessions array is a parallel copy kept only as a fallback for chats
 * stored before `type` existed; keying billing off it meant any drift between
 * the two silently made a teacher free.
 */
const resolveMessageEconomy = ({
  senderRole,
  roomId = null,
  chatId = null,
  room = null,
  chatType = null,
} = {}) => {
  if (senderRole === "teacher") {
    return { charges: false, awardsPoints: true, reason: "teacher-earns-points" };
  }
  if (senderRole !== "student") {
    return {
      charges: false,
      awardsPoints: false,
      // not a normal state: every sender should have a role
      reason: senderRole ? "unknown-sender-role" : "sender-role-missing",
    };
  }

  if (!roomId) {
    return { charges: true, awardsPoints: false, reason: "direct-teacher-chat" };
  }

  if (chatType === "teacher") {
    return { charges: true, awardsPoints: false, reason: "room-teacher-chat" };
  }
  if (chatType === "students") {
    return { charges: false, awardsPoints: false, reason: "students-only-room-chat" };
  }

  // no `type` on the chat document - fall back to the room's copy
  const isRoomTeacherChat = (room?.teacherSessions || []).some(
    (session) => String(session.chatId) === String(chatId)
  );
  return {
    charges: isRoomTeacherChat,
    awardsPoints: false,
    reason: isRoomTeacherChat
      ? "room-teacher-chat-via-session"
      : "room-chat-not-in-teacher-sessions",
  };
};

/**
 * How many messages the teacher has sent since anyone else last spoke.
 *
 * The server used to count this differently from the client. It broke the run
 * only when the sender was in `room.memberIds`, and skipped anyone else without
 * breaking OR counting - so messages from a student who had since been removed
 * from the room (admin removal strips memberIds but leaves the messages) were
 * stepped straight over. The client breaks on the first message not from the
 * teacher. The two then disagree in both directions: the composer unlocks and
 * the send 429s, or the composer locks while the server would have allowed it.
 *
 * One definition, used by both: break on anyone who is not the teacher.
 */
const countConsecutiveTeacherMessages = (messages, teacherId) => {
  if (!teacherId || !Array.isArray(messages)) return 0;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.senderId !== teacherId) break;
    count += 1;
  }
  return count;
};

/**
 * Minutes since the last message in a chat, for the reply-window lock.
 * Returns null when there is nothing to measure from, which callers treat as
 * "no window to breach" rather than "infinitely late".
 */
const minutesSinceLastMessage = (messages, now = Date.now()) => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const at = new Date(last?.createdAt).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / 60000));
};

module.exports = {
  getVoiceCreditCost,
  countConsecutiveTeacherMessages,
  minutesSinceLastMessage,
  getMessageCreditCost,
  getVoiceMessagePoints,
  getTextMessagePoints,
  getMessageTeacherPoints,
  resolveMessageEconomy,
};
