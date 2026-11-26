const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cors = require("cors");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { makeCorsOptions } = require("../utils/corsOptions");
const { makeAuthMiddleware } = require("../middleware/auth");

let baseUrl;
let io;
let previousEnforcement;

before(async () => {
  previousEnforcement = process.env.AUTH_ENFORCE;
  process.env.AUTH_ENFORCE = "true";
  const app = express();
  // Reproduce the deployed configuration that only allowed the dev server.
  const options = makeCorsOptions(" http://localhost:5173, https://admin.example.com ");
  app.use(cors(options));
  const auth = makeAuthMiddleware({
    admin: {
      auth: () => ({
        verifyIdToken: async (token) => {
          if (token !== "valid-test-token") throw new Error("Invalid token");
          return { uid: "student" };
        },
      }),
    },
  });
  app.use(auth.attachUser);
  app.use(auth.gate);
  app.get("/api/getUserRole/:uid", (req, res) => {
    res.json({ userDoc: { uid: req.auth.uid, role: "student" } });
  });
  const server = createServer(app);
  io = new Server(server, { cors: { ...options, methods: ["GET", "POST"] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => io.close(resolve));
  if (previousEnforcement === undefined) delete process.env.AUTH_ENFORCE;
  else process.env.AUTH_ENFORCE = previousEnforcement;
});

for (const origin of ["https://localhost", "capacitor://localhost", "http://localhost", "https://app.poperl.com"]) {
  test(`profile loading from ${origin} permits the bearer-token preflight and response`, async () => {
    const preflight = await fetch(`${baseUrl}/api/getUserRole/student`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/i);

    const profile = await fetch(`${baseUrl}/api/getUserRole/student`, {
      headers: { Origin: origin, Authorization: "Bearer valid-test-token" },
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.headers.get("access-control-allow-origin"), origin);
    assert.equal((await profile.json()).userDoc.uid, "student");
  });

  test(`Socket.IO preflight accepts the same ${origin} origin`, async () => {
    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  });
}

test("configured development and admin origins remain available", async () => {
  for (const origin of ["http://localhost:5173", "https://admin.example.com"]) {
    const response = await fetch(`${baseUrl}/api/getUserRole/student`, { headers: { Origin: origin } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    await response.arrayBuffer();
  }
});

test("allowing the app origin does not bypass Firebase authentication", async () => {
  const response = await fetch(`${baseUrl}/api/getUserRole/student`, { headers: { Origin: "https://localhost" } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://localhost");
  assert.equal((await response.json()).reason, "missing_token");
});

test("unlisted sites receive no CORS permission and do not cause HTTP 500", async () => {
  const response = await fetch(`${baseUrl}/api/getUserRole/student`, { headers: { Origin: "https://unlisted.example.com" } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  await response.arrayBuffer();
});

test("requests without an Origin header still reach the authentication gate", async () => {
  const response = await fetch(`${baseUrl}/api/getUserRole/student`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, "missing_token");
});

test("an unset allowlist still permits the bundled app without allowing arbitrary sites", () => {
  const options = makeCorsOptions("");
  for (const [origin, expected] of [["https://localhost", true], ["https://app.poperl.com", true], ["https://unlisted.example.com", false]]) {
    options.origin(origin, (error, allowed) => {
      assert.equal(error, null);
      assert.equal(allowed, expected);
    });
  }
});
