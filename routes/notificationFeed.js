const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");

module.exports = ({ databaseinmongo, userCollection, studyRooms }) => {
  const router = Router();
  const {
    createRoomNotification,
    getScopedNotifications,
    getUnreadCount,
    markNotificationsRead,
  } = makeNotificationHelpers({ databaseinmongo, userCollection, studyRooms });

  const getRoomAccess = async (roomId, userId) => {
    if (!ObjectId.isValid(roomId) || !userId) return { allowed: false };
    const room = await studyRooms.findOne({ _id: new ObjectId(roomId) });
    if (!room) return { allowed: false, status: 404, message: "Room not found." };
    const isStudent = (room.memberIds || []).includes(userId);
    const isTeacher = (room.teacherSessions || []).some((session) => session.teacherId === userId);
    return { allowed: isStudent || isTeacher, room };
  };

  const assertScopedAccess = async ({ scope, scopeId, userId }) => {
    if (scope !== "room") return { allowed: false, status: 400, message: "Unsupported notification scope." };
    return getRoomAccess(scopeId, userId);
  };

  router.get("/api/notifications", async (req, res) => {
    try {
      const { scope = "room", scopeId, userId, limit } = req.query;
      const access = await assertScopedAccess({ scope, scopeId, userId });
      if (!access.allowed)
        return res.status(access.status || 403).json({ error: access.message || "Not allowed." });

      const notifications = await getScopedNotifications({ scope, scopeId, userId, limit });
      const unreadCount = await getUnreadCount({ scope, scopeId, userId });
      res.json({ success: true, notifications, unreadCount });
    } catch (err) {
      console.error("Error fetching notifications:", err);
      res.status(500).json({ error: "Failed to fetch notifications." });
    }
  });

  router.get("/api/notifications/unread-count", async (req, res) => {
    try {
      const { scope = "room", scopeId, userId } = req.query;
      const access = await assertScopedAccess({ scope, scopeId, userId });
      if (!access.allowed)
        return res.status(access.status || 403).json({ error: access.message || "Not allowed." });

      const unreadCount = await getUnreadCount({ scope, scopeId, userId });
      res.json({ success: true, unreadCount });
    } catch (err) {
      console.error("Error fetching unread notification count:", err);
      res.status(500).json({ error: "Failed to fetch unread notifications." });
    }
  });

  router.patch("/api/notifications/read", async (req, res) => {
    try {
      const { scope = "room", scopeId, userId, notificationIds = [] } = req.body;
      const access = await assertScopedAccess({ scope, scopeId, userId });
      if (!access.allowed)
        return res.status(access.status || 403).json({ error: access.message || "Not allowed." });

      await markNotificationsRead({ scope, scopeId, userId, notificationIds });
      const unreadCount = await getUnreadCount({ scope, scopeId, userId });
      res.json({ success: true, unreadCount });
    } catch (err) {
      console.error("Error marking notifications read:", err);
      res.status(500).json({ error: "Failed to update notifications." });
    }
  });

  router.post("/api/announcements", async (req, res) => {
    try {
      const {
        scope = "room",
        scopeId,
        actorId,
        actorRole = "",
        title = "Announcement",
        message,
      } = req.body;
      const access = await assertScopedAccess({ scope, scopeId, userId: actorId });
      if (!access.allowed)
        return res.status(access.status || 403).json({ error: access.message || "Not allowed." });

      const cleanMessage = String(message || "").trim();
      if (!cleanMessage) return res.status(400).json({ error: "Announcement message is required." });

      const result = await createRoomNotification({
        room: access.room,
        type: "announcement",
        title: String(title || "Announcement").trim().slice(0, 80),
        message: cleanMessage,
        actorId,
        actorRole,
        metadata: { announcement: true },
      });

      res.status(201).json({ success: true, notificationCreated: result.ok });
    } catch (err) {
      console.error("Error creating announcement:", err);
      res.status(500).json({ error: "Failed to create announcement." });
    }
  });

  return router;
};
