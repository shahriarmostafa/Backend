const { Router } = require("express");
const { ObjectId } = require("mongodb");

module.exports = ({ userCollection, subscriptions, withdrawals, activepackages, databaseinmongo }) => {
  const router = Router();

  const calculateTotalTeacherPoints = async () => {
    const result = await userCollection
      .aggregate([
        { $match: { role: "teacher", points: { $exists: true } } },
        { $group: { _id: null, totalPoints: { $sum: "$points" } } },
      ])
      .toArray();
    return result[0]?.totalPoints || 0;
  };

  const calculatePlatformMoney = async () => {
    const totalMoneyAgg = await subscriptions
      .aggregate([{ $group: { _id: null, totalMoney: { $sum: "$price" } } }])
      .toArray();
    const totalMoney = totalMoneyAgg[0]?.totalMoney || 0;

    const now = new Date();
    const availableCreditWorthAgg = await activepackages
      .aggregate([
        { $addFields: { expiryDateObj: { $toDate: "$expiryDate" } } },
        { $match: { expiryDateObj: { $gt: now } } },
        {
          $project: {
            creditWorth: { $multiply: ["$credit", { $divide: ["$price", "$totalCredit"] }] },
          },
        },
        { $group: { _id: null, totalCreditWorth: { $sum: "$creditWorth" } } },
      ])
      .toArray();
    const totalAvailableCreditWorth = availableCreditWorthAgg[0]?.totalCreditWorth || 0;

    const totalWithdrawalsAgg = await withdrawals
      .aggregate([
        { $match: { paid: true } },
        { $group: { _id: null, totalWithdrawals: { $sum: "$amount" } } },
      ])
      .toArray();
    const totalWithdrawals = totalWithdrawalsAgg[0]?.totalWithdrawals || 0;

    const moneyInPlatform = totalMoney - totalAvailableCreditWorth - totalWithdrawals;
    const totalTeacherPoints = await calculateTotalTeacherPoints();

    const summaryCollection = databaseinmongo.collection("platform_money_summary");
    const summaryId = "current_platform_money";
    await summaryCollection.updateOne(
      { _id: summaryId },
      {
        $set: {
          _id: summaryId,
          totalMoney,
          totalAvailableCreditWorth,
          totalWithdrawals,
          moneyInPlatform,
          totalTeacherPoints,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return { totalMoney, totalAvailableCreditWorth, totalWithdrawals, moneyInPlatform, totalTeacherPoints };
  };

  router.get("/download-link", (req, res) => {
    res.json({
      url: "https://www.dropbox.com/scl/fi/syo7s5nvt44iq5sufn516/PoperL.apk?rlkey=w91illigslfci3lky1olytuub6&st=f2zjqc8g&dl=1",
    });
  });

  router.post("/closeCalculation", async (req, res) => {
    try {
      const teachersSnapshot = await userCollection.where("role", "==", "teacher").get();
      if (teachersSnapshot.empty)
        return res.status(404).json({ success: false, message: "No teachers found." });

      const totalRevenueResult = await subscriptions
        .aggregate([{ $group: { _id: null, totalRevenue: { $sum: "$price" } } }])
        .toArray();
      const totalRevenue = totalRevenueResult[0]?.totalRevenue || 0;

      let totalPoints = 0;
      const teacherEarnings = [];

      teachersSnapshot.forEach((doc) => {
        totalPoints += doc.data().points || 0;
      });

      teachersSnapshot.forEach((doc) => {
        const teacher = doc.data();
        const points = teacher.points || 0;
        const revenuePercent = teacher.revenuePercent || 0;
        const income = totalPoints > 0 ? (points / totalPoints) * totalRevenue * revenuePercent : 0;
        teacherEarnings.push({
          uid: teacher.uid,
          name: teacher.displayName,
          whatsapp: teacher.whatsapp,
          points,
          income: Math.floor(income),
          paid: false,
        });
      });

      await databaseinmongo.collection("revenueHistory").insertOne({
        totalPoints,
        totalRevenue,
        createdAt: new Date(),
        enrols: await databaseinmongo.collection("subscriptions").countDocuments(),
      });
      await databaseinmongo.collection("salaryHistory").insertMany(teacherEarnings);

      res.json({
        success: true,
        message: "Calculation completed and salary data stored successfully.",
        totalRevenue,
        totalPoints,
        teachersProcessed: teacherEarnings.length,
      });
    } catch (err) {
      console.error("Error in /closeCalculation:", err);
      res.status(500).json({ success: false, message: "Server error during calculation process." });
    }
  });

  router.get("/point-value", async (req, res) => {
    const summaryId = "current_platform_money";
    await calculatePlatformMoney().then(console.log).catch(console.error);

    try {
      const summaryCollection = databaseinmongo.collection("platform_money_summary");
      const summaryDoc = await summaryCollection.findOne({ _id: summaryId });
      if (!summaryDoc)
        return res.status(404).json({ error: "Summary document not found." });

      const { moneyInPlatform, totalTeacherPoints } = summaryDoc;
      if (!totalTeacherPoints || totalTeacherPoints === 0)
        return res.status(400).json({ error: "totalTeacherPoints is zero or missing." });

      res.json({ pointValue: moneyInPlatform / totalTeacherPoints });
    } catch (error) {
      console.error("Error fetching point value:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  router.post("/subscriptions", async (req, res) => {
    try {
      await subscriptions.insertOne(req.body);
    } catch (err) {
      console.log(err);
    }
  });

  router.get("/salaryData", async (req, res) => {
    try {
      const salaryCollection = databaseinmongo.collection("salaryHistory");
      const result = await salaryCollection.find().toArray();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.log(err);
    }
  });

  router.get("/historyData", async (req, res) => {
    try {
      const revenueHistory = databaseinmongo.collection("revenueHistory");
      const result = await revenueHistory.find().toArray();
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      console.log(error);
    }
  });

  router.patch("/paySalary/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const salaryCollection = databaseinmongo.collection("salaryHistory");
      await salaryCollection.updateOne({ uid: id }, { $set: { paid: true } });
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  router.post("/complain", async (req, res) => {
    try {
      const complains = databaseinmongo.collection("complains");
      await complains.insertOne(req.body);
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  router.get("/complain/:id", async (req, res) => {
    try {
      const uid = req.params.id;
      const complains = databaseinmongo.collection("complains");
      const result = await complains.find({ uid }).toArray();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.log(err);
    }
  });

  router.get("/complain", async (req, res) => {
    try {
      const complains = databaseinmongo.collection("complains");
      const result = await complains.find().toArray();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.log(err);
    }
  });

  router.delete("/complain/:id", async (req, res) => {
    try {
      const _id = req.params.id;
      const complains = databaseinmongo.collection("complains");
      await complains.deleteOne({ _id: new ObjectId(_id) });
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  router.post("/pack", async (req, res) => {
    try {
      const packages = databaseinmongo.collection("packages");
      await packages.insertOne(req.body);
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  router.get("/pack", async (req, res) => {
    try {
      const packages = databaseinmongo.collection("packages");
      const result = await packages.find().toArray();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.log(err);
    }
  });

  router.post("/credit-price", async (req, res) => {
    try {
      const { category, type, pricePerCredit } = req.body;
      const creditPrices = databaseinmongo.collection("creditPrices");
      await creditPrices.updateOne(
        { category, type },
        {
          $set: {
            category,
            type,
            pricePerCredit: Number(pricePerCredit),
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false });
    }
  });

  router.get("/credit-prices", async (req, res) => {
    try {
      const creditPrices = databaseinmongo.collection("creditPrices");
      const result = await creditPrices.find().toArray();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false, data: [] });
    }
  });

  router.delete("/pack/:id", async (req, res) => {
    try {
      const _id = req.params.id;
      const packages = databaseinmongo.collection("packages");
      await packages.deleteOne({ _id: new ObjectId(_id) });
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  router.put("/pack/:id", async (req, res) => {
    try {
      const _id = req.params.id;
      const packages = databaseinmongo.collection("packages");
      await packages.updateOne(
        { _id: new ObjectId(_id) },
        {
          $set: {
            price: req.body.price,
            credit: req.body.credit,
            name: req.body.name,
            type: req.body.type,
          },
        }
      );
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  return router;
};
