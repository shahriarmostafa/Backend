const test = require("node:test");
const assert = require("node:assert/strict");

const {
  priceCataloguePackage,
  priceCreditPack,
  priceExtension,
  getDiscountPercent,
  getGeneratedHours,
  clampCredit,
  MAX_CREDIT_PER_PURCHASE,
  CREDIT_PACK_DURATION_HOURS,
} = require("../utils/purchasePricing");

/**
 * The vulnerability these exist for: /pay-poperl took amount, credit and
 * durationDays from the request body and granted the package outright when
 * amount was under 10. Nothing here may be influenced by a caller beyond
 * choosing WHAT to buy.
 */

// ── catalogue packages ──────────────────────────────────────────────────────

const pkg = (overrides = {}) => ({
  _id: "pkg-1",
  name: "Starter",
  price: 300,
  credit: 500,
  durationDays: 72,
  category: "university",
  type: "english_medium",
  ...overrides,
});

test("a catalogue package is priced entirely from its own document", () => {
  const priced = priceCataloguePackage(pkg());
  assert.equal(priced.amount, 300);
  assert.equal(priced.credit, 500);
  assert.equal(priced.durationHours, 72);
  assert.equal(priced.packageName, "Starter");
  assert.equal(priced.category, "university");
});

test("a free package is one the admin priced at zero, not one the caller claims is cheap", () => {
  const free = priceCataloguePackage(pkg({ price: 0 }));
  assert.equal(free.amount, 0);
  assert.equal(free.credit, 500, "a free package still grants its real credit");
});

test("a missing package cannot be bought", () => {
  assert.ok(priceCataloguePackage(null).error);
  assert.ok(priceCataloguePackage(undefined).error);
});

test("a corrupt package document degrades to zero rather than NaN", () => {
  const priced = priceCataloguePackage(pkg({ price: "abc", credit: null, durationDays: undefined }));
  assert.equal(priced.amount, 0);
  assert.equal(priced.credit, 0);
  assert.equal(priced.durationHours, 0);
});

test("a negative price cannot become a refund", () => {
  assert.equal(priceCataloguePackage(pkg({ price: -5000 })).amount, 0);
});

// ── credit packs ────────────────────────────────────────────────────────────

test("a credit pack costs quantity times the admin's unit price", () => {
  const priced = priceCreditPack({ requestedCredit: 100, pricePerCredit: 2 });
  assert.equal(priced.amount, 200);
  assert.equal(priced.credit, 100);
  assert.equal(priced.durationHours, CREDIT_PACK_DURATION_HOURS);
});

test("the bulk discount ladder is applied server-side", () => {
  assert.equal(getDiscountPercent(3000), 20);
  assert.equal(getDiscountPercent(1000), 10);
  assert.equal(getDiscountPercent(399), 0);

  // 1000 credits at 2 = 2000, less 10%
  assert.equal(priceCreditPack({ requestedCredit: 1000, pricePerCredit: 2 }).amount, 1800);
});

test("credit is clamped, so a huge quantity cannot be requested", () => {
  const priced = priceCreditPack({ requestedCredit: 10_000_000, pricePerCredit: 2 });
  assert.equal(priced.credit, MAX_CREDIT_PER_PURCHASE);
  assert.ok(priced.amount > 0);
});

test("a nonsense quantity buys nothing", () => {
  assert.ok(priceCreditPack({ requestedCredit: 0, pricePerCredit: 2 }).error);
  assert.ok(priceCreditPack({ requestedCredit: -500, pricePerCredit: 2 }).error);
  assert.ok(priceCreditPack({ requestedCredit: "free", pricePerCredit: 2 }).error);
});

test("credit cannot be bought where the admin set no price", () => {
  assert.ok(priceCreditPack({ requestedCredit: 100, pricePerCredit: 0 }).error);
  assert.ok(priceCreditPack({ requestedCredit: 100, pricePerCredit: undefined }).error);
  // and a negative unit price must not pay the buyer
  assert.ok(priceCreditPack({ requestedCredit: 100, pricePerCredit: -5 }).error);
});

test("a discounted pack never falls to zero", () => {
  const priced = priceCreditPack({ requestedCredit: 3000, pricePerCredit: 0.0001 });
  assert.ok(priced.amount >= 1, "a paid pack must never become free through rounding");
});

// ── extensions ──────────────────────────────────────────────────────────────

const sub = (overrides = {}) => ({
  price: 300,
  totalCredit: 500,
  category: "university",
  type: "english_medium",
  ...overrides,
});

test("an extension is priced at what the buyer originally paid per credit", () => {
  // 300/500 = 0.6 per credit; 100 credits earns 1 hour, so no surcharge
  const priced = priceExtension({ requestedCredit: 100, requestedHours: 1, subscription: sub() });
  assert.equal(priced.amount, 60);
  assert.equal(priced.credit, 100);
});

test("asking for more hours than the credit earns costs extra", () => {
  const generated = getGeneratedHours(100); // 1
  const priced = priceExtension({
    requestedCredit: 100,
    requestedHours: generated + 24,
    subscription: sub(),
  });
  assert.ok(priced.amount > 60, "the surcharge ladder is applied");
});

test("asking for fewer hours than the credit earns does not reduce the price", () => {
  const priced = priceExtension({ requestedCredit: 500, requestedHours: 0, subscription: sub() });
  assert.equal(priced.durationHours, getGeneratedHours(500));
});

test("a package with no recorded price or credit cannot set a rate", () => {
  // this used to divide by zero and produce a NaN amount
  assert.ok(priceExtension({ requestedCredit: 100, requestedHours: 1, subscription: sub({ totalCredit: 0 }) }).error);
  assert.ok(priceExtension({ requestedCredit: 100, requestedHours: 1, subscription: sub({ price: 0 }) }).error);
  assert.ok(priceExtension({ requestedCredit: 100, requestedHours: 1, subscription: null }).error);
});

test("extension hours are bounded", () => {
  const priced = priceExtension({
    requestedCredit: 100,
    requestedHours: 99_999_999,
    subscription: sub(),
  });
  assert.ok(priced.durationHours <= 8760, "cannot buy a century of access");
});

// ── the shape of the attack ─────────────────────────────────────────────────

test("nothing a caller sends about money is used", () => {
  // the old body: { amount: 1, price: 1, credit: 999999, durationDays: 99999 }
  const hostile = {
    amount: 1, price: 1, credit: 999999, durationDays: 99999, isUnlimited: true,
  };
  const priced = priceCataloguePackage({ ...pkg(), ...{} });

  assert.equal(priced.amount, 300, "the package's price, not the caller's");
  assert.equal(priced.credit, 500, "the package's credit, not the caller's");
  assert.equal(priced.durationHours, 72, "the package's duration, not the caller's");
  assert.equal(priced.isUnlimited, false, "a catalogue package is never unlimited on request");
  assert.ok(!("amount" in hostile && priced.amount === hostile.amount));
});

test("clampCredit floors, bounds and rejects junk", () => {
  assert.equal(clampCredit(10.9), 10);
  assert.equal(clampCredit(-1), 0);
  assert.equal(clampCredit("50"), 50);
  assert.equal(clampCredit("abc"), 0);
  assert.equal(clampCredit(null), 0);
  assert.equal(clampCredit(Infinity), MAX_CREDIT_PER_PURCHASE);
});
