const { ObjectId } = require("mongodb");
const {
  COURSE_MARKETPLACE_COMMISSION_RATE,
  COURSE_TEACHER_POOL_RATE,
  COURSE_PERFORMANCE_WEIGHTS,
  PLATFORM_UTC_OFFSET_MINUTES,
} = require("./constants");

const COURSE_CATEGORIES = ["school", "college", "university", "everyone"];
const COURSE_TYPES = ["bangla_medium", "english_medium", "everyone"];
const PAYMENT_PLANS = ["session", "monthly", "full"];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_SESSIONS = 500;
const MAX_SCHEDULE_SPAN_DAYS = 5 * 366;
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Whether a student's enrollment covers one class session of a course:
 *   full    -> every session
 *   monthly -> any session while validUntil has not passed
 *   session -> only the session that was bought
 * Cancelled enrollments and sessions the course does not have never count.
 * A student may hold several enrollments (one bought class, then another; a
 * lapsed month, then a new one) - any one covering the session is enough.
 *
 * Used by the course routes and by /start-call in routes/calls.js.
 */
const hasCourseSessionAccess = (course, studentId, sessionId, now = new Date()) => {
  if (!course || !studentId || sessionId == null || sessionId === "") return false;
  const targetSessionId = String(sessionId);
  if (!(course.sessions || []).some((session) => String(session?.id) === targetSessionId)) return false;
  const nowMs = new Date(now).getTime();
  return (course.enrollments || []).some((enrollment) => {
    if (!enrollment || enrollment.studentId !== studentId || enrollment.status === "cancelled") return false;
    if (enrollment.paymentPlan === "full") return true;
    if (enrollment.paymentPlan === "monthly") {
      const validUntil = enrollment.validUntil ? new Date(enrollment.validUntil).getTime() : NaN;
      return Number.isFinite(validUntil) && validUntil >= nowMs;
    }
    if (enrollment.paymentPlan === "session") return String(enrollment.sessionId || "") === targetSessionId;
    return false;
  });
};

/** A student's standing in a course, for the course page and the enroll route. */
const getCourseAccessSummary = (course, studentId, now = new Date()) => {
  const nowMs = new Date(now).getTime();
  const mine = (course?.enrollments || []).filter(
    (enrollment) => enrollment?.studentId === studentId && enrollment.status !== "cancelled"
  );
  const full = mine.some((enrollment) => enrollment.paymentPlan === "full");
  const monthlyValidUntil = mine
    .filter((enrollment) => enrollment.paymentPlan === "monthly" && enrollment.validUntil)
    .map((enrollment) => new Date(enrollment.validUntil).getTime())
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), 0);
  const sessionIds = [
    ...new Set(
      mine
        .filter((enrollment) => enrollment.paymentPlan === "session" && enrollment.sessionId)
        .map((enrollment) => String(enrollment.sessionId))
    ),
  ];
  const monthlyActive = monthlyValidUntil >= nowMs;
  return {
    enrolled: mine.length > 0,
    full,
    monthlyActive,
    monthlyValidUntil: monthlyValidUntil ? new Date(monthlyValidUntil) : null,
    sessionIds,
    // every current and future class is covered
    coversAll: full || monthlyActive,
  };
};

/** Minutes east of UTC; the platform zone unless the client sent a sane one. */
const normalizeUtcOffset = (value) => {
  const offset = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(offset)) {
    return PLATFORM_UTC_OFFSET_MINUTES;
  }
  return offset >= -12 * 60 && offset <= 14 * 60 ? Math.round(offset) : PLATFORM_UTC_OFFSET_MINUTES;
};

/** "Mon, Wed" / ["Monday", "wed"] -> sorted weekday numbers (0 = Sunday). */
const parseScheduleDays = (days = []) => {
  const list = Array.isArray(days) ? days : String(days || "").split(",");
  return [
    ...new Set(
      list
        .map((day) => WEEKDAY_INDEX[String(day || "").trim().toLowerCase().slice(0, 3)])
        .filter((day) => day !== undefined)
    ),
  ].sort((a, b) => a - b);
};

