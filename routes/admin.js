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

  const calculateMonthlyData = async () => {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    // This month revenue
    const thisMonthRevenueAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfThisMonth }, paymentStatus: "approved" } },
        { $group: { _id: null, total: { $sum: "$price" } } }
      ])
      .toArray();
    const thisMonthRevenue = thisMonthRevenueAgg[0]?.total || 0;

    // Last month revenue
    const lastMonthRevenueAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }, paymentStatus: "approved" } },
        { $group: { _id: null, total: { $sum: "$price" } } }
      ])
      .toArray();
    const lastMonthRevenue = lastMonthRevenueAgg[0]?.total || 0;

    // This month enrollments
    const thisMonthEnrollmentsAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfThisMonth }, paymentStatus: "approved" } },
        { $count: "total" }
      ])
      .toArray();
    const thisMonthEnrollments = thisMonthEnrollmentsAgg[0]?.total || 0;

    // Last month enrollments
    const lastMonthEnrollmentsAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }, paymentStatus: "approved" } },
        { $count: "total" }
      ])
      .toArray();
    const lastMonthEnrollments = lastMonthEnrollmentsAgg[0]?.total || 0;

    const revenueChange = thisMonthRevenue - lastMonthRevenue;
    const enrollmentChange = thisMonthEnrollments - lastMonthEnrollments;

    // Store in history collection
    const historyCollection = databaseinmongo.collection("history");
    const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    await historyCollection.updateOne(
      { monthYear },
      {
        $set: {
          monthYear,
          month: now.getMonth() + 1,
          year: now.getFullYear(),
          thisMonthRevenue,
          lastMonthRevenue,
          revenueChange,
          thisMonthEnrollments,
          lastMonthEnrollments,
          enrollmentChange,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    return {
      thisMonthRevenue,
      lastMonthRevenue,
      revenueChange,
      thisMonthEnrollments,
      lastMonthEnrollments,
      enrollmentChange
    };
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

    // Calculate monthly data
    const monthlyData = await calculateMonthlyData();

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
          ...monthlyData,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return { totalMoney, totalAvailableCreditWorth, totalWithdrawals, moneyInPlatform, totalTeacherPoints, ...monthlyData };
  };

  router.get("/download-link", (req, res) => {
    res.json({
      url: "https://www.dropbox.com/scl/fi/syo7s5nvt44iq5sufn516/PoperL.apk?rlkey=w91illigslfci3lky1olytuub6&st=f2zjqc8g&dl=1",
    });
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

  router.get("/dashboard-stats", async (req, res) => {
    try {
      // Count total teachers
      const teacherCountAgg = await userCollection
        .aggregate([
          { $match: { role: "teacher" } },
          { $count: "totalTeachers" }
        ])
        .toArray();
      const totalTeachers = teacherCountAgg[0]?.totalTeachers || 0;

      // Count total students
      const studentCountAgg = await userCollection
        .aggregate([
          { $match: { role: "student" } },
          { $count: "totalStudents" }
        ])
        .toArray();
      const totalStudents = studentCountAgg[0]?.totalStudents || 0;

      // Get platform money summary directly without recalculating
      const summaryCollection = databaseinmongo.collection("platform_money_summary");
      const platformMoneySummary = await summaryCollection.findOne({ _id: "current_platform_money" });

      res.status(200).json({
        success: true,
        data: {
          totalTeachers,
          totalStudents,
          platformMoneySummary: platformMoneySummary || {
            totalMoney: 0,
            totalAvailableCreditWorth: 0,
            totalWithdrawals: 0,
            moneyInPlatform: 0,
            totalTeacherPoints: 0,
            thisMonthRevenue: 0,
            lastMonthRevenue: 0,
            revenueChange: 0,
            thisMonthEnrollments: 0,
            lastMonthEnrollments: 0,
            enrollmentChange: 0,
            updatedAt: new Date()
          }
        }
      });
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res.status(500).json({ success: false, error: "Failed to fetch dashboard statistics" });
    }
  });

  router.post("/generate-monthly-history", async (req, res) => {
    try {
      const monthlyData = await calculateMonthlyData();
      res.status(200).json({
        success: true,
        message: "Monthly history generated successfully",
        data: monthlyData
      });
    } catch (error) {
      console.error("Error generating monthly history:", error);
      res.status(500).json({ success: false, error: "Failed to generate monthly history" });
    }
  });

  router.get("/monthly-history", async (req, res) => {
    try {
      const historyCollection = databaseinmongo.collection("history");
      const result = await historyCollection
        .find()
        .sort({ year: -1, month: -1 })
        .toArray();
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      console.error("Error fetching monthly history:", error);
      res.status(500).json({ success: false, error: "Failed to fetch monthly history" });
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
      const historyCollection = databaseinmongo.collection("history");
      const result = await historyCollection.find().sort({ year: -1, month: -1 }).toArray();
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      console.log(error);
    }
  });

  router.get("/subjects", async (req, res) => {
    try {
      const subjectsCollection = databaseinmongo.collection("subjects");
      const filter = {};
      if (req.query.category) filter.category = req.query.category;
      if (req.query.type) filter.type = req.query.type;
      const result = await subjectsCollection.find(filter).sort({ name: 1 }).toArray();
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false, data: [] });
    }
  });

  router.post("/subjects", async (req, res) => {
    try {
      const { name, category, type } = req.body;
      if (!name || !category || !type) {
        return res.status(400).json({ success: false, message: "name, category and type are required" });
      }
      const subjectsCollection = databaseinmongo.collection("subjects");
      const exists = await subjectsCollection.findOne({ name, category, type });
      if (exists) {
        return res.status(409).json({ success: false, message: "Subject already exists" });
      }
      await subjectsCollection.insertOne({ name, category, type, createdAt: new Date() });
      res.status(201).json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false });
    }
  });

  router.put("/subjects/:id", async (req, res) => {
    try {
      const _id = req.params.id;
      const { name } = req.body;
      if (!name) return res.status(400).json({ success: false, message: "name is required" });
      const subjectsCollection = databaseinmongo.collection("subjects");
      await subjectsCollection.updateOne(
        { _id: new ObjectId(_id) },
        { $set: { name, updatedAt: new Date() } }
      );
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false });
    }
  });

  router.delete("/subjects/:id", async (req, res) => {
    try {
      const _id = req.params.id;
      const subjectsCollection = databaseinmongo.collection("subjects");
      await subjectsCollection.deleteOne({ _id: new ObjectId(_id) });
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false });
    }
  });

  return router;
};
