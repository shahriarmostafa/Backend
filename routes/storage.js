const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeR2Storage, normalizePath } = require("../utils/r2Storage");
const { resolveActor } = require("../utils/actor");
const { findChatEntry } = require("../utils/chatAccess");

const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

// What the app actually uploads: photos, voice notes, and pdf/docx/pptx. The
// bucket is public, so HTML, SVG or scripts would turn it into free hosting for
// phishing pages under our name.
const ALLOWED_CONTENT_TYPES = [
  /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/,
  /^audio\/(webm|ogg|mpeg|mp4|aac|wav|x-m4a|m4a|3gpp)$/,
  /^video\/webm$/, // some Android recorders label voice notes this way
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)$/,
];

const isAllowedPath = (path = "") => {
  const cleanPath = normalizePath(path);
  if (!cleanPath || cleanPath.includes("..")) return false;
  return /^(chat|chats|rooms|public-quizzes|announcements|courses|whiteboard-images)\//.test(cleanPath);
};

const isAllowedContentType = (contentType = "") => {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((pattern) => pattern.test(type));
};

// Android file pickers often hand over a file with no MIME type, which the app
// sends as application/octet-stream. Fall back to the extension for those.
const TYPE_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  webm: "audio/webm",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  wav: "audio/wav",
};
const resolveContentType = (contentType, path) => {
  if (contentType && !/^application\/octet-stream/i.test(contentType)) return contentType;
  const extension = String(path || "").split(".").pop().toLowerCase();
  return TYPE_BY_EXTENSION[extension] || contentType || "application/octet-stream";
};

