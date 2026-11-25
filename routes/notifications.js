const { Router } = require("express");

/**
 * RETIRED. These took a raw FCM token plus any title and body from the client,
 * so anyone signed in could push spoofed notifications ("PoperL Admin: ...")
 * to any phone whose token they had seen - and the chat list used to hand out
 * every partner's token.
 *
 * The server now sends these itself, to tokens it looks up:
 *   - chat messages: routes/chat.js /sendMessage
 *   - incoming 1:1 classes: routes/calls.js /api/calls/ring
 *
 * Kept as no-ops so an older app build calling them does not error.
 */
module.exports = () => {
  const router = Router();

  router.post("/send-notification", (req, res) => {
    res.json({ success: true, deprecated: true });
  });

  router.post("/send-call-notification", (req, res) => {
    res.json({ success: true, deprecated: true });
  });

  return router;
};