/** "8:00 PM", "8 pm", "20:00", "20.30" -> minutes after midnight, or null. */
const parseScheduleTime = (value) => {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  if (minutes > 59) return null;
  if (match[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (match[3].startsWith("p") ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
};

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

  /**
   * The class routine: one session per chosen weekday at `time`, read as wall
   * clock in `utcOffsetMinutes` (the platform zone, Asia/Dhaka, unless the
   * client sent its own). It used to ignore days and time entirely and emit one
   * session a week at UTC midnight - 6 AM in Bangladesh.
   *
   * A date-only `startsAt` ("2026-11-02") is that calendar day in the zone; a
   * full timestamp is converted into it. Unparseable days fall back to the
   * start date's weekday (weekly), an unparseable time to midnight - the
   * teacher can reschedule single sessions.
   */
  const buildScheduleSessions = ({
    startsAt,
    months = 1,
    days = [],
    time = "",
    totalClasses = 0,
    utcOffsetMinutes = PLATFORM_UTC_OFFSET_MINUTES,
  }) => {
    const offsetMs = normalizeUtcOffset(utcOffsetMinutes) * 60 * 1000;
    const dateOnly = typeof startsAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startsAt.trim());
    const start = parseDate(startsAt, new Date());
    let firstDayStart;
    if (dateOnly) {
      const [year, month, day] = startsAt.trim().split("-").map(Number);
      firstDayStart = Date.UTC(year, month - 1, day) - offsetMs;
    } else {
      const local = new Date(start.getTime() + offsetMs);
      firstDayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs;
    }
    const notBefore = dateOnly ? firstDayStart : start.getTime();
    const weekdays = parseScheduleDays(days);
    const activeDays = weekdays.length ? weekdays : [new Date(firstDayStart + offsetMs).getUTCDay()];
    const minutesOfDay = parseScheduleTime(time) ?? 0;
    const dayCount = Array.isArray(days) ? days.length : 0;
    const count = Math.min(
      MAX_SCHEDULE_SESSIONS,
      Math.max(1, Number(totalClasses) || Math.max(4, Number(months) * Math.max(dayCount || 1, 4)))
    );

    const sessions = [];
    for (let dayIndex = 0; sessions.length < count && dayIndex < MAX_SCHEDULE_SPAN_DAYS; dayIndex += 1) {
      const dayStart = firstDayStart + dayIndex * DAY_MS;
      if (!activeDays.includes(new Date(dayStart + offsetMs).getUTCDay())) continue;
      const scheduledAt = new Date(dayStart + minutesOfDay * 60 * 1000);
      if (scheduledAt.getTime() < notBefore) continue;
      sessions.push({
        id: new ObjectId().toString(),
        title: `Class ${sessions.length + 1}`,
        scheduledAt,
        time,
        status: "scheduled",
        teacherAttendance: false,
        studentAttendance: {},
        ratings: [],
      });
    }
    return sessions;
  };

  /**
   * The client-facing course. `viewerId` must be the verified caller.
   *
   * The roster (`enrollments`, each with the student's email) and the payout
   * records go only to the course teacher, or to admin screens that pass
   * `includeEnrollments`. A student gets their own enrollment, a summary of
   * what it covers, and per-session `myAccess` flags; per-session attendance
   * and ratings are cut down to their own entries.
   */
  const hydrateCourse = async (course, viewerId = "", options = {}) => {
    if (!course) return null;
    const now = new Date();
    const isCourseTeacher = Boolean(viewerId && viewerId === course.teacherId);
    const showRoster = isCourseTeacher || Boolean(options && options.includeEnrollments);
    const storedTeacher = course.teacher || (course.teacherId ? await getTeacherSnapshot(course.teacherId) : null);
    const { email: teacherEmail, ...publicTeacher } = storedTeacher || {};
    const teacher = storedTeacher ? (showRoster ? { ...publicTeacher, email: teacherEmail } : publicTeacher) : null;
    const enrollments = Array.isArray(course.enrollments) ? course.enrollments : [];
    const activeEnrollments = enrollments.filter((item) => item.status !== "cancelled");
    const studentCount = new Set(activeEnrollments.map((item) => item.studentId)).size;
    const isStudentViewer = Boolean(viewerId && !isCourseTeacher);
    const myEnrollments = isStudentViewer ? activeEnrollments.filter((item) => item.studentId === viewerId) : [];
    // newest first, the shape the page has always read
    const myEnrollment = myEnrollments.length
      ? [...myEnrollments].sort((a, b) => new Date(b.enrolledAt || 0) - new Date(a.enrolledAt || 0))[0]
      : null;
    const myAccess = isStudentViewer ? getCourseAccessSummary(course, viewerId, now) : null;
    const ratings = (course.sessions || []).flatMap((session) => session.ratings || []);
    const averageRating = ratings.length
      ? Math.round((ratings.reduce((sum, item) => sum + (Number(item.rating) || 0), 0) / ratings.length) * 10) / 10
      : Number(course.averageRating) || 0;
    const sessions = (course.sessions || []).map((session) => {
      if (showRoster) return session;
      const ownAttendance = viewerId && session.studentAttendance?.[viewerId];
      return {
        ...session,
        studentAttendance: ownAttendance ? { [viewerId]: ownAttendance } : {},
        ratings: (session.ratings || []).filter((item) => item.studentId === viewerId),
        myAccess: isStudentViewer ? hasCourseSessionAccess(course, viewerId, session.id, now) : false,
      };
    });
    const {
      enrollments: _enrollments,
      teacherPayments: _teacherPayments,
      ...courseFields
    } = course;

    return {
      ...courseFields,
      ...(showRoster ? { enrollments, teacherPayments: course.teacherPayments } : {}),
      sessions,
      id: asId(course._id),
      slug: course.slug || makeSlug(course.title),
      teacher,
      studentCount,
      seatsTaken: studentCount,
      myEnrollment,
      myEnrollments,
      myAccess,
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
    hasCourseSessionAccess,
    getCourseAccessSummary,
    makeSlug,
    normalizeCategory,
    normalizeType,
    normalizePaymentPlan,
  };
};

module.exports = {
  makeCourseHelpers,
  hasCourseSessionAccess,
  getCourseAccessSummary,
  parseScheduleDays,
  parseScheduleTime,
  normalizeUtcOffset,
  COURSE_CATEGORIES,
  COURSE_TYPES,
  PAYMENT_PLANS,
};
