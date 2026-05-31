const { ObjectId } = require("mongodb");

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

const makeNotificationHelpers = ({ databaseinmongo, userCollection, studyRooms }) => {
  const notifications = databaseinmongo.collection("notifications");
  const roomsCollection = studyRooms || databaseinmongo.collection("studyRooms");

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
    getRoomNotificationRecipients,
    getScopedNotifications,
    getUnreadCount,
    markNotificationsRead,
  };
};

module.exports = { makeNotificationHelpers, getRoomNotificationRecipients };
