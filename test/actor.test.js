const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveActor, requireParty } = require("../utils/actor");

const makeRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

const makeReq = ({ uid = null, owner = false } = {}) => ({
  auth: uid ? { uid } : undefined,
  isOwner: async () => owner,
});

const withEnforce = async (value, fn) => {
  const previous = process.env.AUTH_ENFORCE;
  if (value === undefined) delete process.env.AUTH_ENFORCE;
  else process.env.AUTH_ENFORCE = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.AUTH_ENFORCE;
    else process.env.AUTH_ENFORCE = previous;
  }
};

test("the actor is the token's uid, whatever the body claims is ignored when absent", async () => {
  const res = makeRes();
  assert.equal(await resolveActor(makeReq({ uid: "me" }), res, undefined), "me");
  assert.equal(await resolveActor(makeReq({ uid: "me" }), res, "me"), "me");
  assert.equal(res.statusCode, null);
});

test("claiming someone else's uid is refused", async () => {
  const res = makeRes();
  assert.equal(await resolveActor(makeReq({ uid: "me" }), res, "victim"), null);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, "uid_mismatch");
});

test("an owner may act on another account", async () => {
  const res = makeRes();
  assert.equal(await resolveActor(makeReq({ uid: "admin", owner: true }), res, "student"), "student");
  assert.equal(res.statusCode, null);
});

test("no token is refused while enforcing", async () => {
  await withEnforce(undefined, async () => {
    const res = makeRes();
    assert.equal(await resolveActor(makeReq(), res, "someone"), null);
    assert.equal(res.statusCode, 401);
  });
});

test("no token falls back to the claimed uid only during a rollout", async () => {
  await withEnforce("false", async () => {
    const res = makeRes();
    assert.equal(await resolveActor(makeReq(), res, "legacy-uid"), "legacy-uid");
    assert.equal(res.statusCode, null);
  });
});

test("only the listed parties pass requireParty", async () => {
  const ok = makeRes();
  assert.equal(await requireParty(makeReq({ uid: "teacher" }), ok, ["student", "teacher"]), "teacher");

  const denied = makeRes();
  assert.equal(await requireParty(makeReq({ uid: "stranger" }), denied, ["student", "teacher"]), null);
  assert.equal(denied.statusCode, 403);

  const owner = makeRes();
  assert.equal(await requireParty(makeReq({ uid: "admin", owner: true }), owner, ["a", "b"]), "admin");
});
