const { Router } = require("express");
const {
  REFERRAL_REWARD_CREDIT,
  REFERRAL_REWARD_DURATION_HOURS,
  TEACHER_EXPERIENCE_LEVELS,
} = require("../utils/constants");
const { resolveActor } = require("../utils/actor");

// What anyone may see of a teacher on the public profile page. Contact details,
// tokens and money fields stay private.
const PUBLIC_TEACHER_FIELDS = {
  _id: 0,
  uid: 1,
  role: 1,
  displayName: 1,
  photoURL: 1,
  subject: 1,
  subjects: 1,
  category: 1,
  type: 1,
  experience: 1,
  rating: 1,
  isActive: 1,
  isOnline: 1,
};

const CATEGORIES = ["school", "college", "university"];
const MEDIUMS = ["bangla_medium", "english_medium"];
const cleanText = (value, max = 120) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const cleanPhotoUrl = (value) =>
  typeof value === "string" && /^https:\/\//.test(value) ? value.slice(0, 500) : null;

module.exports = ({ userCollection, referrals, activepackages, databaseinmongo, admin }) => {
  const router = Router();

  router.get("/isOwner/:uid", async (req, res) => {
    try {
      const uid = req.params.uid;
      const ownerCollection = databaseinmongo.collection("owner");
      const result = await ownerCollection.findOne({ uid });
      res.status(200).json({ owner: result?.owner === "1" });
    } catch (err) {
      console.log(err);
      res.status(500).json({ owner: false });
    }
  });

  /**
   * Mints the Firebase custom token the native shell injects into the WebView.
   *
   * The caller must prove who they are with an ID token; the uid is read from
   * that token, never from the body. Accepting a body uid meant anyone could
   * request a session for any account.
   *
   * ALLOW_LEGACY_UID_TOKEN re-opens the old body-uid path. It exists only so
   * already-installed app builds keep working during a rollout, and it is an
   * account-takeover hole for as long as it is on.
   */
  router.post("/createCustomToken", async (req, res) => {
    const allowLegacy = String(process.env.ALLOW_LEGACY_UID_TOKEN || "").toLowerCase() === "true";
    const header = req.headers.authorization || "";
    const idToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

    try {
      let uid = null;

      if (idToken) {
        const decoded = await admin.auth().verifyIdToken(idToken);
        uid = decoded.uid;
      } else if (allowLegacy && req.body?.uid) {
        uid = req.body.uid;
        console.warn(
          `[auth] /createCustomToken served a legacy body uid (${uid}). ` +
            "Update the app build and unset ALLOW_LEGACY_UID_TOKEN."
        );
      }

      if (!uid) {
        return res.status(401).json({
          error: "Unauthorized",
          reason: idToken ? "invalid_token" : "missing_id_token",
        });
      }

      const customToken = await admin.auth().createCustomToken(uid);
      return res.json({ token: customToken });
    } catch (error) {
      console.error("[auth] createCustomToken failed:", error?.code || error);
      return res.status(401).json({ error: "Unauthorized", reason: "invalid_token" });
    }
  });

  /**
   * Signup used to `$set` the request body straight into the user document,
   * without a token, keyed by a body uid. Anyone could create or overwrite any
   * account's role, credit or withdrawable points. The uid and email now come
   * from the verified token and every other field is built here.
   *
   * Returns the uid the document belongs to, or null after responding.
   */
  const createUserDoc = async (req, res, doc) => {
    const uid = await resolveActor(req, res, req.body?.uid);
    if (!uid) return null;
    const email = req.auth?.email || cleanText(req.body?.email, 200) || null;

    // Google sign-in calls this on every login, so an existing account must be
    // left exactly as it is.
    const existingUser = await userCollection.findOne(
      email ? { $or: [{ uid }, { email }] } : { uid },
      { projection: { _id: 1 } }
    );
    if (existingUser) return { uid, existed: true };

    await userCollection.updateOne(
      { _id: uid },
      { $setOnInsert: { ...doc, uid, email } },
      { upsert: true }
    );
    await databaseinmongo.collection("chatCollection").updateOne(
      { _id: uid },
      { $setOnInsert: { chats: [] } },
      { upsert: true }
    );
    return { uid, existed: false };
  };

  router.post("/newTeacher", async (req, res) => {
    try {
      const body = req.body || {};
      const category = CATEGORIES.includes(body.category) ? body.category : "school";
      const created = await createUserDoc(req, res, {
        role: "teacher",
        displayName: cleanText(body.displayName, 80),
        photoURL: cleanPhotoUrl(body.photoURL),
        whatsapp: cleanText(body.whatsapp, 20),
        category,
        type: category === "university" ? "english_medium" : MEDIUMS.includes(body.type) ? body.type : "bangla_medium",
        subjects: [],
        experience: 1,
        rating: 4,
        joined: Date.now(),
        points: 0,
        totalPoints: 0,
        revenuePercent: 0.75,
        joinedGroup: null,
        ownerOfGroup: null,
        groupMembers: 0,
        approved: false,
        FCMToken: null,
        isOnline: false,
        isActive: false,
      });
      if (!created) return;

      res.status(200).json({
        success: true,
        message: created.existed
          ? "User already exists, skipping teacher registration."
          : "Teacher added successfully.",
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: "Failed to add a new teacher." });
    }
  });

  router.post("/newStudent", async (req, res) => {
    try {
      const body = req.body || {};
      const claimedReferrer = cleanText(body.referredByUid, 128) || null;
      const callerUid = req.auth?.uid || cleanText(body.uid, 128);
      // The referrer has to be a real account; a made-up uid would otherwise
      // sit in `referrals` waiting to pay out.
      const referrer =
        claimedReferrer && claimedReferrer !== callerUid
          ? await userCollection.findOne({ uid: claimedReferrer }, { projection: { uid: 1 } })
          : null;
      const referredByUid = referrer?.uid || null;

      const created = await createUserDoc(req, res, {
        role: "student",
        displayName: cleanText(body.displayName, 80),
        photoURL: cleanPhotoUrl(body.photoURL),
        FCMToken: null,
        // Display only; spendable credit lives in activePackages.
        subscription: { credit: 200, paymentStatus: "approved", packageName: "Free Explore", isActive: true },
        ...(referredByUid ? { referredByUid, referredAt: new Date() } : {}),
      });
      if (!created) return;
      if (created.existed) {
        return res.status(200).json({
          success: true,
          message: "User already exists, skipping student registration.",
        });
      }
      const user = { uid: created.uid, referredByUid };

      if (user.referredByUid) {
        await referrals.updateOne(
          { referredUid: user.uid },
          {
            $setOnInsert: {
              referrerUid: user.referredByUid,
              referredUid: user.uid,
              rewardCredit: REFERRAL_REWARD_CREDIT,
              rewardDurationHours: REFERRAL_REWARD_DURATION_HOURS,
              rewardStatus: "pending",
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
      }

      res.status(200).json({ success: true, message: "Student added successfully." });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "An error occurred while processing the request." });
    }
  });

  router.get("/api/referrals/stats/:uid", async (req, res) => {
    try {
      const uid = await resolveActor(req, res, req.params.uid);
      if (!uid) return;

      const referralDocs = await referrals.find({ referrerUid: uid }).toArray();
      const totalReferrals = referralDocs.length;
      const qualifiedReferrals = referralDocs.filter((r) => r.rewardStatus === "awarded").length;
      const pendingReferrals = Math.max(0, totalReferrals - qualifiedReferrals);
      const totalRewardCredit = referralDocs.reduce(
        (sum, r) => (r.rewardStatus === "awarded" ? sum + Number(r.rewardCredit || 0) : sum),
        0
      );

      res.status(200).json({
        success: true,
        data: { totalReferrals, qualifiedReferrals, pendingReferrals, totalRewardCredit },
      });
    } catch (error) {
      console.error("referral stats error:", error);
      res.status(500).json({ success: false, error: "Failed to load referral stats" });
    }
  });

  // Public (no login): the shareable teacher page. Only the account itself and
  // owners get the full document; everyone else gets a teacher's public fields.
  router.get("/userProfile/:uid", async (req, res) => {
    const uid = req.params.uid;
    try {
      const isSelf = Boolean(req.auth?.uid) && req.auth.uid === uid;
      if (isSelf || (await req.isOwner?.())) {
        const user = await userCollection.findOne({ uid });
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.status(200).json({ data: user });
      }

      const teacher = await userCollection.findOne(
        { uid, role: "teacher" },
        { projection: PUBLIC_TEACHER_FIELDS }
      );
      if (!teacher) return res.status(404).json({ error: "User not found" });
      res.status(200).json({ data: teacher });
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post("/api/users/toggle-active", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const updateResult = await userCollection.updateOne(
        { uid: userId },
        { $set: { isActive: req.body?.isActive === true } }
      );
      res.json({ success: true, updateResult });
    } catch (err) {
      console.error("Error toggling active:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/users/study-profile", async (req, res) => {
    try {
      const { category, type } = req.body || {};
      const uid = await resolveActor(req, res, req.body?.uid);
      if (!uid) return;
      const cleanCategory = ["school", "college", "university"].includes(category)
        ? category
        : "";
      const cleanType =
        cleanCategory === "university"
          ? "english_medium"
          : ["english_medium", "bangla_medium"].includes(type)
          ? type
          : "";

      if (!uid || !cleanCategory || !cleanType) {
        return res.status(400).json({ error: "uid, category and type are required." });
      }

      const userDoc = await userCollection.findOne({ uid });
      if (!userDoc) return res.status(404).json({ error: "User not found." });
      if (userDoc.role !== "student") {
        return res.status(403).json({ error: "Only students can update study profile here." });
      }

      await userCollection.updateOne(
        { uid },
        {
          $set: {
            category: cleanCategory,
            type: cleanType,
            studyProfileUpdatedAt: new Date(),
          },
        }
      );
      const updatedUser = await userCollection.findOne({ uid });
      res.json({ success: true, userDoc: updatedUser });
    } catch (err) {
      console.error("Error updating study profile:", err);
      res.status(500).json({ error: "Failed to update study profile." });
    }
  });

  router.post("/api/users/update-fcm", async (req, res) => {
    try {
      const { userId, FCMToken } = req.body;
      if (!userId || !FCMToken)
        return res.status(400).json({ error: "Missing userId or FCMToken" });
      const verifiedUserId = req.auth?.uid || userId;
      if (req.auth?.uid && req.auth.uid !== userId)
        return res.status(403).json({ error: "Cannot update another user's notification token." });
      // A phone carries one token. If another account signed in on this device
      // before, it must stop receiving this user's calls and messages.
      await userCollection.updateMany(
        { FCMToken, uid: { $ne: verifiedUserId } },
        { $set: { FCMToken: null } }
      );
      await userCollection.updateOne({ uid: verifiedUserId }, { $set: { FCMToken } });
      res.json({ success: true });
    } catch (err) {
      console.error("Error updating FCM token:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Called on logout so the phone stops receiving the signed-out account's
  // notifications. Only clears the token if it is still this device's.
  router.post("/api/users/clear-fcm", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const filter = { uid: userId };
      if (req.body?.FCMToken) filter.FCMToken = req.body.FCMToken;
      await userCollection.updateOne(filter, { $set: { FCMToken: null } });
      res.json({ success: true });
    } catch (err) {
      console.error("Error clearing FCM token:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const getTeacherLevelState = (teacher = {}) => {
    const totalPoints = Number(teacher.totalPoints) || 0;
    const currentLevel = Number(teacher.experience) || 1;
    const highestUnlocked =
      [...TEACHER_EXPERIENCE_LEVELS]
        .reverse()
        .find((item) => totalPoints >= item.points)?.level || 1;
    const nextLevel = TEACHER_EXPERIENCE_LEVELS.find((item) => item.level === currentLevel + 1) || null;
    const currentThreshold =
      TEACHER_EXPERIENCE_LEVELS.find((item) => item.level === currentLevel)?.points || 0;
    const nextThreshold = nextLevel?.points || currentThreshold;
    const progressRange = Math.max(1, nextThreshold - currentThreshold);
    const progress = nextLevel
      ? Math.min(100, Math.max(0, ((totalPoints - currentThreshold) / progressRange) * 100))
      : 100;

    return {
      totalPoints,
      currentLevel,
      highestUnlocked,
      canClaim: highestUnlocked > currentLevel,
      nextLevel,
      nextRequiredPoints: nextLevel?.points || null,
      pointsToNextLevel: nextLevel ? Math.max(0, nextLevel.points - totalPoints) : 0,
      progress,
      levels: TEACHER_EXPERIENCE_LEVELS,
    };
  };

  router.get("/api/teachers/:teacherId/experience", async (req, res) => {
    try {
      const teacher = await userCollection.findOne({
        uid: req.params.teacherId,
        role: "teacher",
      });
      if (!teacher) return res.status(404).json({ error: "Teacher not found." });
      res.json({ success: true, experience: getTeacherLevelState(teacher) });
    } catch (err) {
      console.error("Error fetching teacher experience:", err);
      res.status(500).json({ error: "Failed to fetch teacher experience." });
    }
  });

  router.post("/api/teachers/:teacherId/claim-level", async (req, res) => {
    try {
      const teacherId = await resolveActor(req, res, req.params.teacherId);
      if (!teacherId) return;
      const teacher = await userCollection.findOne({
        uid: teacherId,
        role: "teacher",
      });
      if (!teacher) return res.status(404).json({ error: "Teacher not found." });

      const levelState = getTeacherLevelState(teacher);
      if (!levelState.canClaim) {
        return res.status(409).json({
          error: levelState.nextLevel
            ? `You need ${levelState.pointsToNextLevel} more total points to claim level ${levelState.nextLevel.level}.`
            : "You already reached the highest teacher level.",
          experience: levelState,
        });
      }

      await userCollection.updateOne(
        { uid: teacher.uid, role: "teacher" },
        {
          $set: {
            experience: levelState.highestUnlocked,
            levelClaimedAt: new Date(),
          },
        }
      );

      const updatedTeacher = await userCollection.findOne({ uid: teacher.uid });
      res.json({
        success: true,
        userDoc: updatedTeacher,
        experience: getTeacherLevelState(updatedTeacher),
      });
    } catch (err) {
      console.error("Error claiming teacher level:", err);
      res.status(500).json({ error: "Failed to claim teacher level." });
    }
  });

  // Returns the caller's own full document (owners may read anyone's).
  router.get("/api/getUserRole/:userId", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.params.userId);
      if (!userId) return;
      const userDoc = await userCollection.findOne({ uid: userId });
      if (userDoc) {
        res.json({ userRole: userDoc.role, userDoc });
      } else {
        res.status(404).json({ message: "User not found or not a student" });
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  return router;
};
