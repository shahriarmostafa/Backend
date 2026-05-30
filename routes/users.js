const { Router } = require("express");
const { REFERRAL_REWARD_CREDIT, REFERRAL_REWARD_DURATION_HOURS } = require("../utils/constants");

module.exports = ({ userCollection, referrals, activepackages, databaseinmongo, admin }) => {
  const router = Router();

  router.get("/isOwner/:uid", async (req, res) => {
    try {
      const uid = req.params.uid;
      const ownerCollection = databaseinmongo.collection("owner");
      const result = await ownerCollection.findOne({ uid });
      if (result.owner === "1") {
        res.status(200).json({ owner: true });
      } else {
        res.status(200).json({ owner: false });
      }
    } catch (err) {
      console.log(err);
    }
  });

  router.post("/createCustomToken", async (req, res) => {
    const { uid } = req.body;
    try {
      const customToken = await admin.auth().createCustomToken(uid);
      res.json({ token: customToken });
    } catch (error) {
      console.error(error);
      res.status(500).send("Error creating token");
    }
  });

  router.post("/newTeacher", async (req, res) => {
    try {
      const user = req.body;
      const existingUser = await userCollection.findOne({ email: user.email });

      if (existingUser) {
        await userCollection.updateOne(
          { _id: user.uid },
          { $set: { FCMToken: user.FCMToken } }
        );
        return res.status(200).json({
          success: true,
          message: "User already exists, skipping teacher registration.",
        });
      }

      await userCollection.updateOne({ _id: user.uid }, { $set: user }, { upsert: true });
      await databaseinmongo.collection("chatCollection").updateOne(
        { _id: user.uid },
        { $setOnInsert: { chats: [] } },
        { upsert: true }
      );

      res.status(200).json({ success: true, message: "Teacher added successfully." });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: "Failed to add a new teacher." });
    }
  });

  router.post("/newStudent", async (req, res) => {
    try {
      const user = req.body;
      const referredByUid =
        typeof user.referredByUid === "string" && user.referredByUid.trim()
          ? user.referredByUid.trim()
          : null;

      if (referredByUid && referredByUid !== user.uid) {
        user.referredByUid = referredByUid;
        user.referredAt = new Date();
      } else {
        delete user.referredByUid;
      }

      const existingUser = await userCollection.findOne({ email: user.email });

      if (existingUser) {
        await userCollection.updateOne(
          { _id: user.uid },
          { $set: { FCMToken: user.FCMToken } }
        );
        return res.status(200).json({
          success: true,
          message: "User already exists, skipping student registration.",
        });
      }

      await userCollection.updateOne({ _id: user.uid }, { $set: user }, { upsert: true });
      await databaseinmongo.collection("chatCollection").updateOne(
        { _id: user.uid },
        { $setOnInsert: { chats: [] } },
        { upsert: true }
      );

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
      const { uid } = req.params;
      if (!uid) return res.status(400).json({ success: false, error: "uid is required" });

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

  router.get("/userProfile/:uid", async (req, res) => {
    const uid = req.params.uid;
    try {
      const user = await userCollection.findOne({ uid });
      if (!user) return res.status(404).json({ error: "User not found" });
      res.status(200).json({ data: user });
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post("/api/users/toggle-active", async (req, res) => {
    try {
      const { userId, isActive } = req.body;
      if (!userId) return res.status(400).json({ error: "Missing userId" });
      const updateResult = await userCollection.updateOne(
        { uid: userId },
        { $set: { isActive } }
      );
      res.json({ success: true, updateResult });
    } catch (err) {
      console.error("Error toggling active:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/users/update-fcm", async (req, res) => {
    try {
      const { userId, FCMToken } = req.body;
      if (!userId || !FCMToken)
        return res.status(400).json({ error: "Missing userId or FCMToken" });
      await userCollection.updateOne({ uid: userId }, { $set: { FCMToken } });
      res.json({ success: true });
    } catch (err) {
      console.error("Error updating FCM token:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/getUserRole/:userId", async (req, res) => {
    const userId = req.params.userId;
    try {
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
