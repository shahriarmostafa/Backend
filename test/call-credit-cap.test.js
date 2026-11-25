const test = require("node:test");
const assert = require("node:assert/strict");

const { getBillableCallSeconds, getCallCreditForSeconds } = require("../utils/moneyHelpers");

test("a call within the balance is billed in full", () => {
  assert.equal(getBillableCallSeconds(600, 500, 1), 600);
});

test("a call longer than the balance is billed only up to the balance", () => {
  const seconds = getBillableCallSeconds(3600, 30, 1);
  assert.equal(getCallCreditForSeconds(seconds, 1), 30);
});

test("the billed amount never exceeds the balance at a discounted rate", () => {
  for (const credit of [0, 1, 7, 33, 120]) {
    const seconds = getBillableCallSeconds(10_000, credit, 0.7);
    assert.ok(getCallCreditForSeconds(seconds, 0.7) <= credit, `credit ${credit}`);
  }
});

test("no credit means no billable time", () => {
  assert.equal(getCallCreditForSeconds(getBillableCallSeconds(900, 0, 1), 1), 0);
});

test("a free rate does not cap the call", () => {
  assert.equal(getBillableCallSeconds(900, 0, 0), 900);
});
