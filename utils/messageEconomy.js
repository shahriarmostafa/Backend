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
 */
const resolveMessageEconomy = ({ senderRole, roomId = null, chatId = null, room = null } = {}) => {
  if (senderRole === "teacher") return { charges: false, awardsPoints: true };
  if (senderRole !== "student") return { charges: false, awardsPoints: false };

  if (!roomId) return { charges: true, awardsPoints: false };

  const isRoomTeacherChat = (room?.teacherSessions || []).some(
    (session) => String(session.chatId) === String(chatId)
  );
  return { charges: isRoomTeacherChat, awardsPoints: false };
};

module.exports = {
  getVoiceCreditCost,
  getMessageCreditCost,
  getVoiceMessagePoints,
  getTextMessagePoints,
  getMessageTeacherPoints,
  resolveMessageEconomy,
};
