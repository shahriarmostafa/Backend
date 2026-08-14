const { Router } = require("express");
const { makeR2Storage, normalizePath } = require("../utils/r2Storage");

const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

const isAllowedPath = (path = "") => {
  const cleanPath = normalizePath(path);
  if (!cleanPath || cleanPath.includes("..")) return false;
  return /^(chats|rooms|public-quizzes|announcements|courses|whiteboard-images)\//.test(cleanPath);
};

module.exports = () => {
  const router = Router();
  const r2Storage = makeR2Storage();

  router.post("/api/storage/upload-url", async (req, res) => {
    try {
      const { path, contentType = "application/octet-stream", size = 0 } = req.body || {};
      const cleanPath = normalizePath(path);
      if (!isAllowedPath(cleanPath)) return res.status(400).json({ error: "Invalid storage path." });
      if (Number(size) > MAX_UPLOAD_SIZE) return res.status(400).json({ error: "File is too large." });
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

  router.get("/api/storage/list", async (req, res) => {
    try {
      const prefix = normalizePath(req.query.prefix || "");
      if (!isAllowedPath(prefix)) return res.status(400).json({ error: "Invalid storage prefix." });
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
