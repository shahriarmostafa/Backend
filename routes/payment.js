const { Router } = require("express");
const { makeReferralHelpers } = require("../utils/referralHelpers");

module.exports = ({
  activepackages,
  subscriptions,
  userCollection,
  referrals,
  shurjopay,
}) => {
  const router = Router();

  const { awardReferralCredit } = makeReferralHelpers({
    userCollection,
    referrals,
    activepackages,
    subscriptions,
  });

  router.post("/pay-poperl", async (req, res) => {
    const {
      amount,
      order_id,
      customer_name,
      customer_phone,
      uid,
      displayName,
      packageName,
      price,
      durationDays,
      customer_city,
      currency,
      customer_address,
      credit,
      category,
      type,
      isUnlimited,
    } = req.body;

    if (amount < 10) {
      const startDate = new Date();
      const expiryDate = new Date(startDate);
      expiryDate.setHours(expiryDate.getHours() + Number(durationDays));

      await activepackages.updateOne(
        { uid },
        {
          $set: {
            uid,
            packageName,
            startDate: startDate.toISOString(),
            expiryDate: expiryDate.toISOString(),
            credit: Number(credit),
            totalCredit: credit,
            isActive: true,
            paymentStatus: "approved",
            purchasedAt: new Date(),
            category,
            type,
            isUnlimited: Boolean(isUnlimited),
            price: Number(price),
          },
        },
        { upsert: true }
      );

      return res.json({ checkout_url: "poperl://webview" });
    }

    const metadata = {
      customOrderId: order_id,
      paymentType: "new-package",
      uid,
      displayName,
      packageName,
      price,
      durationDays,
      credit,
      category,
      type,
      isUnlimited: Boolean(isUnlimited),
    };

    shurjopay.makePayment(
      {
        amount,
        order_id,
        customer_name,
        customer_phone,
        client_ip: req.ip || "127.0.0.1",
        customer_city,
        currency,
        customer_address,
        value1: JSON.stringify(metadata),
      },
      async (resp) => {
        console.log(resp);
        res.json({ checkout_url: resp.checkout_url });
      },
      (err) => {
        console.error("Payment error:", err);
        res.status(500).json({ error: err.message });
      }
    );
  });

  router.post("/extend-package", async (req, res) => {
    const {
      amount,
      order_id,
      customer_name,
      customer_phone,
      uid,
      displayName,
      packageName,
      price,
      durationDays,
      customer_city,
      currency,
      customer_address,
      credit,
      category,
      type,
      isUnlimited,
    } = req.body;

    if (Number(amount) < 10) {
      try {
        const existingPackage = await activepackages.findOne({ uid });
        if (!existingPackage)
          return res.status(404).json({ error: "No active package found" });

        const now = new Date();
        let expiryDate =
          existingPackage.expiryDate && new Date(existingPackage.expiryDate) > now
            ? new Date(existingPackage.expiryDate)
            : new Date(now);
        expiryDate.setHours(expiryDate.getHours() + Number(durationDays));

        const updatedCredit = Number(existingPackage.credit || 0) + Number(credit);
        const updatedTotalCredit = Number(existingPackage.totalCredit || 0) + Number(credit);

        await activepackages.updateOne(
          { uid },
          {
            $set: {
              expiryDate: expiryDate.toISOString(),
              credit: updatedCredit,
              totalCredit: updatedTotalCredit,
              price: (existingPackage.price || 0) + Number(price),
              isUnlimited:
                Boolean(isUnlimited) || Boolean(existingPackage.isUnlimited),
              updatedAt: new Date(),
            },
          }
        );

        await subscriptions.insertOne({
          uid,
          name: displayName,
          packageName,
          credit: Number(credit),
          price: Number(price),
          durationDays: Number(durationDays),
          category,
          type: "extension",
          paymentStatus: "free-extension",
          orderId: null,
          internalReference: `FREE_EXT_${Date.now()}`,
          createdAt: new Date(),
        });

        return res.json({
          success: true,
          instantExtension: true,
          checkout_url: "poperl://webview",
        });
      } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Extension failed" });
      }
    }

    const metadata = {
      paymentType: "extension",
      uid,
      displayName,
      packageName,
      price,
      durationDays,
      credit,
      category,
      type,
      isUnlimited: Boolean(isUnlimited),
    };

    shurjopay.makePayment(
      {
        amount,
        order_id,
        customer_name,
        customer_phone,
        client_ip: req.ip || "127.0.0.1",
        customer_city,
        currency,
        customer_address,
        value1: JSON.stringify(metadata),
      },
      async (resp) => {
        console.log(resp);
        res.json({ checkout_url: resp.checkout_url });
      },
      (err) => {
        console.error("Payment error:", err);
        res.status(500).json({ error: err.message });
      }
    );
  });

  router.get("/ipn", async (req, res) => {
    const { order_id } = req.query;
    if (!order_id) return res.status(400).json({ error: "Missing order_id" });

    try {
      console.log("🔍 Verifying payment:", order_id);

      shurjopay.verifyPayment(
        order_id,
        async (result) => {
          if (!result || result.length === 0)
            return res.status(200).json({ message: "Payment not verified" });

          const data = result[0];
          console.log(data);

          if (data.sp_code === "1000" && data.sp_message === "Success") {
            const metadata = JSON.parse(data.value1);
            const {
              paymentType,
              uid,
              displayName,
              packageName,
              price,
              credit,
              durationDays,
              category,
              type,
              isUnlimited,
            } = metadata;

            const existingOrder = await subscriptions.findOne({ orderId: order_id });
            if (existingOrder) return res.status(200).json({ message: "Already processed" });

            if (paymentType === "new-package") {
              const startDate = new Date();
              const expiryDate = new Date(startDate);
              expiryDate.setHours(expiryDate.getHours() + Number(durationDays));

              await activepackages.updateOne(
                { uid },
                {
                  $set: {
                    uid,
                    packageName,
                    startDate: startDate.toISOString(),
                    expiryDate: expiryDate.toISOString(),
                    credit: Number(credit),
                    totalCredit: Number(credit),
                    isActive: true,
                    paymentStatus: "approved",
                    purchasedAt: new Date(),
                    category,
                    type,
                    isUnlimited: Boolean(isUnlimited),
                    price: Number(price),
                  },
                },
                { upsert: true }
              );
            } else if (paymentType === "extension") {
              const existingPackage = await activepackages.findOne({ uid });
              if (!existingPackage) return res.status(404).json({ error: "Package not found" });

              const now = new Date();
              let expiryDate =
                existingPackage.expiryDate && new Date(existingPackage.expiryDate) > now
                  ? new Date(existingPackage.expiryDate)
                  : new Date(now);
              expiryDate.setHours(expiryDate.getHours() + Number(durationDays));

              const updatedCredit = Number(existingPackage.credit || 0) + Number(credit);
              const updatedTotalCredit =
                Number(existingPackage.totalCredit || 0) + Number(credit);

              await activepackages.updateOne(
                { uid },
                {
                  $set: {
                    expiryDate: expiryDate.toISOString(),
                    credit: updatedCredit,
                    totalCredit: updatedTotalCredit,
                    price: (existingPackage.price || 0) + Number(price),
                    isUnlimited:
                      Boolean(isUnlimited) || Boolean(existingPackage.isUnlimited),
                    updatedAt: new Date(),
                  },
                }
              );
            }

            await subscriptions.insertOne({
              uid,
              name: displayName,
              packageName,
              credit: Number(credit),
              price: Number(price),
              durationDays: Number(durationDays),
              category,
              orderId: order_id,
              type: paymentType,
              paymentStatus: "approved",
              createdAt: new Date(),
            });

            if (paymentType === "new-package" && Number(price) > 0) {
              try {
                const referralResult = await awardReferralCredit(uid, order_id);
                if (referralResult.awarded) {
                  console.log(
                    `Referral reward awarded to UID: ${referralResult.referrerUid}`
                  );
                }
              } catch (referralError) {
                console.error("Referral reward failed:", referralError);
              }
            }

            console.log(`✅ ${paymentType} completed for UID: ${uid}`);
            return res.status(200).json({ message: "Success" });
          } else {
            console.warn(`⚠️ Payment failed for ${order_id}`);
            return res.status(200).json({ message: "Payment failed" });
          }
        },
        (error) => {
          console.error("Verification error:", error);
          return res.status(500).json({ error: "Verification failed" });
        }
      );
    } catch (error) {
      console.error("❌ IPN error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/admin-add-subscription", async (req, res) => {
    const {
      email,
      durationHours,
      credit,
      amountReceived,
      category = "custom",
      type: packageType = "custom",
    } = req.body;

    if (!email || !durationHours || credit === undefined || amountReceived === undefined)
      return res.status(400).json({ error: "Missing required fields" });

    try {
      const user = await userCollection.findOne({ email });
      if (!user) return res.status(404).json({ error: "User not found" });

      const uid = user.uid || user._id?.toString();
      const displayName = user.displayName || user.name || email;
      const existingPackage = await activepackages.findOne({ uid });
      const now = new Date();
      let subscriptionType;
      const packageCategory = category || existingPackage?.category || "custom";
      const selectedPackageType = packageType || existingPackage?.type || "custom";

      if (existingPackage?.expiryDate && new Date(existingPackage.expiryDate) > now) {
        const expiryDate = new Date(existingPackage.expiryDate);
        expiryDate.setHours(expiryDate.getHours() + Number(durationHours));

        const updatedCredit = Number(existingPackage.credit || 0) + Number(credit);
        const updatedTotalCredit = Number(existingPackage.totalCredit || 0) + Number(credit);

        await activepackages.updateOne(
          { uid },
          {
            $set: {
              expiryDate: expiryDate.toISOString(),
              credit: updatedCredit,
              totalCredit: updatedTotalCredit,
              price: (existingPackage.price || 0) + Number(amountReceived),
              category: packageCategory,
              type: selectedPackageType,
              updatedAt: new Date(),
            },
          }
        );
        subscriptionType = "admin-extension";
      } else {
        const startDate = new Date();
        const expiryDate = new Date(startDate);
        expiryDate.setHours(expiryDate.getHours() + Number(durationHours));

        await activepackages.updateOne(
          { uid },
          {
            $set: {
              uid,
              packageName: "Admin Custom",
              startDate: startDate.toISOString(),
              expiryDate: expiryDate.toISOString(),
              credit: Number(credit),
              totalCredit: Number(credit),
              isActive: true,
              paymentStatus: "admin-added",
              purchasedAt: new Date(),
              category: packageCategory,
              type: selectedPackageType,
              price: Number(amountReceived),
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        subscriptionType = "admin-new";
      }

      await subscriptions.insertOne({
        uid,
        name: displayName,
        email,
        packageName: "Admin Custom",
        credit: Number(credit),
        price: Number(amountReceived),
        durationDays: Number(durationHours),
        category: packageCategory,
        packageType: selectedPackageType,
        type: subscriptionType,
        paymentStatus: "admin-added",
        orderId: null,
        internalReference: `ADMIN_${Date.now()}`,
        createdAt: new Date(),
      });

      return res.json({ success: true, type: subscriptionType, uid, displayName });
    } catch (error) {
      console.error("admin-add-subscription error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/subscription/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      const sub = await activepackages.findOne({ uid: userId });
      if (!sub) return res.json({ subscription: null });

      const isValid =
        new Date(sub.expiryDate) > new Date() && sub.credit > 0 && sub.isActive === true;
      res.json({ isSubscribed: isValid, subscription: sub });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });

  router.post("/api/messages/credit-point", async (req, res) => {
    try {
      const { userId, role, creditToDeduct, pointsToAdd } = req.body;
      const normalizedCreditToDeduct = Math.ceil(Number(creditToDeduct) || 0);

      if (!userId || !role)
        return res.status(400).json({ error: "Missing required fields" });

      if (role === "teacher" && pointsToAdd > 0) {
        await userCollection.updateOne(
          { uid: userId, role: "teacher" },
          { $inc: { points: pointsToAdd } }
        );
      } else if (role === "student" && normalizedCreditToDeduct > 0) {
        await activepackages.updateOne(
          { uid: userId },
          { $inc: { credit: -normalizedCreditToDeduct } }
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error in process route:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/sub-check/:callerId", async (req, res) => {
    try {
      const { callerId } = req.params;
      const subscription = await activepackages.findOne({ uid: callerId });
      if (!subscription) return res.json({ isValid: false, credit: 0 });

      const now = new Date();
      const expiryDate = new Date(subscription.expiryDate);
      const isValid =
        subscription?.isActive === true && expiryDate > now && subscription.credit > 0;
      res.json({ isValid, credit: subscription.credit });
    } catch (err) {
      console.error("Error fetching subscription:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
