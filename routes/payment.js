const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeReferralHelpers } = require("../utils/referralHelpers");
const { getSubscriptionStatus } = require("../utils/subscriptionStatus");
const {
  priceCataloguePackage,
  priceCreditPack,
  priceExtension,
} = require("../utils/purchasePricing");

module.exports = ({
  activepackages,
  subscriptions,
  userCollection,
  referrals,
  packages,
  creditPrices,
  shurjopay,
}) => {
  const router = Router();

  /**
   * Turns "what do you want to buy" into "what it costs".
   *
   * The caller supplies a packageId and, for the two computed kinds, how much
   * credit and how many hours they want. Every figure with money attached is
   * looked up or derived here - the body's `amount`, `price`, `credit` and
   * `durationDays` are ignored entirely. They used to BE the price, and a
   * request claiming `amount: 1` was granted outright.
   */
  const resolvePurchase = async ({ packageId, uid, requestedCredit, requestedHours }) => {
    if (packageId === "credit-pack") {
      const sub = await activepackages.findOne({ uid });
      const category = sub?.category || null;
      const type = sub?.type || null;
      const priceDoc = await creditPrices.findOne({ category, type });
      return priceCreditPack({
        requestedCredit,
        pricePerCredit: priceDoc?.pricePerCredit,
        category,
        type,
      });
    }

    if (packageId === "custom-extension") {
      const sub = await activepackages.findOne({ uid });
      return priceExtension({ requestedCredit, requestedHours, subscription: sub });
    }

    if (!packageId || !ObjectId.isValid(packageId)) {
      return { error: "Unknown package." };
    }
    const packageDoc = await packages.findOne({ _id: new ObjectId(packageId) });
    return priceCataloguePackage(packageDoc);
  };

  const { awardReferralCredit } = makeReferralHelpers({
    userCollection,
    referrals,
    activepackages,
    subscriptions,
  });

  router.post("/pay-poperl", async (req, res) => {
    const {
      order_id,
      customer_name,
      customer_phone,
      displayName,
      customer_city,
      currency,
      customer_address,
      packageId,
      requestedCredit,
      requestedHours,
    } = req.body;

    // the buyer is the verified caller, not whoever the body names
    const uid = req.auth?.uid || req.body.uid;
    if (!uid) return res.status(401).json({ error: "Sign in to buy a package." });

    const priced = await resolvePurchase({ packageId, uid, requestedCredit, requestedHours });
    if (priced.error) return res.status(400).json({ error: priced.error });

    const { amount, credit, durationHours, packageName, category, type, isUnlimited } = priced;

    // Only a package the ADMIN priced at zero is granted outright. This used to
    // trigger on `amount < 10` with the amount taken from the request body, so
    // posting `{ amount: 1, credit: 999999 }` bought an unlimited subscription
    // for nothing.
    if (amount === 0) {
      const startDate = new Date();
      const expiryDate = new Date(startDate);
      expiryDate.setHours(expiryDate.getHours() + durationHours);

      await activepackages.updateOne(
        { uid },
        {
          $set: {
            uid,
            packageName,
            startDate: startDate.toISOString(),
            expiryDate: expiryDate.toISOString(),
            credit,
            totalCredit: credit,
            isActive: true,
            paymentStatus: "approved",
            purchasedAt: new Date(),
            category,
            type,
            isUnlimited: Boolean(isUnlimited),
            price: 0,
          },
        },
        { upsert: true }
      );

      return res.json({ checkout_url: "poperl://webview", amount: 0, credit });
    }

    const metadata = {
      customOrderId: order_id,
      paymentType: "new-package",
      uid,
      displayName,
      packageName,
      price: amount,
      durationDays: durationHours,
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
      order_id,
      customer_name,
      customer_phone,
      displayName,
      customer_city,
      currency,
      customer_address,
      packageId,
      requestedCredit,
      requestedHours,
    } = req.body;

    const uid = req.auth?.uid || req.body.uid;
    if (!uid) return res.status(401).json({ error: "Sign in to extend your package." });

    // Same shape as /pay-poperl: the extension is priced against what this
    // buyer originally paid per credit, never against numbers they send.
    const priced = await resolvePurchase({ packageId, uid, requestedCredit, requestedHours });
    if (priced.error) return res.status(400).json({ error: priced.error });

    const { amount, credit, durationHours, packageName, category, type, isUnlimited } = priced;

    if (amount === 0) {
      try {
        const existingPackage = await activepackages.findOne({ uid });
        if (!existingPackage)
          return res.status(404).json({ error: "No active package found" });

        const now = new Date();
        let expiryDate =
          existingPackage.expiryDate && new Date(existingPackage.expiryDate) > now
            ? new Date(existingPackage.expiryDate)
            : new Date(now);
        expiryDate.setHours(expiryDate.getHours() + durationHours);

        const updatedCredit = Number(existingPackage.credit || 0) + credit;
        const updatedTotalCredit = Number(existingPackage.totalCredit || 0) + credit;

        await activepackages.updateOne(
          { uid },
          {
            $set: {
              expiryDate: expiryDate.toISOString(),
              credit: updatedCredit,
              totalCredit: updatedTotalCredit,
              price: (existingPackage.price || 0) + amount,
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
          credit,
          price: amount,
          durationDays: durationHours,
          category,
          type,
          packageType: "extension",
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
      price: amount,
      durationDays: durationHours,
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
                    price: (existingPackage.price || 0) + amount,
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
              type,
              packageType: paymentType,
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
      type = "custom",
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
      let packageType;
      const packageCategory = category || existingPackage?.category || "custom";
      const selectedType = type || existingPackage?.type || "custom";

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
              type: selectedType,
              updatedAt: new Date(),
            },
          }
        );
        packageType = "admin-extension";
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
              type: selectedType,
              price: Number(amountReceived),
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        packageType = "admin-new";
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
        type: selectedType,
        packageType,
        paymentStatus: "admin-added",
        orderId: null,
        internalReference: `ADMIN_${Date.now()}`,
        createdAt: new Date(),
      });

      return res.json({ success: true, type: packageType, packageType, uid, displayName });
    } catch (error) {
      console.error("admin-add-subscription error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/subscription/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      const sub = await activepackages.findOne({ uid: userId });
      const { isSubscribed, outOfCredit } = getSubscriptionStatus(sub);
      // the no-subscription branch used to return `{ subscription: null }` with
      // no isSubscribed key at all, so the client set its flag to undefined
      res.json({ isSubscribed, outOfCredit, subscription: sub || null });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });

  router.post("/api/messages/credit-point", async (req, res) => {
    try {
      // RETIRED. /sendMessage now deducts credit and awards teacher points as
      // part of storing the message, so the amounts are derived server-side
      // instead of being whatever the client asked for. This let a teacher
      // award themselves unlimited points, and a client that died between
      // sending and calling this sent the message for free.
      //
      // Kept as a no-op so an older app build in the wild does not error; it
      // can be deleted once those builds are gone.
      const { userId } = req.body;
      if (req.auth?.uid && userId && userId !== req.auth.uid)
        return res.status(403).json({ error: "Forbidden", reason: "uid_mismatch" });

      res.json({ success: true, deprecated: true, applied: false });
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
