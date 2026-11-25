/**
 * Push notifications, sent by the server to tokens it looked up itself.
 *
 * Clients used to post someone else's FCM token to /send-notification with any
 * title and body, which let anyone push spoofed notifications to any phone.
 *
 * Android delivers these on `high_importance_channel`; keep that id identical
 * to the channel NativeRuntime.jsx creates and MainActivity declares.
 */

const ANDROID_CHANNEL_ID = "high_importance_channel";

// FCM `data` values must all be strings.
const stringifyData = (data = {}) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );

const sendPush = async (admin, token, { title, body, data = {} }) => {
  if (!admin || !token) return false;
  try {
    await admin.messaging().send({
      token,
      notification: { title: String(title || "PoperL").slice(0, 120), body: String(body || "").slice(0, 240) },
      android: {
        priority: "high",
        notification: { sound: "default", channelId: ANDROID_CHANNEL_ID },
      },
      apns: { payload: { aps: { sound: "default", contentAvailable: true } } },
      data: stringifyData(data),
    });
    return true;
  } catch (err) {
    // An uninstalled app leaves a dead token behind; that is not an error worth a stack.
    console.warn("[push] send failed:", err?.code || err?.message || err);
    return false;
  }
};

module.exports = { sendPush, ANDROID_CHANNEL_ID };
