// These are the bundled app's actual WebView origins, not the API hostname.
// Keep them available even when a deploy's ALLOWED_ORIGINS only lists a local
// dev server or an admin site. Firebase authentication still protects the API.
const APP_ORIGINS = [
  "https://app.poperl.com",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
];

const makeCorsOptions = (configuredOrigins = process.env.ALLOWED_ORIGINS || "") => {
  const allowedOrigins = new Set([
    ...APP_ORIGINS,
    ...configuredOrigins.split(",").map((value) => value.trim()).filter(Boolean),
  ]);

  return {
    origin(origin, callback) {
      // A missing Origin is normal for server callbacks and native HTTP.
      // For other sites, omit CORS permission rather than turning a rejected
      // origin into an HTTP 500 that hides the actual response from the app.
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true,
  };
};

module.exports = { makeCorsOptions };
