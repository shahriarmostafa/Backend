/**
 * Who a request is acting as.
 *
 * `auth.gate` only proves the caller holds *a* valid Firebase token. Routes
 * used to take the acting uid from the body or params on top of that, so any
 * signed-in user could act as any other. These helpers bind the actor to the
 * verified token instead.
 *
 * Without a token - only reachable while AUTH_ENFORCE=false during a rollout -
 * the claimed uid is still honoured so un-upgraded clients keep working.
 */

const isEnforcing = () =>
  String(process.env.AUTH_ENFORCE ?? "true").toLowerCase() !== "false";

const clean = (value) => (value == null || value === "" ? null : String(value));

const tokenUid = (req) => req.auth?.uid || null;

/**
 * The uid this request acts as. A claimed uid that differs from the token is
 * refused unless the caller is an owner (the admin app acts on other
 * accounts).
 *
 * Returns the uid, or null after the error response has been sent.
 */
async function resolveActor(req, res, claimedUid) {
  const claimed = clean(claimedUid);
  const verified = tokenUid(req);

  if (verified) {
    if (!claimed || claimed === verified) return verified;
    if (await req.isOwner?.()) return claimed;
    res.status(403).json({ error: "Forbidden", reason: "uid_mismatch" });
    return null;
  }

  if (!isEnforcing() && claimed) return claimed;
  res.status(401).json({ error: "Unauthorized", reason: "missing_token" });
  return null;
}

/**
 * For actions where the caller must be one of a fixed set of parties (the
 * student or the teacher of a call, a chat's participants). Owners pass.
 *
 * Returns the caller's uid, or null after the error response has been sent.
 */
async function requireParty(req, res, parties, claimedUid) {
  const allowed = new Set((parties || []).map(clean).filter(Boolean));
  const verified = tokenUid(req);
  const caller = verified || (!isEnforcing() ? clean(claimedUid) : null);

  if (!caller) {
    res.status(401).json({ error: "Unauthorized", reason: "missing_token" });
    return null;
  }
  if (allowed.has(caller)) return caller;
  if (verified && (await req.isOwner?.())) return caller;

  res.status(403).json({ error: "Forbidden", reason: "not_a_party" });
  return null;
}

module.exports = { resolveActor, requireParty, isEnforcing };
