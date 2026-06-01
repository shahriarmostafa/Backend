const { ObjectId } = require("mongodb");
const {
  COURSE_MARKETPLACE_COMMISSION_RATE,
  COURSE_TEACHER_POOL_RATE,
  COURSE_PERFORMANCE_WEIGHTS,
} = require("./constants");

const COURSE_CATEGORIES = ["school", "college", "university", "everyone"];
const COURSE_TYPES = ["bangla_medium", "english_medium", "everyone"];
const PAYMENT_PLANS = ["session", "monthly", "full"];

const asId = (value) => (value && value.toString ? value.toString() : String(value || ""));

const normalizeCategory = (value) => (COURSE_CATEGORIES.includes(value) ? value : "school");
const normalizeType = (value) => (COURSE_TYPES.includes(value) ? value : "bangla_medium");
const normalizePaymentPlan = (value) => (PAYMENT_PLANS.includes(value) ? value : "monthly");

const parseDate = (value, fallback = null) => {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const makeSlug = (title = "course") =>
  String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "course";

const makeCourseHelpers = ({ userCollection, activepackages, databaseinmongo, courses }) => {
  const courseCollection = courses || databaseinmongo.collection("courses");
  const coursePayments = databaseinmongo.collection("coursePayments");
  const creditPrices = databaseinmongo.collection("creditPrices");
  const packages = databaseinmongo.collection("packages");

  const getTeacherSnapshot = async (teacherId) => {
    const teacher = await userCollection.findOne(
      { uid: teacherId, role: "teacher" },
      { projection: { uid: 1, displayName: 1, name: 1, email: 1, photoURL: 1, category: 1, type: 1, subjects: 1, experience: 1 } }
    );
    if (!teacher) return null;
    return {
      uid: teacher.uid,
      displayName: teacher.displayName || teacher.name || teacher.email || "Teacher",
      email: teacher.email || "",
      photoURL: teacher.photoURL || "",
      category: teacher.category || "",
      type: teacher.type || "",
      subjects: teacher.subjects || [],
      experience: teacher.experience || 1,
    };
  };

  const getStudentSnapshot = async (studentId) => {
    const student = await userCollection.findOne(
      { uid: studentId },
      { projection: { uid: 1, displayName: 1, name: 1, email: 1, photoURL: 1, category: 1, type: 1, role: 1 } }
    );
    if (!student) return null;
    return {
      uid: student.uid,
      displayName: student.displayName || student.name || student.email || "Student",
      email: student.email || "",
      photoURL: student.photoURL || "",
      category: student.category || "school",
      type: student.type || "bangla_medium",
      role: student.role || "",
    };
  };

  const getPricePerCredit = async (category, type) => {
    const priceDoc = await creditPrices.findOne({ category, type });
    if (Number(priceDoc?.pricePerCredit) > 0) return Number(priceDoc.pricePerCredit);

    const packageAgg = await packages
      .aggregate([
        { $match: { category, type, price: { $gt: 0 }, credit: { $gt: 0 } } },
        { $project: { ratio: { $divide: ["$price", "$credit"] } } },
        { $group: { _id: null, pricePerCredit: { $avg: "$ratio" } } },
      ])
      .toArray();
    return Number(packageAgg[0]?.pricePerCredit) || 1;
  };

  const buildScheduleSessions = ({ startsAt, months = 1, days = [], time = "", totalClasses = 0 }) => {
    const start = parseDate(startsAt, new Date());
    const count = Math.max(1, Number(totalClasses) || Math.max(4, Number(months) * Math.max(days.length || 1, 4)));
    return Array.from({ length: count }, (_, index) => ({
      id: new ObjectId().toString(),
      title: `Class ${index + 1}`,
      scheduledAt: new Date(start.getTime() + index * 7 * 24 * 60 * 60 * 1000),
      time,
      status: "scheduled",
      teacherAttendance: false,
      studentAttendance: {},
      ratings: [],
    }));
  };

  const hydrateCourse = async (course, viewerId = "") => {
    if (!course) return null;
    const teacher = course.teacher || (course.teacherId ? await getTeacherSnapshot(course.teacherId) : null);
    const enrollments = Array.isArray(course.enrollments) ? course.enrollments : [];
    const activeEnrollments = enrollments.filter((item) => item.status !== "cancelled");
    const myEnrollment = viewerId ? enrollments.find((item) => item.studentId === viewerId) : null;
    const ratings = (course.sessions || []).flatMap((session) => session.ratings || []);
    const averageRating = ratings.length
      ? Math.round((ratings.reduce((sum, item) => sum + (Number(item.rating) || 0), 0) / ratings.length) * 10) / 10
      : Number(course.averageRating) || 0;

    return {
      ...course,
      id: asId(course._id),
      slug: course.slug || makeSlug(course.title),
      teacher,
      studentCount: activeEnrollments.length,
      seatsTaken: activeEnrollments.length,
      myEnrollment: myEnrollment || null,
      averageRating,
      ratingCount: ratings.length || Number(course.ratingCount) || 0,
      pricing: {
        session: Number(course.pricing?.session) || 0,
        monthly: Number(course.pricing?.monthly) || 0,
        full: Number(course.pricing?.full) || 0,
      },
      marketplace: {
        commissionRate: COURSE_MARKETPLACE_COMMISSION_RATE,
        teacherPoolRate: COURSE_TEACHER_POOL_RATE,
        performanceWeights: COURSE_PERFORMANCE_WEIGHTS,
      },
    };
  };

  const spendCourseCredit = async ({ studentId, creditCost, session = null }) => {
    const cost = Math.ceil(Number(creditCost) || 0);
    if (cost <= 0) return { ok: true, remainingCredit: null };
    const result = await activepackages.findOneAndUpdate(
      { uid: studentId, isActive: true, credit: { $gte: cost } },
      { $inc: { credit: -cost } },
      { returnDocument: "after", session }
    );
    const doc = result && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
    if (!doc) return { ok: false, status: 402, message: `At least ${cost} credit is required.` };
    return { ok: true, remainingCredit: Number(doc.credit) || 0 };
  };

  const calculateCoursePerformance = (course = {}) => {
    const sessions = course.sessions || [];
    const totalDeclared = Math.max(Number(course.totalClasses) || sessions.length || 1, 1);
    const takenSessions = sessions.filter((session) => session.teacherAttendance || session.status === "completed").length;
    const ratings = sessions.flatMap((session) => session.ratings || []);
    const averageRating = ratings.length
      ? ratings.reduce((sum, item) => sum + (Number(item.rating) || 0), 0) / ratings.length
      : 0;
    const resourceCount = Number(course.resourceCount) || Number(course.resourcesShared) || 0;
    const quizCount = Number(course.quizCount) || 0;
    const monthCount = Math.max(Number(course.durationMonths) || 1, 1);
    const expectedMonthlyClasses = totalDeclared / monthCount;
    const classesScore = Math.min(takenSessions / Math.max(expectedMonthlyClasses, 1), 1);
    const ratingScore = averageRating ? Math.min(averageRating / 5, 1) : 0;
    const completionScore = course.completedAt && course.endsAt
      ? (new Date(course.completedAt).getTime() <= new Date(course.endsAt).getTime() + 7 * 24 * 60 * 60 * 1000 ? 1 : 0)
      : 0;
    const quizScore = Math.min(quizCount / monthCount, 1);
    const resourceScore = Math.min(resourceCount / 3, 1);
    const weightedScore =
      classesScore * COURSE_PERFORMANCE_WEIGHTS.classesTaken +
      ratingScore * COURSE_PERFORMANCE_WEIGHTS.ratings +
      completionScore * COURSE_PERFORMANCE_WEIGHTS.completionOnTime +
      quizScore * COURSE_PERFORMANCE_WEIGHTS.monthlyQuiz +
      resourceScore * COURSE_PERFORMANCE_WEIGHTS.resourcesShared;

    return {
      takenSessions,
      totalDeclared,
      averageRating: Math.round(averageRating * 10) / 10,
      resourceCount,
      quizCount,
      classesScore,
      ratingScore,
      completionScore,
      quizScore,
      resourceScore,
      weightedScore: Math.min(Math.max(weightedScore, 0), 1),
    };
  };

  const calculateCourseEarnings = async (course = {}) => {
    const collectedCredit = Number(course.totalCollectedCredit) || 0;
    const durationMonths = Math.max(Number(course.durationMonths) || 1, 1);
    const monthlyCredit = collectedCredit / durationMonths;
    const pricePerCredit = await getPricePerCredit(course.category || "school", course.type || "bangla_medium");
    const monthlyMoney = monthlyCredit * pricePerCredit;
    const commission = monthlyMoney * COURSE_MARKETPLACE_COMMISSION_RATE;
    const teacherPool = monthlyMoney * COURSE_TEACHER_POOL_RATE;
    const performance = calculateCoursePerformance(course);
    const teacherPayable = Math.round(teacherPool * performance.weightedScore * 100) / 100;
    const enrolledCount = Math.max((course.enrollments || []).filter((item) => item.status !== "cancelled").length, 1);
    const totalPointsToAdd = Math.round(teacherPayable / enrolledCount);

    return {
      collectedCredit,
      durationMonths,
      monthlyCredit,
      pricePerCredit,
      monthlyMoney: Math.round(monthlyMoney * 100) / 100,
      commission: Math.round(commission * 100) / 100,
      teacherPool: Math.round(teacherPool * 100) / 100,
      teacherPayable,
      totalPointsToAdd,
      performance,
    };
  };

  return {
    courseCollection,
    coursePayments,
    getTeacherSnapshot,
    getStudentSnapshot,
    hydrateCourse,
    spendCourseCredit,
    calculateCourseEarnings,
    buildScheduleSessions,
    makeSlug,
    normalizeCategory,
    normalizeType,
    normalizePaymentPlan,
  };
};

module.exports = { makeCourseHelpers, COURSE_CATEGORIES, COURSE_TYPES, PAYMENT_PLANS };
