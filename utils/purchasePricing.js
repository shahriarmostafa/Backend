/**
 * What a purchase costs, decided by the server.
 *
 * `/pay-poperl` and `/extend-package` used to take `amount`, `price`, `credit`
 * and `durationDays` straight from the request body, and grant the package
 * outright when `amount` was under 10. So a caller could post
 * `{ amount: 1, credit: 999999, durationDays: 99999 }` and receive an unlimited
 * subscription marked `paymentStatus: "approved"` without paying - and on the
 * paid path, buy any quantity of credit for the price of the cheapest package.
 * Raising the free threshold to `amount === 0` would not have helped: the
 * attacker posts 0.
 *
 * The client now says only WHAT it wants to buy. Everything with a price on it
 * is derived here, from the package catalogue, the admin's credit prices, or
 * the buyer's existing subscription.
 *
 * These three ladders are ports of the ones that lived in Subscription.jsx.
 * The client keeps its copies to render prices before the request; this file is
 * what actually charges, so the two must move together.
 */

const CREDIT_PACK_DURATION_HOURS = 4320; // 180 days
const MAX_CREDIT_PER_PURCHASE = 3000;
const MAX_EXTENSION_HOURS = 8760; // a year

/** Hours of access a given credit top-up grants. */
const getGeneratedHours = (credit) => {
  const c = Number(credit) || 0;
  if (c <= 0) return 0;
  if (c <= 100) return 1;
  if (c <= 120) return 2;
  if (c <= 180) return 4;
  if (c <= 250) return 12;
  if (c <= 400) return 18;
  if (c <= 500) return 24;
  if (c <= 650) return 48;
  if (c <= 800) return 72;
  if (c <= 1000) return 144;
  if (c <= 2000) return 240;
  return 360;
};

/** Surcharge for asking for more hours than the credit alone earns. */
const getExtraHourPrice = (hours) => {
  const h = Number(hours) || 0;
  if (h <= 0) return 0;
  if (h <= 1) return 20;
  if (h <= 3) return 25;
  if (h <= 5) return 30;
  if (h <= 8) return 40;
  if (h <= 12) return 50;
  if (h <= 18) return 60;
  if (h <= 24) return 70;
  if (h <= 72) return 90;
  if (h <= 164) return 150;
  if (h <= 240) return 250;
  if (h <= 360) return 300;
  return 350;
};

/** Bulk discount on a credit pack, as a percentage. */
const getDiscountPercent = (credits) => {
  const c = Number(credits) || 0;
  if (c >= 3000) return 20;
  if (c >= 2500) return 15;
  if (c >= 1500) return 12;
  if (c >= 1000) return 10;
  if (c >= 800) return 8;
  if (c >= 600) return 5;
  if (c >= 400) return 2;
  return 0;
};

const clampCredit = (value) =>
  Math.max(0, Math.min(MAX_CREDIT_PER_PURCHASE, Math.floor(Number(value) || 0)));

/**
 * A catalogue package. Every figure comes from the stored document, so the
 * only thing the caller influences is which package.
 *
 * A package priced at 0 is granted outright - that is how a free package is
 * offered, rather than by the caller claiming a low amount.
 */
const priceCataloguePackage = (packageDoc) => {
  if (!packageDoc) return { error: "Package not found." };
  const amount = Math.max(0, Math.round(Number(packageDoc.price) || 0));
  return {
    amount,
    credit: clampCredit(packageDoc.credit),
    durationHours: Math.max(0, Math.floor(Number(packageDoc.durationDays) || 0)),
    packageName: packageDoc.name || "Package",
    category: packageDoc.category || null,
    type: packageDoc.type || null,
    isUnlimited: false,
  };
};

/**
 * A credit pack: the buyer picks a quantity, the admin sets the unit price.
 */
const priceCreditPack = ({ requestedCredit, pricePerCredit, category, type }) => {
  const credit = clampCredit(requestedCredit);
  const unit = Number(pricePerCredit) || 0;
  if (credit <= 0) return { error: "Choose how much credit to buy." };
  if (unit <= 0) return { error: "Credit is not on sale for this study profile." };

  const base = Math.round(credit * unit);
  const discount = getDiscountPercent(credit);
  const amount = discount > 0 ? Math.max(1, Math.round(base * (1 - discount / 100))) : base;

  return {
    amount,
    credit,
    durationHours: CREDIT_PACK_DURATION_HOURS,
    packageName: "Credit Pack",
    category: category || null,
    type: type || null,
    isUnlimited: true,
    discountPercent: discount,
  };
};

/**
 * A custom extension, priced against what the buyer originally paid per credit
 * so a cheap plan cannot be topped up at a cheaper plan's rate.
 */
const priceExtension = ({ requestedCredit, requestedHours, subscription }) => {
  const credit = clampCredit(requestedCredit);
  if (credit <= 0) return { error: "Choose how much credit to add." };
  if (!subscription) return { error: "No active package found." };

  const paid = Number(subscription.price) || 0;
  const total = Number(subscription.totalCredit) || 0;
  // an existing package with no recorded price or credit cannot set a rate;
  // this used to divide by zero and produce NaN
  if (paid <= 0 || total <= 0) return { error: "This package cannot be extended." };

  const perCredit = paid / total;
  const generatedHours = getGeneratedHours(credit);
  const askedHours = Math.max(
    generatedHours,
    Math.min(MAX_EXTENSION_HOURS, Math.floor(Number(requestedHours) || 0))
  );
  const extraHours = Math.max(0, askedHours - generatedHours);
  const amount = Math.max(0, Math.round(credit * perCredit + getExtraHourPrice(extraHours)));

  return {
    amount,
    credit,
    durationHours: askedHours,
    packageName: "Custom Extension",
    category: subscription.category || null,
    type: subscription.type || null,
    isUnlimited: Boolean(subscription.isUnlimited),
  };
};

module.exports = {
  CREDIT_PACK_DURATION_HOURS,
  MAX_CREDIT_PER_PURCHASE,
  getGeneratedHours,
  getExtraHourPrice,
  getDiscountPercent,
  clampCredit,
  priceCataloguePackage,
  priceCreditPack,
  priceExtension,
};
