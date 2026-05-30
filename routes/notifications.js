const { Router } = require("express");

module.exports = ({ admin }) => {
  const router = Router();

  router.post("/send-notification", async (req, res) => {
    const { nottificationToken, senderName, nottificationMessage } = req.body;

    if (!nottificationToken || !nottificationMessage || !senderName) {
      return res.status(400).json({ error: "Token, sender name, or message missing" });
    }

    const payload = {
      notification: {
        title: senderName,
        body: nottificationMessage,
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "high_importance_channel",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            contentAvailable: true,
          },
        },
      },
      data: {
        type: "chat_message",
        senderName,
        message: nottificationMessage,
      },
      token: nottificationToken,
    };

    try {
      await admin.messaging().send(payload);
      console.log("📩 Notification sent successfully");
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("❌ Error sending notification:", err);
      res.status(500).json({ error: "Failed to send notification" });
    }
  });

  router.post("/send-call-notification", async (req, res) => {
    const { receiverToken, callerName, callType, roomId } = req.body;

    if (!receiverToken || !callerName || !roomId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const payload = {
      notification: {
        title: "Class invitation",
        body: `${callerName} is requesting a class session`,
      },
      android: {
        priority: "high",
        notification: {
          channelId: "high_importance_channel",
          sound: "default",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      data: {
        type: "incoming_call",
        callerName,
        callType,
        roomId,
      },
      token: receiverToken,
    };

    try {
      await admin.messaging().send(payload);
      res.json({ success: true });
    } catch (error) {
      console.error("Error sending call notification:", error);
      res.status(500).json({ error: "Failed to send call notification" });
    }
  });

  return router;
};
