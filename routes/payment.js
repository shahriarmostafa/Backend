const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeReferralHelpers } = require("../utils/referralHelpers");
const { getSubscriptionStatus } = require("../utils/subscriptionStatus");
const {
  priceCataloguePackage,
  priceCreditPack,
  priceExtension,
} = require("../utils/purchasePricing");
const { resolveActor } = require("../utils/actor");

module.exports = ({
  activepackages,
  subscriptions,
  userCollection,
  referrals,
  packages,
  creditPrices,
  shurjopay,
  shurjopayWeb = null,
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
      // A student who never subscribed has no package to read the profile
      // from; the app prices them by their study profile, so the server must
      // too or it refuses the sale it just quoted.
      const profile = sub?.category ? null : await userCollection.findOne({ uid }, { projection: { category: 1, type: 1 } });
      const category = sub?.category || profile?.category || null;
      const type = sub?.type || profile?.type || null;
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

  const getGatewayAmount = (amount) => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return null;
    return String(Math.round(value));
  };

  // ShurjoPay requires a phone, city and address on every order. The app used
  // to send one hard-coded number and address for every customer; use the
  // customer's own number when we have one and keep the defaults configurable.
  const DEFAULT_CUSTOMER = {
    phone: process.env.SP_DEFAULT_CUSTOMER_PHONE || "01875460458",
    city: process.env.SP_DEFAULT_CUSTOMER_CITY || "Dhaka",
    address: process.env.SP_DEFAULT_CUSTOMER_ADDRESS || "Uttara, Sector 10, Dhaka",
  };
  const normalizePhone = (value) => String(value || "").replace(/[\s-]/g, "").replace(/^\+?88/, "");
  const resolveCustomer = async ({ uid, customer_name, customer_phone, customer_city, customer_address }) => {
    const user = uid
      ? await userCollection.findOne({ uid }, { projection: { displayName: 1, phone: 1, whatsapp: 1 } })
      : null;
    const phone = [customer_phone, user?.phone, user?.whatsapp]
      .map(normalizePhone)
      .find((value) => /^01[3-9]\d{8}$/.test(value));
    return {
      customer_name: customer_name || user?.displayName || "PoperL customer",
      customer_phone: phone || DEFAULT_CUSTOMER.phone,
      customer_city: customer_city || DEFAULT_CUSTOMER.city,
      customer_address: customer_address || DEFAULT_CUSTOMER.address,
    };
  };

  const startGatewayCheckout = async ({
    res,
    orderId,
    amount,
    clientAmount,
    customer_name,
    customer_phone,
    customer_city,
    currency,
    customer_address,
    metadata,
    context,
    returnTo,
  }) => {
    // The app's checkout returns to poperl://; a browser can't open that, so
    // web checkouts use the instance configured with the web return URL.
    const gateway = returnTo === "web" && shurjopayWeb ? shurjopayWeb : shurjopay;
    const customer = await resolveCustomer({
      uid: metadata?.value?.uid,
      customer_name,
      customer_phone,
      customer_city,
      customer_address,
    });
    const gatewayAmount = getGatewayAmount(amount);
    if (!gatewayAmount) {
      return res.status(400).json({
        error: "Could not calculate a valid payment amount for this purchase.",
      });
    }

    const clientValue = Number(clientAmount);
    if (Number.isFinite(clientValue) && Math.round(clientValue) !== Number(gatewayAmount)) {
      console.warn("Client quoted amount differs from server amount:", {
        context,
        orderId,
        clientAmount: clientValue,
        serverAmount: Number(gatewayAmount),
      });
    }

    const checkoutPayload = {
      amount: gatewayAmount,
      order_id: orderId,
      ...customer,
      client_ip: reqIpSafe(metadata.reqIp),
      currency: currency || "BDT",
      value1: JSON.stringify(metadata.value),
    };

    console.info("Starting ShurjoPay checkout:", {
      context,
      orderId,
      amount: checkoutPayload.amount,
      returnTo: gateway === shurjopayWeb ? "web" : "app",
      usedDefaultPhone: customer.customer_phone === DEFAULT_CUSTOMER.phone,
      currency: checkoutPayload.currency,
    });

    gateway.makePayment(
      checkoutPayload,
      async (resp) => {
        if (!resp?.checkout_url) {
          console.error("Payment gateway rejected checkout:", {
            context,
            orderId,
            amount: gatewayAmount,
            payloadKeys: Object.keys(checkoutPayload),
            response: resp,
          });
          return res.status(502).json({
            error: "Payment gateway rejected checkout.",
            details: resp,
          });
        }

        res.json({ checkout_url: resp.checkout_url });
      },
      (err) => {
        const details = err.response?.data || err.message;
        console.error("Payment error:", details);
        res.status(500).json({ error: err.message, details });
      }
    );
  };

  const reqIpSafe = (ip) => ip || "127.0.0.1";

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
      amount: clientAmount,
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
      // Once per student per free package. It used to be claimable on repeat,
      // and each claim $set the credit - so it refilled an empty balance for
      // free, and wiped a paying student's remaining credit down to the free
      // amount. The claim record's _id is the lock: a second insert fails.
      try {
        await subscriptions.insertOne({
          _id: `free:${uid}:${packageId}`,
          uid,
          name: displayName,
          packageName,
          credit,
          price: 0,
          durationDays: durationHours,
          category,
          type,
          packageType: "free",
          paymentStatus: "free",
          orderId: null,
          createdAt: new Date(),
        });
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: "You have already claimed this free package." });
        }
        throw err;
      }

      const startDate = new Date();
      const existing = await activepackages.findOne({ uid });
      const currentExpiry = existing?.expiryDate ? new Date(existing.expiryDate) : null;
      const expiryDate = currentExpiry && currentExpiry > startDate ? new Date(currentExpiry) : new Date(startDate);
      expiryDate.setHours(expiryDate.getHours() + durationHours);

      await activepackages.updateOne(
        { uid },
        {
          $set: {
            uid,
            packageName: existing?.packageName || packageName,
            startDate: existing?.startDate || startDate.toISOString(),
            expiryDate: expiryDate.toISOString(),
            isActive: true,
            paymentStatus: "approved",
            purchasedAt: existing?.purchasedAt || new Date(),
            category: existing?.category || category,
            type: existing?.type || type,
            isUnlimited: Boolean(existing?.isUnlimited || isUnlimited),
          },
          // added on top of whatever the student already has
          $inc: { credit, totalCredit: credit },
          $setOnInsert: { price: 0 },
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

    return startGatewayCheckout({
      res,
      orderId: order_id,
      amount,
      clientAmount,
      customer_name,
      customer_phone,
      customer_city,
      currency,
      customer_address,
      metadata: { reqIp: req.ip, value: metadata },
      context: "new-package",
      returnTo: req.body.returnTo,
    });
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
      amount: clientAmount,
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

    return startGatewayCheckout({
      res,
      orderId: order_id,
      amount,
      clientAmount,
      customer_name,
      customer_phone,
      customer_city,
      currency,
      customer_address,
      metadata: { reqIp: req.ip, value: metadata },
      context: "extension",
      returnTo: req.body.returnTo,
    });
  });

  // ShurjoPay's verification as a promise. The library never calls back when
  // its own token request fails, so give up after a while instead of hanging.
  const verifyOrder = (orderId) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Payment verification timed out")), 20000);
      shurjopay.verifyPayment(
        orderId,
        (result) => {
          clearTimeout(timer);
          resolve(Array.isArray(result) && result.length ? result[0] : null);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });

  const isPaid = (data) => String(data?.sp_code) === "1000" && data?.sp_message === "Success";

  /**
   * Grants a verified, paid order. Safe to call more than once for the same
   * order (the gateway callback and the app's own check after returning from
   * checkout both do): the order is claimed before anything is granted.
   */
  const applyPaidOrder = async (order_id, data) => {
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
    if (existingOrder) return { outcome: "already-processed", uid };

    // Claim the order before granting anything. The findOne above and
    // the insert below were separate steps, so two callbacks for the
    // same order (gateway retries, or someone replaying /ipn) could
    // both pass the check and both add credit. The _id makes the
    // second claim fail.
    const claimId = `order:${order_id}`;
    try {
      await subscriptions.insertOne({
        _id: claimId,
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
        paymentStatus: "processing",
        createdAt: new Date(),
      });
    } catch (claimError) {
      if (claimError?.code === 11000) return { outcome: "already-processed", uid };
      throw claimError;
    }

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
      if (!existingPackage) {
        // Paid, but there is nothing to extend. Keep the claim so it is
        // not applied twice, and leave it where an admin will see it.
        console.error(`[payment] paid extension ${order_id} for ${uid} has no package to extend`);
        await subscriptions.updateOne(
          { _id: claimId },
          { $set: { paymentStatus: "needs-review", reviewReason: "no-active-package" } }
        );
        return { outcome: "needs-review", uid };
      }

      const now = new Date();
      let expiryDate =
        existingPackage.expiryDate && new Date(existingPackage.expiryDate) > now
          ? new Date(existingPackage.expiryDate)
          : new Date(now);
      expiryDate.setHours(expiryDate.getHours() + Number(durationDays));

      // $inc, not a $set computed from the read above: a call or a
      // message charged in between used to be overwritten.
      await activepackages.updateOne(
        { uid },
        {
          $set: {
            expiryDate: expiryDate.toISOString(),
            isUnlimited:
              Boolean(isUnlimited) || Boolean(existingPackage.isUnlimited),
            updatedAt: new Date(),
          },
          $inc: {
            credit: Number(credit) || 0,
            totalCredit: Number(credit) || 0,
            price: Number(price) || 0,
          },
        }
      );
    }

    await subscriptions.updateOne(
      { _id: claimId },
      { $set: { paymentStatus: "approved", approvedAt: new Date() } }
    );

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

    console.log(`[payment] ${paymentType} completed for UID: ${uid}`);
    return { outcome: "applied", uid };
  };

  router.get("/ipn", async (req, res) => {
    const { order_id } = req.query;
    if (!order_id) return res.status(400).json({ error: "Missing order_id" });

    try {
      const data = await verifyOrder(order_id);
      if (!data) return res.status(200).json({ message: "Payment not verified" });
      if (!isPaid(data)) {
        console.warn(`[payment] payment failed for ${order_id}`);
        return res.status(200).json({ message: "Payment failed" });
      }
      const { outcome } = await applyPaidOrder(order_id, data);
      return res.status(200).json({
        message: outcome === "applied" ? "Success" : outcome === "needs-review" ? "Payment received; package needs review" : "Already processed",
      });
    } catch (error) {
      console.error("❌ IPN error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * What happened to a checkout, asked by the app when the student comes back
   * from the payment page.
   *
   * The return link can't say: the ShurjoPay library sends both a completed
   * and a cancelled payment to the same return URL (SP_CANCEL_URL is never
   * used), so the app used to announce success for a cancelled payment. This
   * asks the gateway, and grants the purchase if the gateway's own callback
   * has not landed yet.
   */
  router.get("/api/payments/:orderId/status", async (req, res) => {
    try {
      const caller = await resolveActor(req, res, null);
      if (!caller) return;
      const data = await verifyOrder(req.params.orderId).catch(() => null);
      if (!data) return res.json({ status: "pending" });

      let metadata = {};
      try {
        metadata = JSON.parse(data.value1 || "{}");
      } catch {
        metadata = {};
      }
      if (metadata.uid !== caller && !(await req.isOwner?.())) {
        return res.status(403).json({ error: "This is not your payment." });
      }

      if (!isPaid(data)) {
        const cancelled = /cancel/i.test(String(data.sp_message || ""));
        return res.json({ status: cancelled ? "cancelled" : "failed", message: data.sp_message || null });
      }
      const { outcome } = await applyPaidOrder(req.params.orderId, data);
      return res.json({ status: outcome === "needs-review" ? "needs-review" : "success" });
    } catch (error) {
      console.error("Payment status check failed:", error);
      return res.status(500).json({ error: "Could not check the payment." });
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
    const userId = await resolveActor(req, res, req.params.userId);
    if (!userId) return;
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
      const callerId = await resolveActor(req, res, req.params.callerId);
      if (!callerId) return;
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
