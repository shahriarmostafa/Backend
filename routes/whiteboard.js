const { Router } = require("express");
const axios = require("axios");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;

module.exports = () => {
  const router = Router();

  router.post("/create-whiteboard-room", async (req, res) => {
    try {
      const response = await axios.post(
        "https://api.netless.link/v5/rooms",
        { isRecord: false },
        {
          headers: {
            token:
              "NETLESSSDK_YWs9Wk8xVHlldTdFM0RJa1RoeCZub25jZT1iNWE3N2NmMC1lOTliLTExZWYtYTdmZi1mMWQ4MmIxZjEwMDUmcm9sZT0wJnNpZz0wMjViYjg1NmU3ZmZmNWM2NTExODJiNjYyZjU2NjcxNGJhNTRjMGY0ZDFlNDU0NGU0ZjIxZDlkNzE3ZTJjOTA4",
            "Content-Type": "application/json",
            region: "us-sv",
          },
        }
      );
      res.status(200).json({ uuid: response.data.uuid });
    } catch (error) {
      console.error("Error generating whiteboard token:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to generate whiteboard token" });
    }
  });

  router.post("/generate-whiteboard-token", async (req, res) => {
    const uuid = req.body.UUID;
    try {
      const response = await axios.post(
        `https://api.netless.link/v5/tokens/rooms/${uuid}`,
        { lifespan: 3600000, role: "admin" },
        {
          headers: {
            token:
              "NETLESSSDK_YWs9Wk8xVHlldTdFM0RJa1RoeCZub25jZT0yZjU5NzllMC1lOTYwLTExZWYtYTdmZi1mMWQ4MmIxZjEwMDUmcm9sZT0wJnNpZz0zZDViZWFkOGM3Y2JiZTkzODdmMjJiNjkwNDY5OTQ3NDlmYmYyMjAyY2E4YWI3MDA1MTlhZDIwMDQyM2ZkMjVi",
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

  router.post("/generate-token", (req, res) => {
    const { channelName } = req.body;
    if (!channelName) {
      return res.status(400).json({ error: "Channel name is required" });
    }
    try {
      const role = RtcRole.PUBLISHER;
      const expirationTimeInSeconds = 3600;
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
      const uid = Math.floor(100000 + Math.random() * 900000);
      const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpiredTs
      );
      console.log(token);
      res.json({ token, uid });
    } catch (err) {
      console.log(err);
      res.status(500).json({ error: "Failed to generate token" });
    }
  });

  return router;
};
