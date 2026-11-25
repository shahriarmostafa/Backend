const { ObjectId } = require("mongodb");
const { extractStoragePath, isStoragePathWithin, normalizePath } = require("./r2Storage");

const ALLOWED_ANNOUNCEMENT_FILE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * The storage folder announcement files for a scope are uploaded to - the same
 * paths AnnouncementComposer.jsx builds.
 */
const getAnnouncementFolder = (scope, scopeId) => {
  const id = String(scopeId || "").trim();
  if (!scope || !id || id.includes("/") || id.includes("..")) return "";
  return scope === "room" ? `rooms/${id}/announcements` : `announcements/${scope}/${id}`;
};

/**
 * Attachments come straight from the client and are shown to every member as
 * links. Only files inside this scope's announcement folder, whose URL is our
 * own storage URL for that same file, are kept - anything else (an outside
 * link, another room's file) is dropped.
 */
const sanitizeAnnouncementAttachments = (attachments = [], { scope, scopeId } = {}) => {
  if (!Array.isArray(attachments)) return [];
  const folder = getAnnouncementFolder(scope, scopeId);
  if (!folder) return [];
  return attachments
    .slice(0, 5)
    .map((attachment) => ({
      name: String(attachment?.name || "Attachment").trim().slice(0, 120),
      url: String(attachment?.url || "").trim(),
      path: normalizePath(String(attachment?.path || "").trim()),
      type: String(attachment?.type || "").trim(),
      size: Math.max(0, Number(attachment?.size) || 0),
    }))
    .filter((attachment) => {
      if (!attachment.url || !attachment.path) return false;
      if (!isStoragePathWithin(attachment.path, folder)) return false;
      const urlPath = extractStoragePath(attachment.url);
      if (!urlPath || normalizePath(urlPath) !== attachment.path) return false;
      if (ALLOWED_ANNOUNCEMENT_FILE_TYPES.has(attachment.type)) return true;
      const name = attachment.name.toLowerCase();
      return /\.(jpe?g|png|webp|gif|pdf|docx|pptx)$/.test(name);
    });
};

const asStringId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.toString) return value.toString();
  return "";
};

const uniqueIds = (items = []) => [...new Set(items.map(asStringId).filter(Boolean))];

const getRoomNotificationRecipients = (room = {}) => {
  const studentIds = Array.isArray(room.memberIds) ? room.memberIds : [];
  const teacherIds = (room.teacherSessions || []).map((session) => session.teacherId);
  return uniqueIds([...studentIds, ...teacherIds]);
};

const getCourseNotificationRecipients = (course = {}) => {
  const studentIds = (course.enrollments || [])
    .filter((enrollment) => enrollment.status !== "cancelled")
    .map((enrollment) => enrollment.studentId);
  return uniqueIds([course.teacherId, ...studentIds]);
};

