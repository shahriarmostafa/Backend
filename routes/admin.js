const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeRoomHelpers } = require("../utils/roomHelpers");
const { makeSupabaseStorage } = require("../utils/supabaseStorage");
const {
  STUDY_ROOM_MAX_STUDENTS,
  STUDY_ROOM_MONTH_MS,
} = require("../utils/constants");

module.exports = ({ userCollection, subscriptions, withdrawals, activepackages, publicQuizzes, studyRooms, roomQuizzes, databaseinmongo }) => {
  const router = Router();
  const {
    hydrateStudyRoom,
    createStudyRoomChat,
    ensureRoomChatSubscriptions,
    getUniqueRoomKeyword,
  } = makeRoomHelpers({ userCollection, databaseinmongo, studyRooms, activepackages, roomQuizzes });
  const supabaseStorage = makeSupabaseStorage();

  const getScopedFilter = (category, type) => {
    const filter = {};
    if (category && category !== "general") filter.category = category;
    if (type && type !== "general") filter.type = type;
    return filter;
  };

  const getSummaryId = (category, type) =>
    (category && category !== "general") || (type && type !== "general")
      ? `${category || "all"}:${type || "all"}`
      : "general";

  const calculateTotalTeacherPoints = async (category, type) => {
    const match = { role: "teacher", points: { $exists: true }, ...getScopedFilter(category, type) };
    const result = await userCollection
      .aggregate([
        { $match: match },
        { $group: { _id: null, totalPoints: { $sum: "$points" } } },
      ])
      .toArray();
    return result[0]?.totalPoints || 0;
  };

  const calculateMonthlyData = async (category, type) => {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const scopedFilter = getScopedFilter(category, type);

    // This month revenue
    const thisMonthRevenueAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfThisMonth }, paymentStatus: "approved", ...scopedFilter } },
        { $group: { _id: null, total: { $sum: "$price" } } }
      ])
      .toArray();
    const thisMonthRevenue = thisMonthRevenueAgg[0]?.total || 0;

    // Last month revenue
    const lastMonthRevenueAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }, paymentStatus: "approved", ...scopedFilter } },
        { $group: { _id: null, total: { $sum: "$price" } } }
      ])
      .toArray();
    const lastMonthRevenue = lastMonthRevenueAgg[0]?.total || 0;

    // This month enrollments
    const thisMonthEnrollmentsAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfThisMonth }, paymentStatus: "approved", ...scopedFilter } },
        { $count: "total" }
      ])
      .toArray();
    const thisMonthEnrollments = thisMonthEnrollmentsAgg[0]?.total || 0;

    // Last month enrollments
    const lastMonthEnrollmentsAgg = await subscriptions
      .aggregate([
        { $match: { createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }, paymentStatus: "approved", ...scopedFilter } },
        { $count: "total" }
      ])
      .toArray();
    const lastMonthEnrollments = lastMonthEnrollmentsAgg[0]?.total || 0;

    const revenueChange = thisMonthRevenue - lastMonthRevenue;
    const enrollmentChange = thisMonthEnrollments - lastMonthEnrollments;

    // Store in history collection
    const historyCollection = databaseinmongo.collection("history");
    const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const summaryId = getSummaryId(category, type);
    
    await historyCollection.updateOne(
      { monthYear, summaryId },
      {
        $set: {
          summaryId,
          category: category || "general",
          type: type || "general",
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

  const calculatePlatformMoney = async (category, type) => {
    const scopedFilter = getScopedFilter(category, type);
    const totalMoneyAgg = await subscriptions
      .aggregate([
        { $match: scopedFilter },
        { $group: { _id: null, totalMoney: { $sum: "$price" } } },
      ])
      .toArray();
    const totalMoney = totalMoneyAgg[0]?.totalMoney || 0;

    const now = new Date();
    const availableCreditWorthAgg = await activepackages
      .aggregate([
        { $addFields: { expiryDateObj: { $toDate: "$expiryDate" } } },
        { $match: { expiryDateObj: { $gt: now }, ...scopedFilter } },
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
        { $match: { paid: true, ...scopedFilter } },
        { $group: { _id: null, totalWithdrawals: { $sum: "$amount" } } },
      ])
      .toArray();
    const totalWithdrawals = totalWithdrawalsAgg[0]?.totalWithdrawals || 0;

    const moneyInPlatform = totalMoney - totalAvailableCreditWorth - totalWithdrawals;
    const totalTeacherPoints = await calculateTotalTeacherPoints(category, type);

    const summaryCollection = databaseinmongo.collection("platform_money_summary");
    const summaryId = getSummaryId(category, type);
    await summaryCollection.updateOne(
      { _id: summaryId },
      {
        $set: {
          _id: summaryId,
          category: category || "general",
          type: type || "general",
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

    return { _id: summaryId, category: category || "general", type: type || "general", totalMoney, totalAvailableCreditWorth, totalWithdrawals, moneyInPlatform, totalTeacherPoints, updatedAt: new Date() };
  };

  const sumPlatformMoneySummaries = async () => {
    const summaryCollection = databaseinmongo.collection("platform_money_summary");
    const sourceDocs = await summaryCollection
      .find({ _id: { $ne: "current_platform_money" } })
      .toArray();
    const fields = [
      "totalMoney",
      "totalAvailableCreditWorth",
      "totalWithdrawals",
      "moneyInPlatform",
      "totalTeacherPoints",
    ];
    const summary = fields.reduce((acc, field) => {
      acc[field] = sourceDocs.reduce((total, doc) => total + (Number(doc[field]) || 0), 0);
      return acc;
    }, {});
    return { _id: "all", category: "all", type: "all", ...summary, updatedAt: new Date() };
  };

  const getLatestMonthlyHistory = async () => {
    const historyCollection = databaseinmongo.collection("history");
    const latestHistory = await historyCollection
      .find({ summaryId: { $in: [null, "general"] } })
      .sort({ year: -1, month: -1, updatedAt: -1 })
      .limit(1)
      .toArray();
    const history = latestHistory[0] || {};
    return {
      thisMonthRevenue: Number(history.thisMonthRevenue) || 0,
      lastMonthRevenue: Number(history.lastMonthRevenue) || 0,
      revenueChange: Number(history.revenueChange) || 0,
      thisMonthEnrollments: Number(history.thisMonthEnrollments) || 0,
      lastMonthEnrollments: Number(history.lastMonthEnrollments) || 0,
      enrollmentChange: Number(history.enrollmentChange) || 0,
    };
  };

  router.get("/download-link", (req, res) => {
    res.json({
      url: "https://github.com/shahriarmostafa/The-release/releases/download/v1.0.0/PoperLApk.apk",
    });
  });



  router.get("/point-value", async (req, res) => {
    const { category, type } = req.query;
    const summaryId = getSummaryId(category, type);
    await calculatePlatformMoney(category, type).catch(console.error);

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
      await salaryCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { paid: true, paidAt: new Date() } }
      );
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
    }
  });

  router.get("/api/teachers/:uid/earnings", async (req, res) => {
    try {
      const { uid } = req.params;
      const { category, type } = req.query;
      const teacher = await userCollection.findOne({ uid, role: "teacher" });
      if (!teacher) return res.status(404).json({ error: "Teacher not found" });

      const scopedCategory = category || teacher.category || "general";
      const scopedType = type || teacher.type || "general";
      await calculatePlatformMoney(scopedCategory, scopedType);

      const summaryCollection = databaseinmongo.collection("platform_money_summary");
      const summary = await summaryCollection.findOne({ _id: getSummaryId(scopedCategory, scopedType) });

      const points = Number(teacher.points) || 0;
      const totalTeacherPoints = Number(summary?.totalTeacherPoints) || 0;
      const moneyInPlatform = Number(summary?.moneyInPlatform) || 0;
      const pointValue = totalTeacherPoints > 0 ? moneyInPlatform / totalTeacherPoints : 0;
      const earnings = Math.round(points * pointValue * 100) / 100;

      res.json({ success: true, points, totalPoints: teacher.totalPoints || 0, pointValue, earnings, moneyInPlatform, totalTeacherPoints, category: scopedCategory, type: scopedType });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  });

  router.post("/api/teachers/withdraw", async (req, res) => {
    try {
      const { uid, bkashNumber } = req.body;
      if (!uid || !bkashNumber) return res.status(400).json({ error: "uid and bkashNumber are required" });

      const teacher = await userCollection.findOne({ uid, role: "teacher" });
      if (!teacher) return res.status(404).json({ error: "Teacher not found" });

      const points = Number(teacher.points) || 0;
      if (points < 100) return res.status(400).json({ error: "Minimum 100 points required to withdraw" });

      const freshData = await calculatePlatformMoney(teacher.category, teacher.type);
      const { moneyInPlatform, totalTeacherPoints } = freshData;

      const pointValue = totalTeacherPoints > 0 ? moneyInPlatform / totalTeacherPoints : 0;
      const amount = Math.round(points * pointValue * 100) / 100;

      const salaryCollection = databaseinmongo.collection("salaryHistory");
      await salaryCollection.insertOne({
        uid,
        name: teacher.displayName || "",
        category: teacher.category || "general",
        type: teacher.type || "general",
        bkashNumber,
        points,
        amount,
        pointValue,
        paid: false,
        requestedAt: new Date(),
        paidAt: null,
      });

      await userCollection.updateOne(
        { uid },
        { $inc: { totalPoints: points }, $set: { points: 0 } }
      );

      res.json({ success: true, amount, points });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
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

      const platformMoneySummary = await sumPlatformMoneySummaries();
      const monthlyHistory = await getLatestMonthlyHistory();

      res.status(200).json({
        success: true,
        data: {
          totalTeachers,
          totalStudents,
          platformMoneySummary: {
            totalMoney: 0,
            totalAvailableCreditWorth: 0,
            totalWithdrawals: 0,
            moneyInPlatform: 0,
            totalTeacherPoints: 0,
            updatedAt: new Date(),
            ...(platformMoneySummary || {}),
            ...monthlyHistory,
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
      const { category, type } = req.body || {};
      const monthlyData = await calculateMonthlyData(category, type);
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
      const result = await salaryCollection
        .find()
        .sort({ paid: 1, requestedAt: -1 })
        .toArray();
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

  router.get("/api/admin/public-quizzes", async (req, res) => {
    try {
      const { category, type, subject, teacherId } = req.query;
      const filter = {};
      if (category) filter.category = category;
      if (type) filter.type = type;
      if (subject) filter.subject = subject;
      if (teacherId) filter.teacherId = teacherId;

      const quizzes = await publicQuizzes
        .find(filter)
        .sort({ scheduledAt: -1, createdAt: -1 })
        .limit(120)
        .toArray();
      const teacherIds = [...new Set(quizzes.map((quiz) => quiz.teacherId).filter(Boolean))];
      const teachers = await userCollection.find({ uid: { $in: teacherIds } }).toArray();
      const teachersById = teachers.reduce((acc, teacher) => {
        acc[teacher.uid] = teacher;
        return acc;
      }, {});

      res.json({
        success: true,
        quizzes: quizzes.map((quiz) => ({
          ...quiz,
          id: quiz._id.toString(),
          teacher: teachersById[quiz.teacherId] || null,
        })),
      });
    } catch (err) {
      console.error("Error fetching admin public quizzes:", err);
      res.status(500).json({ success: false, error: "Failed to fetch public quizzes." });
    }
  });

  router.post("/api/admin/public-quizzes", async (req, res) => {
    try {
      const {
        title,
        category = "school",
        type = "bangla_medium",
        subject,
        teacherId,
      } = req.body;
      const cleanTitle = String(title || `${subject || "Public"} quiz`).trim().slice(0, 120);
      const cleanSubject = String(subject || "").trim();
      const cleanCategory = ["school", "college", "university"].includes(category)
        ? category
        : "school";
      const cleanType = ["english_medium", "bangla_medium"].includes(type)
        ? type
        : "bangla_medium";

      if (!cleanSubject || !teacherId)
        return res.status(400).json({ success: false, error: "subject and teacherId are required." });

      const teacher = await userCollection.findOne({
        uid: teacherId,
        role: "teacher",
        approved: true,
        category: cleanCategory,
        type: cleanType,
        subjects: cleanSubject,
      });
      if (!teacher)
        return res.status(404).json({ success: false, error: "Approved teacher not found for this subject." });

      const now = new Date();
      const doc = {
        title: cleanTitle,
        category: cleanCategory,
        type: cleanType,
        subject: cleanSubject,
        teacherId,
        status: "assigned",
        questions: [],
        attempts: [],
        createdAt: now,
        updatedAt: now,
        assignedByAdmin: true,
      };

      const result = await publicQuizzes.insertOne(doc);
      const quiz = await publicQuizzes.findOne({ _id: result.insertedId });
      res.status(201).json({ success: true, quiz: { ...quiz, id: quiz._id.toString(), teacher } });
    } catch (err) {
      console.error("Error creating public quiz assignment:", err);
      res.status(500).json({ success: false, error: "Failed to assign public quiz." });
    }
  });

  router.patch("/api/admin/public-quizzes/:quizId", async (req, res) => {
    try {
      const { title, category, type, subject, teacherId } = req.body;
      const quiz = await publicQuizzes.findOne({ _id: new ObjectId(req.params.quizId) });
      if (!quiz) return res.status(404).json({ success: false, error: "Quiz not found." });
      if (quiz.status === "completed")
        return res.status(409).json({ success: false, error: "Completed public quizzes cannot be reassigned." });

      const update = { updatedAt: new Date() };
      if (typeof title === "string" && title.trim()) update.title = title.trim().slice(0, 120);
      if (["school", "college", "university"].includes(category)) update.category = category;
      if (["english_medium", "bangla_medium"].includes(type)) update.type = type;
      if (typeof subject === "string" && subject.trim()) update.subject = subject.trim();
      if (teacherId) {
        const teacher = await userCollection.findOne({
          uid: teacherId,
          role: "teacher",
          approved: true,
          category: update.category || quiz.category,
          type: update.type || quiz.type,
          subjects: update.subject || quiz.subject,
        });
        if (!teacher)
          return res.status(404).json({ success: false, error: "Approved teacher not found for this subject." });
        update.teacherId = teacherId;
      }

      await publicQuizzes.updateOne({ _id: quiz._id }, { $set: update });
      const updatedQuiz = await publicQuizzes.findOne({ _id: quiz._id });
      res.json({ success: true, quiz: { ...updatedQuiz, id: updatedQuiz._id.toString() } });
    } catch (err) {
      console.error("Error updating public quiz assignment:", err);
      res.status(500).json({ success: false, error: "Failed to update public quiz." });
    }
  });

  router.delete("/api/admin/public-quizzes/:quizId", async (req, res) => {
    try {
      const quiz = await publicQuizzes.findOne({ _id: new ObjectId(req.params.quizId) });
      if (!quiz) return res.status(404).json({ success: false, error: "Quiz not found." });
      await supabaseStorage.deletePaths(supabaseStorage.collectQuizStoragePaths(quiz));
      await supabaseStorage.deleteFolders([`public-quizzes/${quiz._id.toString()}`]);
      await publicQuizzes.deleteOne({ _id: quiz._id });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting public quiz assignment:", err);
      res.status(500).json({ success: false, error: "Failed to delete public quiz." });
    }
  });

  const getAdminRoom = async (roomId) => {
    if (!ObjectId.isValid(roomId)) return null;
    return studyRooms.findOne({ _id: new ObjectId(roomId) });
  };

  const findStudentByEmail = async (email) =>
    userCollection.findOne({
      email: { $regex: `^${String(email || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      role: "student",
    });

  const addStudentsToRoom = async (room, students, adminManagedFree = false) => {
    const now = new Date();
    const currentMemberIds = room.memberIds || [];
    const nextMemberIds = [...new Set([...currentMemberIds, ...students.map((student) => student.uid)])];
    const memberStatuses = { ...(room.memberStatuses || {}) };
    students.forEach((student) => {
      if (!memberStatuses[student.uid]) {
        memberStatuses[student.uid] = {
          joinedAt: now,
          lastPaymentAt: adminManagedFree ? null : now,
          nextBillingAt: adminManagedFree ? null : new Date(now.getTime() + STUDY_ROOM_MONTH_MS),
          isActive: true,
          addedByAdmin: true,
          freeAccess: adminManagedFree,
        };
      }
    });

    const updatedChats = (room.chats || []).map((chat) => ({
      ...chat,
      participantIds:
        chat.type === "students"
          ? nextMemberIds
          : [...new Set([...(chat.participantIds || []), ...students.map((student) => student.uid)])],
    }));

    await studyRooms.updateOne(
      { _id: room._id },
      {
        $set: {
          memberIds: nextMemberIds,
          memberStatuses,
          chats: updatedChats,
          updatedAt: Date.now(),
        },
      }
    );

    const chatDB = databaseinmongo.collection("chatDB");
    await Promise.all(
      updatedChats.map((chat) =>
        chat.chatId
          ? chatDB.updateOne(
              { _id: new ObjectId(chat.chatId) },
              { $set: { participantIds: chat.participantIds } }
            )
          : Promise.resolve()
      )
    );
    await Promise.all(
      updatedChats.map((chat) =>
        ensureRoomChatSubscriptions({
          chat: { ...chat, roomId: room._id.toString() },
          participantIds: chat.participantIds,
          roomId: room._id.toString(),
        })
      )
    );
  };

  router.get("/api/admin/study-rooms", async (req, res) => {
    try {
      const { category, type, visibility, search } = req.query;
      const filter = {};
      if (category) filter.category = category;
      if (type) filter.type = type;
      if (visibility) filter.visibility = visibility;
      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: "i" } },
          { keyword: String(search).trim().toUpperCase() },
        ];
      }
      const rooms = await studyRooms.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(120).toArray();
      const hydrated = await Promise.all(rooms.map(hydrateStudyRoom));
      res.json({ success: true, rooms: hydrated });
    } catch (err) {
      console.error("Error fetching admin study rooms:", err);
      res.status(500).json({ success: false, error: "Failed to fetch study rooms." });
    }
  });

  router.post("/api/admin/study-rooms", async (req, res) => {
    try {
      const {
        name,
        visibility = "public",
        category = "school",
        type = "bangla_medium",
        maxStudents = STUDY_ROOM_MAX_STUDENTS,
        freeAccess = true,
        creditExpenseEnabled = false,
        quizExpenseEnabled = true,
        teacherControl = false,
        studentEmails = [],
      } = req.body;
      const cleanName = String(name || "").trim();
      if (!cleanName) return res.status(400).json({ success: false, error: "Room name is required." });

      const cleanVisibility = visibility === "private" ? "private" : "public";
      const cleanCategory = ["school", "college", "university"].includes(category) ? category : "school";
      const cleanType = ["english_medium", "bangla_medium"].includes(type) ? type : "bangla_medium";
      const students = studentEmails.length
        ? await userCollection
            .find({ email: { $in: studentEmails.map((email) => String(email).trim().toLowerCase()) }, role: "student" })
            .toArray()
        : [];
      const memberIds = [...new Set(students.map((student) => student.uid).filter(Boolean))];
      const keyword = await getUniqueRoomKeyword();
      const now = new Date();
      const studentChat = await createStudyRoomChat({
        name: `${cleanName} Students`,
        type: "students",
        participantIds: memberIds,
      });
      const memberStatuses = memberIds.reduce((acc, uid) => {
        acc[uid] = {
          joinedAt: now,
          lastPaymentAt: freeAccess ? null : now,
          nextBillingAt: freeAccess ? null : new Date(now.getTime() + STUDY_ROOM_MONTH_MS),
          isActive: true,
          addedByAdmin: true,
          freeAccess,
        };
        return acc;
      }, {});

      const roomDoc = {
        name: cleanName,
        visibility: cleanVisibility,
        category: cleanCategory,
        type: cleanType,
        keyword,
        createdBy: "admin",
        createdByAdmin: true,
        freeAccess: Boolean(freeAccess),
        creditExpenseEnabled: Boolean(creditExpenseEnabled),
        quizExpenseEnabled: quizExpenseEnabled !== false,
        teacherControl: Boolean(teacherControl),
        teacherClassEnabled: Boolean(teacherControl),
        memberIds,
        memberStatuses,
        maxStudents: Math.max(1, Number(maxStudents) || STUDY_ROOM_MAX_STUDENTS),
        studentChatId: studentChat.chatId,
        chats: [studentChat],
        teacherSessions: [],
        createdAt: now,
        updatedAt: Date.now(),
      };

      const result = await studyRooms.insertOne(roomDoc);
      await ensureRoomChatSubscriptions({
        chat: { ...studentChat, roomId: result.insertedId.toString() },
        participantIds: memberIds,
        roomId: result.insertedId.toString(),
      });
      const room = await studyRooms.findOne({ _id: result.insertedId });
      res.status(201).json({ success: true, room: await hydrateStudyRoom(room) });
    } catch (err) {
      console.error("Error creating admin study room:", err);
      res.status(500).json({ success: false, error: "Failed to create study room." });
    }
  });

  router.patch("/api/admin/study-rooms/:roomId", async (req, res) => {
    try {
      const room = await getAdminRoom(req.params.roomId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found." });
      const { name, visibility, category, type, maxStudents, freeAccess, creditExpenseEnabled, quizExpenseEnabled, teacherControl } = req.body;
      const update = { updatedAt: Date.now() };
      if (typeof name === "string" && name.trim()) update.name = name.trim();
      if (visibility === "public" || visibility === "private") update.visibility = visibility;
      if (["school", "college", "university"].includes(category)) update.category = category;
      if (["english_medium", "bangla_medium"].includes(type)) update.type = type;
      if (maxStudents !== undefined) update.maxStudents = Math.max(1, Number(maxStudents) || STUDY_ROOM_MAX_STUDENTS);
      if (freeAccess !== undefined) update.freeAccess = Boolean(freeAccess);
      if (creditExpenseEnabled !== undefined) update.creditExpenseEnabled = Boolean(creditExpenseEnabled);
      if (quizExpenseEnabled !== undefined) update.quizExpenseEnabled = Boolean(quizExpenseEnabled);
      if (teacherControl !== undefined) {
        update.teacherControl = Boolean(teacherControl);
        update.teacherClassEnabled = Boolean(teacherControl);
      }

      await studyRooms.updateOne({ _id: room._id }, { $set: update });
      if (teacherControl !== undefined && Array.isArray(room.teacherSessions) && room.teacherSessions.length) {
        await studyRooms.updateOne(
          { _id: room._id },
          { $set: { "teacherSessions.$[].canStartClass": Boolean(teacherControl) } }
        );
      }
      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error updating admin study room:", err);
      res.status(500).json({ success: false, error: "Failed to update study room." });
    }
  });

  router.delete("/api/admin/study-rooms/:roomId", async (req, res) => {
    try {
      const room = await getAdminRoom(req.params.roomId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found." });
      const roomId = room._id.toString();
      const chatIds = (room.chats || []).map((chat) => chat.chatId).filter(ObjectId.isValid);
      const objectIds = chatIds.map((chatId) => new ObjectId(chatId));
      const chatDocs = objectIds.length
        ? await databaseinmongo.collection("chatDB").find({ _id: { $in: objectIds } }).toArray()
        : [];
      const chatStoragePaths = chatDocs.flatMap((chat) =>
        supabaseStorage.collectMessageStoragePaths(chat.messages || [])
      );
      const storageResult = await supabaseStorage.deletePaths(chatStoragePaths);
      const folderStorageResult = await supabaseStorage.deleteFolders([
        `rooms/${roomId}`,
        ...chatIds.map((chatId) => `chats/${chatId}`),
      ]);

      await studyRooms.deleteOne({ _id: room._id });
      if (objectIds.length) await databaseinmongo.collection("chatDB").deleteMany({ _id: { $in: objectIds } });
      if (roomQuizzes) await roomQuizzes.deleteMany({ roomId });
      await databaseinmongo.collection("notifications").deleteMany({ scope: "room", scopeId: roomId });
      await databaseinmongo.collection("chatCollection").updateMany(
        {},
        { $pull: { chats: { roomId } } }
      );
      res.json({ success: true, storage: { files: storageResult, folders: folderStorageResult } });
    } catch (err) {
      console.error("Error deleting admin study room:", err);
      res.status(500).json({ success: false, error: "Failed to delete study room." });
    }
  });

  router.post("/api/admin/study-rooms/:roomId/students", async (req, res) => {
    try {
      const { email } = req.body;
      const room = await getAdminRoom(req.params.roomId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found." });
      const student = await findStudentByEmail(email);
      if (!student) return res.status(404).json({ success: false, error: "Student not found." });
      if ((room.memberIds || []).includes(student.uid))
        return res.status(409).json({ success: false, error: "Student already joined this room." });
      if ((room.memberIds || []).length >= (room.maxStudents || STUDY_ROOM_MAX_STUDENTS))
        return res.status(409).json({ success: false, error: "This room is full." });

      await addStudentsToRoom(room, [student], room.freeAccess !== false);
      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error adding student to admin room:", err);
      res.status(500).json({ success: false, error: "Failed to add student." });
    }
  });

  router.delete("/api/admin/study-rooms/:roomId/students/:studentId", async (req, res) => {
    try {
      const room = await getAdminRoom(req.params.roomId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found." });
      const { studentId } = req.params;
      const nextMemberIds = (room.memberIds || []).filter((uid) => uid !== studentId);
      const nextStatuses = { ...(room.memberStatuses || {}) };
      delete nextStatuses[studentId];
      const updatedChats = (room.chats || []).map((chat) => ({
        ...chat,
        participantIds: (chat.participantIds || []).filter((uid) => uid !== studentId),
      }));
      await studyRooms.updateOne(
        { _id: room._id },
        { $set: { memberIds: nextMemberIds, memberStatuses: nextStatuses, chats: updatedChats, updatedAt: Date.now() } }
      );
      await databaseinmongo.collection("chatCollection").updateOne(
        { _id: studentId },
        { $pull: { chats: { roomId: room._id.toString() } } }
      );
      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error removing student from admin room:", err);
      res.status(500).json({ success: false, error: "Failed to remove student." });
    }
  });

  router.post("/api/admin/study-rooms/:roomId/teachers", async (req, res) => {
    try {
      const { teacherId, subject } = req.body;
      const room = await getAdminRoom(req.params.roomId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found." });
      const teacher = await userCollection.findOne({ uid: teacherId, role: "teacher" });
      if (!teacher) return res.status(404).json({ success: false, error: "Teacher not found." });
      const selectedSubject = subject || teacher.subjects?.[0] || "General";
      const alreadyAdded = (room.teacherSessions || []).some(
        (session) =>
          session.teacherId === teacherId &&
          String(session.subject || "General").toLowerCase() === String(selectedSubject).toLowerCase()
      );
      if (alreadyAdded)
        return res.status(409).json({ success: false, error: "This teacher is already added for this subject." });
      const teacherChat = await createStudyRoomChat({
        name: `${teacher.displayName || "Teacher"} - ${selectedSubject}`,
        type: "teacher",
        participantIds: [...new Set([...(room.memberIds || []), teacherId])],
        teacherId,
        subject: selectedSubject,
      });
      const teacherSession = {
        ...teacherChat,
        addedBy: "admin",
        addedByAdmin: true,
        addedAt: new Date(),
        expiresAt: null,
        canStartClass: room.teacherControl === true,
      };
      await studyRooms.updateOne(
        { _id: room._id },
        { $push: { chats: teacherChat, teacherSessions: teacherSession }, $set: { updatedAt: Date.now() } }
      );
      await ensureRoomChatSubscriptions({
        chat: { ...teacherChat, roomId: room._id.toString() },
        participantIds: teacherChat.participantIds,
        roomId: room._id.toString(),
      });
      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.status(201).json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error adding teacher to admin room:", err);
      res.status(500).json({ success: false, error: "Failed to add teacher." });
    }
  });

  router.delete("/api/admin/study-rooms/:roomId/teachers/:chatId", async (req, res) => {
    try {
      const room = await getAdminRoom(req.params.roomId);
      if (!room) return res.status(404).json({ success: false, error: "Room not found." });
      const { chatId } = req.params;
      const chatObjectId = ObjectId.isValid(chatId) ? new ObjectId(chatId) : null;
      const chatDoc = chatObjectId ? await databaseinmongo.collection("chatDB").findOne({ _id: chatObjectId }) : null;
      await supabaseStorage.deletePaths(supabaseStorage.collectMessageStoragePaths(chatDoc?.messages || []));
      await supabaseStorage.deleteFolders([`chats/${chatId}`]);
      await studyRooms.updateOne(
        { _id: room._id },
        {
          $pull: { chats: { chatId }, teacherSessions: { chatId } },
          $set: { updatedAt: Date.now() },
        }
      );
      if (chatObjectId) await databaseinmongo.collection("chatDB").deleteOne({ _id: chatObjectId });
      await databaseinmongo.collection("chatCollection").updateMany(
        {},
        { $pull: { chats: { chatId } } }
      );
      const updatedRoom = await studyRooms.findOne({ _id: room._id });
      res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
    } catch (err) {
      console.error("Error removing teacher from admin room:", err);
      res.status(500).json({ success: false, error: "Failed to remove teacher." });
    }
  });

  router.get("/active-packages", async (req, res) => {
    try {
      const { search, category, type, active } = req.query;
      const filter = {};
      if (category) filter.category = category;
      if (type) filter.type = type;
      if (active === "true") filter.isActive = true;
      else if (active === "false") filter.isActive = { $ne: true };

      let pkgList = await activepackages
        .find(filter)
        .sort({ purchasedAt: -1 })
        .limit(200)
        .toArray();

      if (search) {
        const s = search.toLowerCase();
        pkgList = pkgList.filter(
          (p) =>
            (p.uid || "").toLowerCase().includes(s) ||
            (p.packageName || "").toLowerCase().includes(s)
        );
      }

      const uids = [...new Set(pkgList.map((p) => p.uid).filter(Boolean))];
      const users = await userCollection
        .find({ uid: { $in: uids } }, { projection: { uid: 1, email: 1, displayName: 1 } })
        .toArray();
      const userMap = {};
      users.forEach((u) => { userMap[u.uid] = u; });

      const data = pkgList.map((p) => ({
        ...p,
        email: userMap[p.uid]?.email || "",
        userName: userMap[p.uid]?.displayName || "",
      }));

      res.status(200).json({ success: true, data });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false, data: [] });
    }
  });

  router.patch("/active-packages/:uid", async (req, res) => {
    try {
      const { uid } = req.params;
      const { packageName, category, type, credit, totalCredit, startDate, expiryDate, isActive, isUnlimited } = req.body;
      const update = { updatedAt: new Date() };
      if (packageName !== undefined) update.packageName = packageName;
      if (category !== undefined) update.category = category;
      if (type !== undefined) update.type = type;
      if (credit !== undefined) update.credit = Number(credit);
      if (totalCredit !== undefined) update.totalCredit = Number(totalCredit);
      if (startDate !== undefined) update.startDate = startDate;
      if (expiryDate !== undefined) update.expiryDate = expiryDate;
      if (isActive !== undefined) update.isActive = Boolean(isActive);
      if (isUnlimited !== undefined) update.isUnlimited = Boolean(isUnlimited);
      await activepackages.updateOne({ uid }, { $set: update });
      res.status(200).json({ success: true });
    } catch (err) {
      console.log(err);
      res.status(500).json({ success: false });
    }
  });

  return router;
};