module.exports = ({ databaseinmongo }) => {
  const router = Router();
  const r2Storage = makeR2Storage();

  const asObjectId = (value) => (ObjectId.isValid(value) ? new ObjectId(value) : null);

  const isRoomMember = async (uid, roomId) => {
    const _id = asObjectId(roomId);
    if (!_id) return false;
    const room = await databaseinmongo
      .collection("studyRooms")
      .findOne({ _id }, { projection: { memberIds: 1, teacherSessions: 1, createdBy: 1 } });
    return Boolean(
      room &&
        ((room.memberIds || []).includes(uid) ||
          room.createdBy === uid ||
          (room.teacherSessions || []).some((session) => session.teacherId === uid))
    );
  };

  const isCourseTeacher = async (uid, courseId) => {
    const _id = asObjectId(courseId);
    if (!_id) return false;
    const course = await databaseinmongo.collection("courses").findOne({ _id }, { projection: { teacherId: 1 } });
    return course?.teacherId === uid;
  };

  const isPublicQuizTeacher = async (uid, quizId) => {
    const _id = asObjectId(quizId);
    if (!_id) return false;
    const quiz = await databaseinmongo.collection("publicQuizzes").findOne({ _id }, { projection: { teacherId: 1 } });
    return quiz?.teacherId === uid;
  };

  /**
   * Whether `uid` may write to (or list) this path. Any signed-in user used to
   * be able to list and overwrite every chat's and every private room's files.
   */
  const mayAccessPath = async (req, uid, path, { listing = false } = {}) => {
    if (await req.isOwner?.()) return true;
    const parts = path.split("/");

    switch (parts[0]) {
      case "chats":
        // chats/direct/<sender>/... is the sender's own upload folder
        if (parts[1] === "direct") return !listing && parts[2] === uid;
        return Boolean(await findChatEntry(databaseinmongo, uid, parts[1]));
      case "rooms":
        if (!(await isRoomMember(uid, parts[1]))) return false;
        // rooms/<id>/quizzes/<quiz>/answers/<student>/... - only your own answers
        if (parts[2] === "quizzes" && parts[4] === "answers") return listing ? false : parts[5] === uid;
        return true;
      case "public-quizzes":
        // students upload their own answer images; nothing else is user-writable
        return !listing && parts[2] === "answers" && parts[3] === uid;
      case "announcements":
        if (listing) return false;
        if (parts[1] === "course") return isCourseTeacher(uid, parts[2]);
        if (parts[1] === "public_quiz") return isPublicQuizTeacher(uid, parts[2]);
        return false;
      case "courses":
        return isCourseTeacher(uid, parts[1]);
      case "whiteboard-images":
        return !listing && parts[1] === uid;
      default:
        return false;
    }
  };

  const parseBase64File = (data = "") => {
    const value = String(data || "");
    const commaIndex = value.indexOf(",");
    const base64 = commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
    return Buffer.from(base64, "base64");
  };

  router.post("/api/storage/upload-url", async (req, res) => {
    try {
      const { path, size = 0 } = req.body || {};
      const contentType = resolveContentType(req.body?.contentType, path);
      const uid = await resolveActor(req, res, null);
      if (!uid) return;
      const cleanPath = normalizePath(path);
      if (!isAllowedPath(cleanPath)) return res.status(400).json({ error: "Invalid storage path." });
      if (!isAllowedContentType(contentType)) return res.status(400).json({ error: "This file type is not supported." });
      if (Number(size) > MAX_UPLOAD_SIZE) return res.status(400).json({ error: "File is too large." });
      if (!(await mayAccessPath(req, uid, cleanPath))) return res.status(403).json({ error: "You cannot upload here." });
      if (!r2Storage.enabled) return res.status(503).json({ error: "R2 storage is not configured." });

      res.json({
        success: true,
        ...r2Storage.getUploadUrl({ path: cleanPath, contentType }),
      });
    } catch (err) {
      console.error("Error creating R2 upload URL:", err);
      res.status(500).json({ error: "Failed to prepare upload." });
    }
  });

  router.post("/api/storage/upload", async (req, res) => {
    try {
      const { path, data = "", size = 0 } = req.body || {};
      const contentType = resolveContentType(req.body?.contentType, path);
      const uid = await resolveActor(req, res, null);
      if (!uid) return;
      const cleanPath = normalizePath(path);
      if (!isAllowedPath(cleanPath)) return res.status(400).json({ error: "Invalid storage path." });
      if (!isAllowedContentType(contentType)) return res.status(400).json({ error: "This file type is not supported." });
      if (!data) return res.status(400).json({ error: "File data is required." });
      if (Number(size) > MAX_UPLOAD_SIZE) return res.status(400).json({ error: "File is too large." });
      if (!(await mayAccessPath(req, uid, cleanPath))) return res.status(403).json({ error: "You cannot upload here." });
      if (!r2Storage.enabled) return res.status(503).json({ error: "R2 storage is not configured." });

      const buffer = parseBase64File(data);
      if (!buffer.length) return res.status(400).json({ error: "File data is empty." });
      if (buffer.length > MAX_UPLOAD_SIZE) return res.status(400).json({ error: "File is too large." });

      const uploaded = await r2Storage.putObject({ path: cleanPath, body: buffer, contentType });
      res.json({ success: true, ...uploaded });
    } catch (err) {
      console.error("Error uploading to R2:", err);
      res.status(500).json({ error: "Failed to upload file." });
    }
  });

  router.get("/api/storage/list", async (req, res) => {
    try {
      const uid = await resolveActor(req, res, null);
      if (!uid) return;
      const prefix = normalizePath(req.query.prefix || "");
      if (!isAllowedPath(prefix)) return res.status(400).json({ error: "Invalid storage prefix." });
      if (!(await mayAccessPath(req, uid, prefix, { listing: true }))) {
        return res.status(403).json({ error: "You cannot view these files." });
      }
      if (!r2Storage.enabled) return res.status(503).json({ error: "R2 storage is not configured." });

      const items = await r2Storage.listFolder(prefix);
      res.json({ success: true, items });
    } catch (err) {
      console.error("Error listing R2 resources:", err);
      res.status(500).json({ error: "Failed to list resources." });
    }
  });

  return router;
};

module.exports.isAllowedContentType = isAllowedContentType;
