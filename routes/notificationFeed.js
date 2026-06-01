const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");

const ALLOWED_ANNOUNCEMENT_FILE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const sanitizeAnnouncementAttachments = (attachments = []) => {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .slice(0, 5)
    .map((attachment) => ({
      name: String(attachment?.name || "Attachment").trim().slice(0, 120),
      url: String(attachment?.url || "").trim(),
      path: String(attachment?.path || "").trim(),
      type: String(attachment?.type || "").trim(),
      size: Math.max(0, Number(attachment?.size) || 0),
    }))
    .filter((attachment) => {
      if (!attachment.url || !attachment.path) return false;
      if (ALLOWED_ANNOUNCEMENT_FILE_TYPES.has(attachment.type)) return true;
      const name = attachment.name.toLowerCase();
      return /\.(jpe?g|png|webp|gif|pdf|docx|pptx)$/.test(name);
    });
};

module.exports = ({ databaseinmongo, userCollection, studyRooms, courses }) => {
  const router = Router();
  const {
    createRoomNotification,
    createCourseNotification,
    getScopedNotifications,
    getUnreadCount,
    markNotificationsRead,
  } = makeNotificationHelpers({ databaseinmongo, userCollection, studyRooms, courses });

  const getRoomAccess = async (roomId, userId) => {
    if (!ObjectId.isValid(roomId) || !userId) return { allowed: false };
    const room = await studyRooms.findOne({ _id: new ObjectId(roomId) });
    if (!room) return { allowed: false, status: 404, message: "Room not found." };
    const isStudent = (room.memberIds || []).includes(userId);
    const isTeacher = (room.teacherSessions || []).some((session) => session.teacherId === userId);
    return { allowed: isStudent || isTeacher, room };
  };

  const getCourseAccess = async (courseId, userId) => {
    if (!ObjectId.isValid(courseId) || !userId) return { allowed: false };
    const course = await courses.findOne({ _id: new ObjectId(courseId) });
    if (!course) return { allowed: false, status: 404, message: "Course not found." };
    const isTeacher = course.teacherId === userId;
    const isStudent = (course.enrollments || []).some((enrollment) => enrollment.studentId === userId && enrollment.status !== "cancelled");
    return { allowed: isTeacher || isStudent, course };
  };

  const assertScopedAccess = async ({ scope, scopeId, userId }) => {
    if (scope === "room") return getRoomAccess(scopeId, userId);
    if (scope === "course") return getCourseAccess(scopeId, userId);
    return { allowed: false, status: 400, message: "Unsupported notification scope." };
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
        attachments = [],
      } = req.body;
      const access = await assertScopedAccess({ scope, scopeId, userId: actorId });
      if (!access.allowed)
        return res.status(access.status || 403).json({ error: access.message || "Not allowed." });
      if (scope === "course" && access.course?.teacherId !== actorId)
        return res.status(403).json({ error: "Only the course teacher can post course announcements." });

      const cleanMessage = String(message || "").trim();
      const cleanAttachments = sanitizeAnnouncementAttachments(attachments);
      if (!cleanMessage && !cleanAttachments.length)
        return res.status(400).json({ error: "Announcement message or file is required." });

      const payload = {
        type: "announcement",
        title: String(title || "Announcement").trim().slice(0, 80),
        message: cleanMessage,
        actorId,
        actorRole,
        metadata: { announcement: true, attachments: cleanAttachments },
      };
      const result =
        scope === "course"
          ? await createCourseNotification({ course: access.course, ...payload })
          : await createRoomNotification({ room: access.room, ...payload });

      res.status(201).json({ success: true, notificationCreated: result.ok });
    } catch (err) {
      console.error("Error creating announcement:", err);
      res.status(500).json({ error: "Failed to create announcement." });
    }
  });

  return router;
};
