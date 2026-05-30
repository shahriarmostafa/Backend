const { REFERRAL_REWARD_CREDIT, REFERRAL_REWARD_DURATION_HOURS } = require("./constants");

const makeReferralHelpers = ({ userCollection, referrals, activepackages, subscriptions }) => {
  const awardReferralCredit = async (referredUid, qualifyingOrderId = null) => {
    if (!referredUid) return { awarded: false, reason: "missing-referred-uid" };

    const referredUser = await userCollection.findOne({ uid: referredUid });
    const referrerUid = referredUser?.referredByUid;

    if (!referrerUid || referrerUid === referredUid)
      return { awarded: false, reason: "no-valid-referrer" };

    const alreadyAwarded = await referrals.findOne({
      referredUid,
      rewardStatus: "awarded",
    });
    if (alreadyAwarded) return { awarded: false, reason: "already-awarded" };

    const referrerUser = await userCollection.findOne({ uid: referrerUid });
    if (!referrerUser) return { awarded: false, reason: "referrer-not-found" };

    const now = new Date();
    const existingPackage = await activepackages.findOne({ uid: referrerUid });
    const hasActiveDuration =
      existingPackage?.isUnlimited ||
      (existingPackage?.expiryDate && new Date(existingPackage.expiryDate) > now);

    if (existingPackage && hasActiveDuration) {
      const expiryDate = existingPackage.isUnlimited
        ? existingPackage.expiryDate
        : new Date(existingPackage.expiryDate);

      if (!existingPackage.isUnlimited) {
        expiryDate.setHours(expiryDate.getHours() + REFERRAL_REWARD_DURATION_HOURS);
      }

      await activepackages.updateOne(
        { uid: referrerUid },
        {
          $set: {
            ...(existingPackage.isUnlimited ? {} : { expiryDate: expiryDate.toISOString() }),
            credit: Number(existingPackage.credit || 0) + REFERRAL_REWARD_CREDIT,
            totalCredit: Number(existingPackage.totalCredit || 0) + REFERRAL_REWARD_CREDIT,
            updatedAt: now,
          },
        }
      );
    } else {
      const startDate = now;
      const expiryDate = new Date(startDate);
      expiryDate.setHours(expiryDate.getHours() + REFERRAL_REWARD_DURATION_HOURS);

      await activepackages.updateOne(
        { uid: referrerUid },
        {
          $set: {
            uid: referrerUid,
            packageName: "Referral Reward",
            startDate: startDate.toISOString(),
            expiryDate: expiryDate.toISOString(),
            credit: REFERRAL_REWARD_CREDIT,
            totalCredit: REFERRAL_REWARD_CREDIT,
            isActive: true,
            paymentStatus: "approved",
            purchasedAt: now,
            category: existingPackage?.category || "referral",
            type: existingPackage?.type || "referral",
            isUnlimited: false,
            price: 0,
            updatedAt: now,
          },
        },
        { upsert: true }
      );
    }

    await referrals.updateOne(
      { referredUid },
      {
        $set: {
          referrerUid,
          referredUid,
          qualifyingOrderId,
          rewardCredit: REFERRAL_REWARD_CREDIT,
          rewardDurationHours: REFERRAL_REWARD_DURATION_HOURS,
          rewardStatus: "awarded",
          awardedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    await userCollection.updateOne(
      { uid: referredUid },
      { $set: { referralRewardedAt: now } }
    );

    await subscriptions.insertOne({
      uid: referrerUid,
      name: referrerUser.displayName,
      packageName: "Referral Reward",
      credit: REFERRAL_REWARD_CREDIT,
      price: 0,
      durationDays: REFERRAL_REWARD_DURATION_HOURS,
      category: existingPackage?.category || "referral",
      orderId: qualifyingOrderId,
      type: "referral-reward",
      paymentStatus: "approved",
      referredUid,
      createdAt: now,
    });

    return { awarded: true, referrerUid };
  };

  return { awardReferralCredit };
};

module.exports = { makeReferralHelpers };