const makeNotificationHelpers = ({ databaseinmongo, userCollection, studyRooms, courses }) => {
  const notifications = databaseinmongo.collection("notifications");
  const roomsCollection = studyRooms || databaseinmongo.collection("studyRooms");
  const coursesCollection = courses || databaseinmongo.collection("courses");

  const getActorSnapshot = async (actorId) => {
    if (!actorId || !userCollection) return null;
    const actor = await userCollection.findOne(
      { $or: [{ uid: actorId }, { _id: ObjectId.isValid(actorId) ? new ObjectId(actorId) : actorId }] },
      { projection: { uid: 1, displayName: 1, name: 1, photoURL: 1, role: 1 } }
    );
    if (!actor) return null;
    return {
      uid: actor.uid || asStringId(actor._id),
      name: actor.displayName || actor.name || "PoperL user",
      photoURL: actor.photoURL || "",
      role: actor.role || "",
    };
  };

  const createNotification = async ({
    scope,
    scopeId,
    type,
    title,
    message = "",
    actorId = "",
    actorRole = "",
    recipients = [],
    metadata = {},
    dedupeKey = "",
  }) => {
    const cleanRecipients = uniqueIds(recipients);
    if (!scope || !scopeId || !type || !title || !cleanRecipients.length) {
      return { ok: false, reason: "missing_notification_fields" };
    }

    const actor = await getActorSnapshot(actorId);
    const now = new Date();
    const doc = {
      scope,
      scopeId: asStringId(scopeId),
      type,
      title: String(title).trim().slice(0, 120),
      message: String(message || "").trim().slice(0, 500),
      actorId: actorId || "",
      actorRole: actorRole || actor?.role || "",
      actor,
      recipients: cleanRecipients,
      readBy: actorId && cleanRecipients.includes(actorId) ? [actorId] : [],
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    if (dedupeKey) {
      await notifications.updateOne(
        { dedupeKey },
        { $setOnInsert: { ...doc, dedupeKey } },
        { upsert: true }
      );
      return { ok: true, deduped: true };
    }

    const result = await notifications.insertOne(doc);
    return { ok: true, insertedId: result.insertedId };
  };

  const createRoomNotification = async ({
    room,
    roomId,
    type,
    title,
    message = "",
    actorId = "",
    actorRole = "",
    metadata = {},
    dedupeKey = "",
  }) => {
    const targetRoom =
      room ||
      (ObjectId.isValid(roomId)
        ? await roomsCollection.findOne({ _id: new ObjectId(roomId) })
        : null);
    if (!targetRoom) return { ok: false, reason: "room_not_found" };

    return createNotification({
      scope: "room",
      scopeId: asStringId(targetRoom._id),
      type,
      title,
      message,
      actorId,
      actorRole,
      recipients: getRoomNotificationRecipients(targetRoom),
      metadata: { roomId: asStringId(targetRoom._id), roomName: targetRoom.name || "", ...metadata },
      dedupeKey,
    });
  };

  const createCourseNotification = async ({
    course,
    courseId,
    type,
    title,
    message = "",
    actorId = "",
    actorRole = "",
    metadata = {},
    dedupeKey = "",
  }) => {
    const targetCourse =
      course ||
      (ObjectId.isValid(courseId)
        ? await coursesCollection.findOne({ _id: new ObjectId(courseId) })
        : null);
    if (!targetCourse) return { ok: false, reason: "course_not_found" };

    return createNotification({
      scope: "course",
      scopeId: asStringId(targetCourse._id),
      type,
      title,
      message,
      actorId,
      actorRole,
      recipients: getCourseNotificationRecipients(targetCourse),
      metadata: { courseId: asStringId(targetCourse._id), courseTitle: targetCourse.title || "", ...metadata },
      dedupeKey,
    });
  };

  const getScopedNotifications = async ({ scope, scopeId, userId, limit = 80 }) => {
    const items = await notifications
      .find({ scope, scopeId: asStringId(scopeId), recipients: userId })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(Number(limit) || 80, 1), 150))
      .toArray();

    return items.map((item) => ({
      id: asStringId(item._id),
      scope: item.scope,
      scopeId: item.scopeId,
      type: item.type,
      title: item.title,
      message: item.message,
      actor: item.actor || null,
      actorId: item.actorId || "",
      actorRole: item.actorRole || "",
      metadata: item.metadata || {},
      createdAt: item.createdAt,
      isRead: (item.readBy || []).includes(userId),
    }));
  };

  const getUnreadCount = ({ scope, scopeId, userId }) =>
    notifications.countDocuments({
      scope,
      scopeId: asStringId(scopeId),
      recipients: userId,
      readBy: { $ne: userId },
    });

  const markNotificationsRead = ({ scope, scopeId, userId, notificationIds = [] }) => {
    const filter = {
      scope,
      scopeId: asStringId(scopeId),
      recipients: userId,
      readBy: { $ne: userId },
    };
    if (Array.isArray(notificationIds) && notificationIds.length) {
      filter._id = { $in: notificationIds.filter(ObjectId.isValid).map((id) => new ObjectId(id)) };
    }

    return notifications.updateMany(filter, {
      $addToSet: { readBy: userId },
      $set: { updatedAt: new Date() },
    });
  };

  return {
    createNotification,
    createRoomNotification,
    createCourseNotification,
    getRoomNotificationRecipients,
    getCourseNotificationRecipients,
    getScopedNotifications,
    getUnreadCount,
    markNotificationsRead,
  };
};

module.exports = {
  makeNotificationHelpers,
  getRoomNotificationRecipients,
  getCourseNotificationRecipients,
  sanitizeAnnouncementAttachments,
  getAnnouncementFolder,
};
