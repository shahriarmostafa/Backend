/**
 * Derives a student's subscription status from their active package.
 *
 * This used to be three conditions ANDed together inline in the route:
 *
 *     isValid = expiryDate > now && credit > 0 && isActive === true
 *
 * Folding credit into "is this person subscribed" meant a student whose plan
 * still had days left but who had spent every credit was reported as NOT
 * subscribed. The app then showed them the "Get Started" buy page, which has no
 * route to "Add Credit & Time" - the one thing that would have helped. Running
 * out of credit is a separate state from not having a plan, so it is returned
 * separately.
 */
function getSubscriptionStatus(sub, now = Date.now()) {
  if (!sub) return { isSubscribed: false, outOfCredit: false };

  const expiry = new Date(sub.expiryDate).getTime();
  const hasTimeLeft = Number.isFinite(expiry) && expiry > now;
  const isSubscribed = hasTimeLeft && sub.isActive === true;

  // only meaningful while the plan is live; an expired plan is expired
  // regardless of its credit balance
  const outOfCredit = isSubscribed && !(Number(sub.credit) > 0);

  return { isSubscribed, outOfCredit };
}

module.exports = { getSubscriptionStatus };
