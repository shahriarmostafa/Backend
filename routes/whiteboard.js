const { Router } = require("express");
const axios = require("axios");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const { resolveActor } = require("../utils/actor");
const { canUseCallChannel } = require("../utils/chatAccess");

const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;

// Netless SDK tokens. They were hard-coded here, so the env rotation in
// SECURITY-ROLLOUT.md did not cover them. Set NETLESS_SDK_TOKEN (generate a new
// one in the Netless console and revoke these) and the fallbacks go unused.
const LEGACY_ROOM_SDK_TOKEN =
  "NETLESSSDK_YWs9Wk8xVHlldTdFM0RJa1RoeCZub25jZT1iNWE3N2NmMC1lOTliLTExZWYtYTdmZi1mMWQ4MmIxZjEwMDUmcm9sZT0wJnNpZz0wMjViYjg1NmU3ZmZmNWM2NTExODJiNjYyZjU2NjcxNGJhNTRjMGY0ZDFlNDU0NGU0ZjIxZDlkNzE3ZTJjOTA4";
const LEGACY_TOKEN_SDK_TOKEN =
  "NETLESSSDK_YWs9Wk8xVHlldTdFM0RJa1RoeCZub25jZT0yZjU5NzllMC1lOTYwLTExZWYtYTdmZi1mMWQ4MmIxZjEwMDUmcm9sZT0wJnNpZz0zZDViZWFkOGM3Y2JiZTkzODdmMjJiNjkwNDY5OTQ3NDlmYmYyMjAyY2E4YWI3MDA1MTlhZDIwMDQyM2ZkMjVi";
const NETLESS_ROOM_SDK_TOKEN = process.env.NETLESS_SDK_TOKEN || LEGACY_ROOM_SDK_TOKEN;
const NETLESS_TOKEN_SDK_TOKEN = process.env.NETLESS_SDK_TOKEN || LEGACY_TOKEN_SDK_TOKEN;
if (!process.env.NETLESS_SDK_TOKEN) {
  console.warn("[whiteboard] NETLESS_SDK_TOKEN is unset - using the token committed to source. Rotate it.");
}

// Calls are cut when the token lapses; the app renews before that.
const AGORA_TOKEN_SECONDS = 2 * 60 * 60;

module.exports = ({ databaseinmongo }) => {
  const router = Router();
  const whiteboardRooms = databaseinmongo.collection("whiteboardRooms");

  const mayUseChannel = async (req, uid, channelName) =>
    (await canUseCallChannel(databaseinmongo, uid, channelName)) || Boolean(await req.isOwner?.());

  router.post("/create-whiteboard-room", async (req, res) => {
    try {
      const uid = await resolveActor(req, res, null);
      if (!uid) return;
      const channelName = typeof req.body?.channelName === "string" ? req.body.channelName : null;
      if (channelName && !(await mayUseChannel(req, uid, channelName))) {
        return res.status(403).json({ error: "You are not part of this call." });
      }

      const response = await axios.post(
        "https://api.netless.link/v5/rooms",
        { isRecord: false },
        {
          headers: {
            token: NETLESS_ROOM_SDK_TOKEN,
            "Content-Type": "application/json",
            region: "us-sv",
          },
        }
      );
      // Remember which call the board belongs to, so only its people get tokens.
      // An older app build sends no channel; its boards stay unbound.
      if (channelName) {
        await whiteboardRooms.insertOne({
          _id: response.data.uuid,
          channelName,
          createdBy: uid,
          createdAt: new Date(),
        });
      }
      res.status(200).json({ uuid: response.data.uuid });
    } catch (error) {
      console.error("Error generating whiteboard token:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to generate whiteboard token" });
    }
  });

  router.post("/generate-whiteboard-token", async (req, res) => {
    const uuid = req.body.UUID;
    try {
      const uid = await resolveActor(req, res, null);
      if (!uid) return;
      if (!uuid || typeof uuid !== "string") return res.status(400).json({ error: "UUID is required" });

      const board = await whiteboardRooms.findOne({ _id: uuid });
      // Boards created before this check have no record; they belong to calls
      // that were already running when this shipped.
      if (board && board.createdBy !== uid) {
        if (!board.channelName || !(await mayUseChannel(req, uid, board.channelName))) {
          return res.status(403).json({ error: "You are not part of this whiteboard." });
        }
      }

      const response = await axios.post(
        `https://api.netless.link/v5/tokens/rooms/${encodeURIComponent(uuid)}`,
        // writer can draw; admin tokens could also delete or ban
        { lifespan: 3600000, role: "writer" },
        {
          headers: {
            token: NETLESS_TOKEN_SDK_TOKEN,
            "Content-Type": "application/json",
            region: "us-sv",
          },
        }
      );
      res.status(200).json({ token: response.data });
    } catch (error) {
      console.error("Error generating whiteboard token:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to generate whiteboard token" });
    }
  });

  // this is for agora video call token generation
  router.post("/generate-token", async (req, res) => {
    const { channelName } = req.body;
    if (!channelName) {
      return res.status(400).json({ error: "Channel name is required" });
    }
    try {
      const caller = await resolveActor(req, res, null);
      if (!caller) return;
      if (!(await mayUseChannel(req, caller, channelName))) {
        return res.status(403).json({ error: "You are not part of this call." });
      }

      const role = RtcRole.PUBLISHER;
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const privilegeExpiredTs = currentTimestamp + AGORA_TOKEN_SECONDS;
      // A renewal must be for the uid already in the channel.
      const requestedUid = Number(req.body.uid);
      const uid =
        Number.isInteger(requestedUid) && requestedUid >= 100000 && requestedUid <= 999999
          ? requestedUid
          : Math.floor(100000 + Math.random() * 900000);
      const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpiredTs
      );
      res.json({ token, uid, expiresAt: privilegeExpiredTs * 1000 });
    } catch (err) {
      console.log(err);
      res.status(500).json({ error: "Failed to generate token" });
    }
  });

  return router;
};
