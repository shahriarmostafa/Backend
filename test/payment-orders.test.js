const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./helpers/fakeMongo");
const makePaymentRoutes = require("../routes/payment");

// Mongo rejects a second document with the same _id; the shared fake does not,
// and that rejection is exactly what makes a payment claim once-only.
const withUniqueIds = (collection) => {
  const insertOne = collection.insertOne.bind(collection);
  collection.insertOne = async (doc) => {
    if (doc._id !== undefined && (await collection.findOne({ _id: doc._id }))) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    return insertOne(doc);
  };
  return collection;
};

const ORDER = "SP-order-1";
const paidResult = (overrides = {}) => [
  {
    sp_code: "1000",
    sp_message: "Success",
    value1: JSON.stringify({
      paymentType: "extension",
      uid: "student-1",
      displayName: "Student",
      packageName: "Credit Pack",
      price: 300,
      credit: 500,
      durationDays: 24,
      category: "school",
      type: "bangla_medium",
      isUnlimited: true,
    }),
    ...overrides,
  },
];

const setup = (verifyResult = paidResult()) => {
  const db = createDb({
    activePackages: [{ uid: "student-1", credit: 100, totalCredit: 100, price: 50, expiryDate: new Date(Date.now() + 86400000).toISOString() }],
  });
  const shurjopay = {
    verifyPayment: (orderId, callback) => setImmediate(() => callback(verifyResult)),
  };
  const router = makePaymentRoutes({
    activepackages: db.collection("activePackages"),
    subscriptions: withUniqueIds(db.collection("subscriptions")),
    userCollection: db.collection("userCollection"),
    referrals: db.collection("referrals"),
    packages: db.collection("packages"),
    creditPrices: db.collection("creditPrices"),
    shurjopay,
  });
  const handler = (method, path) =>
    router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  return { db, handler };
};

const call = async (handle, req) => {
  const res = {
    statusCode: 200,
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
  await handle({ isOwner: async () => false, body: {}, query: {}, params: {}, ...req }, res);
  return res;
};

test("a paid order is granted once even when its callback arrives twice at once", async () => {
  const { db, handler } = setup();
  const ipn = handler("get", "/ipn");
  await Promise.all([call(ipn, { query: { order_id: ORDER } }), call(ipn, { query: { order_id: ORDER } })]);
  const [pkg] = db.collection("activePackages")._all();
  assert.equal(pkg.credit, 600, "500 credit added exactly once");
});

test("the app's own check after checkout grants a paid order the callback missed, once", async () => {
  const { db, handler } = setup();
  const status = handler("get", "/api/payments/:orderId/status");
  const first = await call(status, { auth: { uid: "student-1" }, params: { orderId: ORDER } });
  assert.equal(first.body.status, "success");
  await call(handler("get", "/ipn"), { query: { order_id: ORDER } });
  assert.equal(db.collection("activePackages")._all()[0].credit, 600);
});

test("someone else's order cannot be checked or applied", async () => {
  const { db, handler } = setup();
  const res = await call(handler("get", "/api/payments/:orderId/status"), {
    auth: { uid: "another-student" },
    params: { orderId: ORDER },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(db.collection("activePackages")._all()[0].credit, 100);
});

test("a cancelled checkout is reported as cancelled, not success", async () => {
  const { db, handler } = setup(paidResult({ sp_code: "1002", sp_message: "Cancelled" }));
  const res = await call(handler("get", "/api/payments/:orderId/status"), {
    auth: { uid: "student-1" },
    params: { orderId: ORDER },
  });
  assert.equal(res.body.status, "cancelled");
  assert.equal(db.collection("activePackages")._all()[0].credit, 100);
});
