const test = require("node:test");
const assert = require("node:assert/strict");

const { makeAuthMiddleware } = require("../middleware/auth");

const VALID_TOKENS = { "tok-student": "student-uid", "tok-owner": "owner-uid" };

const admin = {
  auth: () => ({
    verifyIdToken: async (token) => {
      if (!VALID_TOKENS[token]) {
        const error = new Error("bad token");
        error.code = "auth/argument-error";
        throw error;
      }
      return { uid: VALID_TOKENS[token], email: `${VALID_TOKENS[token]}@example.com` };
    },
  }),
};

const db = {
  collection: () => ({
    findOne: async ({ uid }) => (uid === "owner-uid" ? { uid, owner: "1" } : null),
  }),
};

const request = async (method, path, token) => {
  const auth = makeAuthMiddleware({ admin });
  auth.setDatabase(db);

  const req = { method, path, originalUrl: path, headers: {} };
  if (token) req.headers.authorization = `Bearer ${token}`;

  let status = null;
  let body = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };

  await new Promise((resolve) => auth.attachUser(req, res, resolve));
  await new Promise((resolve) => {
    const result = auth.gate(req, res, resolve);
    if (result && typeof result.then === "function") result.then(() => resolve());
    else if (status !== null) resolve();
  });

  return { status: status ?? 200, body, uid: req.auth?.uid ?? null };
};

test("the shurjopay callback stays reachable without a token", async () => {
  // the payment gateway cannot present a firebase token
  assert.equal((await request("GET", "/ipn", null)).status, 200);
});

test("the public teacher profile stays reachable without a token", async () => {
  assert.equal((await request("GET", "/userProfile/teacher-123", null)).status, 200);
});

test("createCustomToken is reachable so it can verify its own token", async () => {
  assert.equal((await request("POST", "/createCustomToken", null)).status, 200);
});

test("signup endpoints stay reachable", async () => {
  assert.equal((await request("POST", "/newStudent", null)).status, 200);
  assert.equal((await request("POST", "/newTeacher", null)).status, 200);
});

test("an anonymous request to a protected route is rejected", async () => {
  const { status, body } = await request("GET", "/api/getUserRole/x", null);
  assert.equal(status, 401);
  assert.equal(body.reason, "missing_token");
});

test("a forged token is rejected", async () => {
  const { status, body, uid } = await request("GET", "/api/getUserRole/x", "not-a-real-token");
  assert.equal(status, 401);
  assert.equal(uid, null, "a rejected token must not identify anyone");
  // the firebase error code is passed through rather than flattened, so the
  // reason distinguishes a bad token from a missing one
  assert.ok(body.reason && body.reason !== "missing_token", `unhelpful reason: ${body.reason}`);
});

test("a valid token is allowed through and identifies the caller", async () => {
  const { status, uid } = await request("GET", "/api/getUserRole/x", "tok-student");
  assert.equal(status, 200);
  assert.equal(uid, "student-uid");
});

test("the credit endpoint cannot be called anonymously", async () => {
  assert.equal((await request("POST", "/api/messages/credit-point", null)).status, 401);
});

test("admin routes reject anonymous callers", async () => {
  assert.equal((await request("GET", "/api/admin/study-rooms", null)).status, 401);
});

test("admin routes reject a signed-in student", async () => {
  const { status, body } = await request("GET", "/api/admin/study-rooms", "tok-student");
  assert.equal(status, 403);
  assert.equal(body.reason, "not_owner");
});

test("admin routes allow an owner", async () => {
  assert.equal((await request("GET", "/api/admin/study-rooms", "tok-owner")).status, 200);
});

test("destructive admin routes are owner-only", async () => {
  assert.equal((await request("DELETE", "/api/admin/study-rooms/r1", "tok-student")).status, 403);
  assert.equal((await request("PATCH", "/paySalary/1", "tok-student")).status, 403);
  assert.equal((await request("PATCH", "/rejectSalary/1", "tok-student")).status, 403);
  assert.equal((await request("DELETE", "/deleteUser/u1", "tok-student")).status, 403);
});

test("students may read credit prices but not change them", async () => {
  assert.equal((await request("GET", "/credit-price", "tok-student")).status, 200);
  assert.equal((await request("POST", "/credit-price", "tok-student")).status, 403);
});

test("preflight requests are never blocked", async () => {
  assert.equal((await request("OPTIONS", "/api/admin/study-rooms", null)).status, 200);
});

test("AUTH_ENFORCE=false downgrades rejection to a warning", async () => {
  const previous = process.env.AUTH_ENFORCE;
  process.env.AUTH_ENFORCE = "false";
  try {
    assert.equal((await request("GET", "/api/admin/study-rooms", null)).status, 200);
  } finally {
    if (previous === undefined) delete process.env.AUTH_ENFORCE;
    else process.env.AUTH_ENFORCE = previous;
  }
});

test("enforcement is back on once the flag is cleared", async () => {
  assert.equal((await request("GET", "/api/admin/study-rooms", null)).status, 401);
});
