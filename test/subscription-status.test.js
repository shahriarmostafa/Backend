const test = require("node:test");
const assert = require("node:assert/strict");

const { getSubscriptionStatus } = require("../utils/subscriptionStatus");

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const pkg = (overrides = {}) => ({
  uid: "student-1",
  expiryDate: new Date(NOW + 5 * DAY).toISOString(),
  credit: 120,
  isActive: true,
  ...overrides,
});

test("an active plan with time and credit is subscribed", () => {
  const status = getSubscriptionStatus(pkg(), NOW);
  assert.deepEqual(status, { isSubscribed: true, outOfCredit: false });
});

// The regression this file exists for. Folding credit into isSubscribed sent
// this student to the "Get Started" buy page, which has no path to a top-up.
test("time remaining but zero credit stays subscribed, flagged out of credit", () => {
  const status = getSubscriptionStatus(pkg({ credit: 0 }), NOW);
  assert.deepEqual(status, { isSubscribed: true, outOfCredit: true });
});

test("credit written as a string still counts", () => {
  assert.deepEqual(
    getSubscriptionStatus(pkg({ credit: "40" }), NOW),
    { isSubscribed: true, outOfCredit: false }
  );
  // /pay-poperl writes totalCredit uncoerced, so a bad string is reachable
  assert.deepEqual(
    getSubscriptionStatus(pkg({ credit: "" }), NOW),
    { isSubscribed: true, outOfCredit: true }
  );
});

test("an expired plan is not subscribed, whatever its credit", () => {
  const expired = pkg({ expiryDate: new Date(NOW - DAY).toISOString() });
  assert.deepEqual(getSubscriptionStatus(expired, NOW), { isSubscribed: false, outOfCredit: false });
  assert.deepEqual(
    getSubscriptionStatus({ ...expired, credit: 500 }, NOW),
    { isSubscribed: false, outOfCredit: false }
  );
});

test("a deactivated plan is not subscribed even with time left", () => {
  assert.deepEqual(
    getSubscriptionStatus(pkg({ isActive: false }), NOW),
    { isSubscribed: false, outOfCredit: false }
  );
});

test("no package, and an unparseable expiry, both read as not subscribed", () => {
  assert.deepEqual(getSubscriptionStatus(null, NOW), { isSubscribed: false, outOfCredit: false });
  assert.deepEqual(getSubscriptionStatus(undefined, NOW), { isSubscribed: false, outOfCredit: false });
  assert.deepEqual(
    getSubscriptionStatus(pkg({ expiryDate: "not a date" }), NOW),
    { isSubscribed: false, outOfCredit: false }
  );
});
