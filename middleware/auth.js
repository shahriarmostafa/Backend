/**
 * Firebase ID-token authentication.
 *
 * Every browser/app request must carry `Authorization: Bearer <firebase id token>`.
 * `attachUser` decodes it, `gateAuth` rejects anonymous callers outside the public
 * allowlist, and `gateOwner` restricts admin surfaces to the `owner` collection.
 *
 * AUTH_ENFORCE=false downgrades rejection to a loud warning. It exists only so a
 * backend deploy can go out before the clients that send tokens; see
 * SECURITY-ROLLOUT.md. Leave it unset in normal operation.
 */

// Requests that genuinely cannot carry a user token.
const PUBLIC_PATHS = [
  /^\/ipn$/,                    // ShurjoPay server-to-server callback
  /^\/userProfile\/[^/]+$/,     // public teacher profile page (no login)
  /^\/createCustomToken$/,      // verifies its own ID token, see routes/users.js
  /^\/newStudent$/,             // signup: user doc is created right after Firebase signup
  /^\/newTeacher$/,
];

// Admin surfaces. `methods` omitted means every method.
const OWNER_PATHS = [
  { pattern: /^\/api\/admin\// },
  { pattern: /^\/paySalary\// },
  { pattern: /^\/rejectSalary\// },
  { pattern: /^\/admin-add-subscription$/ },
  { pattern: /^\/deleteUser\// },
  { pattern: /^\/disableTeacher\// },
  { pattern: /^\/enableTeacher\// },
  // students read credit prices; only writes are owner-only
  { pattern: /^\/credit-price$/, methods: ["POST", "PUT", "PATCH", "DELETE"] },
];

const isEnforcing = () =>
  String(process.env.AUTH_ENFORCE ?? "true").toLowerCase() !== "false";

const readBearer = (req) => {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
};

const makeAuthMiddleware = ({ admin }) => {
  // The owner collection only exists once Mongo connects, which happens after
  // the first routes are mounted.
  let ownerCollection = null;
  const setDatabase = (db) => {
    ownerCollection = db?.collection("owner") || null;
  };

  const attachUser = async (req, res, next) => {
    const token = readBearer(req);
    if (!token) return next();
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      req.auth = { uid: decoded.uid, email: decoded.email || null, claims: decoded };
    } catch (err) {
      req.authError = err?.code || "invalid_token";
    }
    next();
  };

  const deny = (req, res, status, error, reason) => {
    if (!isEnforcing()) {
      console.warn(
        `[auth] would reject ${req.method} ${req.originalUrl} (${reason}) — allowed because AUTH_ENFORCE=false`
      );
      return null;
    }
    res.status(status).json({ error, reason });
    return res;
  };

  const requireAuth = (req, res, next) => {
    if (req.auth?.uid) return next();
    if (deny(req, res, 401, "Unauthorized", req.authError || "missing_token")) return undefined;
    return next();
  };

  const requireOwner = async (req, res, next) => {
    if (!req.auth?.uid) {
      if (deny(req, res, 401, "Unauthorized", req.authError || "missing_token")) return undefined;
      return next();
    }
    try {
      const record = ownerCollection ? await ownerCollection.findOne({ uid: req.auth.uid }) : null;
      if (record?.owner === "1") return next();
    } catch (err) {
      console.error("[auth] owner lookup failed:", err);
      return res.status(500).json({ error: "Authorization check failed" });
    }
    if (deny(req, res, 403, "Forbidden", "not_owner")) return undefined;
    return next();
  };

  /**
   * For endpoints that take a uid in the body/params: make sure the caller is
   * acting on their own account, unless they are an owner.
   */
  const requireSelf = (getUid) => async (req, res, next) => {
    if (!req.auth?.uid) {
      if (deny(req, res, 401, "Unauthorized", req.authError || "missing_token")) return undefined;
      return next();
    }
    const target = getUid(req);
    if (!target || target === req.auth.uid) return next();
    try {
      const record = ownerCollection ? await ownerCollection.findOne({ uid: req.auth.uid }) : null;
      if (record?.owner === "1") return next();
    } catch (err) {
      console.error("[auth] owner lookup failed:", err);
      return res.status(500).json({ error: "Authorization check failed" });
    }
    if (deny(req, res, 403, "Forbidden", "uid_mismatch")) return undefined;
    return next();
  };

  const isPublic = (req) => PUBLIC_PATHS.some((pattern) => pattern.test(req.path));

  const ownerRule = (req) =>
    OWNER_PATHS.find(
      ({ pattern, methods }) =>
        pattern.test(req.path) && (!methods || methods.includes(req.method))
    );

  // Fail closed: anything not explicitly public needs a verified token.
  const gate = (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    if (isPublic(req)) return next();
    if (ownerRule(req)) return requireOwner(req, res, next);
    return requireAuth(req, res, next);
  };

  return { attachUser, gate, requireAuth, requireOwner, requireSelf, setDatabase };
};

module.exports = { makeAuthMiddleware, PUBLIC_PATHS, OWNER_PATHS };
