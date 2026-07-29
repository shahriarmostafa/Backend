// Exercises the real gate against a fake firebase-admin + owner collection.
const { makeAuthMiddleware } = require("./auth.js");

const VALID = { "tok-student": "student-uid", "tok-owner": "owner-uid" };

const admin = {
  auth: () => ({
    verifyIdToken: async (token) => {
      if (!VALID[token]) {
        const err = new Error("bad token");
        err.code = "auth/argument-error";
        throw err;
      }
      return { uid: VALID[token], email: `${VALID[token]}@x.com` };
    },
  }),
};

const db = {
  collection: () => ({
    findOne: async ({ uid }) => (uid === "owner-uid" ? { uid, owner: "1" } : null),
  }),
};

const auth = makeAuthMiddleware({ admin });
auth.setDatabase(db);

const run = async (method, path, token) => {
  const req = { method, path, originalUrl: path, headers: {} };
  if (token) req.headers.authorization = `Bearer ${token}`;
  let status = null;
  let body = null;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await new Promise((resolve) => auth.attachUser(req, res, resolve));
  await new Promise((resolve) => {
    const done = () => resolve();
    const result = auth.gate(req, res, done);
    if (result && typeof result.then === "function") result.then(() => resolve());
    else if (status !== null) resolve();
  });
  return { status: status ?? 200, body, uid: req.auth?.uid ?? null };
};

const cases = [
  // [label, method, path, token, expectedStatus]
  ["public: shurjopay ipn, no token",        "GET",  "/ipn",                        null,           200],
  ["public: teacher profile page",           "GET",  "/userProfile/abc",            null,           200],
  ["public: createCustomToken self-guards",  "POST", "/createCustomToken",          null,           200],
  ["protected: no token rejected",           "GET",  "/api/getUserRole/x",          null,           401],
  ["protected: bad token rejected",          "GET",  "/api/getUserRole/x",          "garbage",      401],
  ["protected: valid token allowed",         "GET",  "/api/getUserRole/x",          "tok-student",  200],
  ["credit-point needs a token",             "POST", "/api/messages/credit-point",  null,           401],
  ["credit-point ok when signed in",         "POST", "/api/messages/credit-point",  "tok-student",  200],
  ["admin route: anonymous -> 401",          "GET",  "/api/admin/study-rooms",      null,           401],
  ["admin route: student -> 403",            "GET",  "/api/admin/study-rooms",      "tok-student",  403],
  ["admin route: owner -> 200",              "GET",  "/api/admin/study-rooms",      "tok-owner",    200],
  ["delete room: student -> 403",            "DELETE", "/api/admin/study-rooms/r1", "tok-student",  403],
  ["paySalary: student -> 403",              "PATCH", "/paySalary/1",               "tok-student",  403],
  ["credit-price GET open to students",      "GET",  "/credit-price",               "tok-student",  200],
  ["credit-price POST owner-only",           "POST", "/credit-price",               "tok-student",  403],
];

(async () => {
  let failures = 0;
  for (const [label, method, path, token, expected] of cases) {
    const { status } = await run(method, path, token);
    const ok = status === expected;
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${String(status).padEnd(3)} (want ${expected})  ${label}`);
  }

  console.log("\n--- AUTH_ENFORCE=false (staged rollout) ---");
  process.env.AUTH_ENFORCE = "false";
  const soft = await run("GET", "/api/admin/study-rooms", null);
  const softOk = soft.status === 200;
  if (!softOk) failures += 1;
  console.log(`${softOk ? "PASS" : "FAIL"}  ${soft.status} (want 200)  anonymous allowed through while disabled`);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
