const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeCourseHelpers } = require("../utils/courseHelpers");
const { makeTeacherQualityHelpers } = require("../utils/teacherQualityHelpers");
const { resolveActor } = require("../utils/actor");
const { COURSE_MONTH_MS } = require("../utils/constants");

// A single class can be bought until its join window closes (the course page
// offers "Join class" up to 2 hours after the start).
const SESSION_PURCHASE_CUTOFF_MS = 2 * 60 * 60 * 1000;

module.exports = ({ userCollection, activepackages, databaseinmongo, courses, client }) => {
  const router = Router();
  const helpers = makeCourseHelpers({ userCollection, activepackages, databaseinmongo, courses });
  const { recordRatingEvent, applyTeacherQualitySnapshot } = makeTeacherQualityHelpers({
    databaseinmongo,
    userCollection,
  });
  const courseCollection = helpers.courseCollection;
  const coursePayments = helpers.coursePayments;

  const getCourse = (courseId, session = null) =>
    ObjectId.isValid(courseId)
      ? courseCollection.findOne({ _id: new ObjectId(courseId) }, { session })
      : null;

  const canAccessCourse = (course, userDoc) => {
    if (!course || !userDoc) return false;
    if (userDoc.role === "teacher" && course.teacherId === userDoc.uid) return true;
    if (userDoc.role === "student" && (course.enrollments || []).some((item) => item.studentId === userDoc.uid)) return true;
    return course.status === "published";
  };

  router.get("/api/courses", async (req, res) => {
    try {
      const { teacherId, mine, status } = req.query;
      // decides whose enrollment comes back, so it is the token's uid
      const userId = req.query.userId ? await resolveActor(req, res, req.query.userId) : "";
      if (req.query.userId && !userId) return;
      const viewer = userId ? await userCollection.findOne({ uid: userId }) : null;
      const filter = {};

      if (teacherId) filter.teacherId = teacherId;
      if (mine === "true" && viewer?.role === "teacher") filter.teacherId = viewer.uid;
      else if (mine === "true" && viewer?.role === "student") filter["enrollments.studentId"] = viewer.uid;
      else if (status) filter.status = status;
      else filter.status = "published";

      if (!teacherId && mine !== "true" && viewer?.role === "student") {
        filter.$or = [
          { category: viewer.category || "school", type: viewer.type || "bangla_medium" },
          { category: "everyone" },
          { type: "everyone" },
        ];
      }

      const list = await courseCollection
        .find(filter)
        .sort({ featured: -1, startsAt: 1, updatedAt: -1 })
        .limit(80)
        .toArray();
      const courses = await Promise.all(list.map((course) => helpers.hydrateCourse(course, userId)));
      res.json({ success: true, courses });
    } catch (err) {
      console.error("Error fetching courses:", err);
      res.status(500).json({ error: "Failed to fetch courses." });
    }
  });

  router.get("/api/courses/:courseId", async (req, res) => {
    try {
      const userId = await resolveActor(req, res, req.query.userId);
      if (!userId) return;
      const course = await getCourse(req.params.courseId);
      if (!course) return res.status(404).json({ error: "Course not found." });
      const viewer = await userCollection.findOne({ uid: userId });
      const isOwner = !canAccessCourse(course, viewer) && Boolean(await req.isOwner?.());
      if (!canAccessCourse(course, viewer) && !isOwner)
        return res.status(403).json({ error: "This course is not available for you." });
      res.json({
        success: true,
        course: await helpers.hydrateCourse(course, userId, { includeEnrollments: isOwner }),
      });
    } catch (err) {
      console.error("Error fetching course:", err);
      res.status(500).json({ error: "Failed to fetch course." });
    }
  });

  router.post("/api/courses", async (req, res) => {
    try {
      const {
        title,
        subject = "",
        category = "school",
        type = "bangla_medium",
        audience = "scoped",
        about = "",
        coverUrl = "",
        bannerUrl = "",
        durationMonths = 1,
        startsAt,
        scheduleDays = [],
        scheduleTime = "",
        totalClasses = 0,
        capacity = 30,
        resourcesIncluded = "",
        certificateEnabled = false,
        quizEnabled = true,
        quizExpenseEnabled = true,
        // the creating device's offset from UTC in minutes (east positive); the
        // schedule time is wall clock there. Platform zone when absent.
        utcOffsetMinutes,
      } = req.body;
      const teacherId = await resolveActor(req, res, req.body?.teacherId);
      if (!teacherId) return;
      const teacher = await userCollection.findOne({ uid: teacherId, role: "teacher" });
      if (!teacher) return res.status(403).json({ error: "Only teachers can create courses." });
      const cleanTitle = String(title || "").trim();
      if (!cleanTitle) return res.status(400).json({ error: "Course title is required." });

      const cleanCategory = audience === "everyone" ? "everyone" : helpers.normalizeCategory(category);
      const cleanType = audience === "everyone" ? "everyone" : helpers.normalizeType(type);
      const now = new Date();
      const months = Math.max(1, Number(durationMonths) || 1);
      const parsedStart = startsAt ? new Date(startsAt) : now;
      const start = Number.isNaN(parsedStart.getTime()) ? now : parsedStart;
      const sessions = helpers.buildScheduleSessions({
        // passed through raw so a date-only value stays a calendar day
        startsAt: startsAt && !Number.isNaN(parsedStart.getTime()) ? startsAt : start,
        months,
        days: Array.isArray(scheduleDays) ? scheduleDays : [],
        time: scheduleTime,
        totalClasses,
        utcOffsetMinutes,
      });

      const doc = {
        title: cleanTitle.slice(0, 140),
        slug: helpers.makeSlug(cleanTitle),
        subject: String(subject || "").trim(),
        category: cleanCategory,
        type: cleanType,
        audience: audience === "everyone" ? "everyone" : "scoped",
        about: String(about || "").trim().slice(0, 1500),
        coverUrl: String(coverUrl || "").trim(),
        bannerUrl: String(bannerUrl || coverUrl || teacher.photoURL || "").trim(),
        teacherId,
        teacher: await helpers.getTeacherSnapshot(teacherId),
        durationMonths: months,
        startsAt: start,
        endsAt: new Date(start.getTime() + months * 30 * 24 * 60 * 60 * 1000),
        scheduleDays: Array.isArray(scheduleDays) ? scheduleDays : [],
        scheduleTime: String(scheduleTime || "").trim(),
        totalClasses: Math.max(Number(totalClasses) || sessions.length, sessions.length),
        sessions,
        capacity: Math.max(1, Number(capacity) || 30),
        resourcesIncluded: String(resourcesIncluded || "").trim(),
        certificateEnabled: Boolean(certificateEnabled),
        quizEnabled: quizEnabled !== false,
        quizExpenseEnabled: quizExpenseEnabled !== false,
        teacherControl: true,
        creditExpenseEnabled: false,
        pricing: { session: 0, monthly: 0, full: 0 },
        status: "pending",
        enrollments: [],
        totalCollectedCredit: 0,
        createdAt: now,
        updatedAt: now,
        approvedAt: null,
      };

      const result = await courseCollection.insertOne(doc);
      const course = await courseCollection.findOne({ _id: result.insertedId });
      res.status(201).json({ success: true, course: await helpers.hydrateCourse(course, teacherId) });
    } catch (err) {
      console.error("Error creating course:", err);
      res.status(500).json({ error: "Failed to create course." });
    }
  });

  router.patch("/api/courses/:courseId", async (req, res) => {
    try {
      const teacherId = await resolveActor(req, res, req.body?.teacherId);
      if (!teacherId) return;
      const course = await getCourse(req.params.courseId);
      if (!course) return res.status(404).json({ error: "Course not found." });
      if (course.teacherId !== teacherId) return res.status(403).json({ error: "Only the course teacher can edit it." });
      if (["published", "completed"].includes(course.status))
        return res.status(409).json({ error: "Published courses must be edited by admin." });

      const allowed = [
        "title",
        "subject",
        "about",
        "coverUrl",
        "bannerUrl",
        "resourcesIncluded",
        "scheduleTime",
        "certificateEnabled",
        "quizEnabled",
        "quizExpenseEnabled",
      ];
      const update = { updatedAt: new Date() };
      allowed.forEach((key) => {
        if (req.body[key] !== undefined) update[key] = req.body[key];
      });
      if (req.body.durationMonths !== undefined) update.durationMonths = Math.max(1, Number(req.body.durationMonths) || 1);
      if (req.body.capacity !== undefined) update.capacity = Math.max(1, Number(req.body.capacity) || 30);
      if (Array.isArray(req.body.scheduleDays)) update.scheduleDays = req.body.scheduleDays;
      if (req.body.category || req.body.type || req.body.audience) {
        update.audience = req.body.audience === "everyone" ? "everyone" : "scoped";
        update.category = update.audience === "everyone" ? "everyone" : helpers.normalizeCategory(req.body.category || course.category);
        update.type = update.audience === "everyone" ? "everyone" : helpers.normalizeType(req.body.type || course.type);
      }

      await courseCollection.updateOne({ _id: course._id }, { $set: update });
      const updated = await courseCollection.findOne({ _id: course._id });
      res.json({ success: true, course: await helpers.hydrateCourse(updated, teacherId) });
    } catch (err) {
      console.error("Error updating course:", err);
      res.status(500).json({ error: "Failed to update course." });
    }
  });

  /**
   * Buying a plan. A student can hold several enrollments - a second single
   * class, or a new month after the last one lapsed - so "already enrolled" now
   * means "already covered for what you are buying". It used to mean "has any
   * enrollment", which left a student who bought one class unable to buy
   * another, and a lapsed monthly student unable to renew.
   *
   * Runs in a transaction: two concurrent purchases both write the course doc,
   * so one is retried, sees the other's enrollment, and is not charged.
   */
  router.post("/api/courses/:courseId/enroll", async (req, res) => {
    const userId = await resolveActor(req, res, req.body?.userId);
    if (!userId) return;
    const session = client.startSession();
    try {
      const { paymentPlan = "monthly", sessionId = "" } = req.body;
      let responsePayload = null;
      await session.withTransaction(async () => {
        const course = await getCourse(req.params.courseId, session);
        if (!course) {
          responsePayload = { status: 404, body: { error: "Course not found." } };
          return;
        }
        if (course.status !== "published") {
          responsePayload = { status: 409, body: { error: "This course is not open for enrollment." } };
          return;
        }
        const student = await helpers.getStudentSnapshot(userId);
        if (!student || student.role !== "student") {
          responsePayload = { status: 403, body: { error: "Only students can buy courses." } };
          return;
        }
        const now = new Date();
        const plan = helpers.normalizePaymentPlan(paymentPlan);
        const access = helpers.getCourseAccessSummary(course, userId, now);
        const targetSessionId = plan === "session" ? String(sessionId || "").trim() : "";
        if (plan === "session") {
          const targetSession = (course.sessions || []).find((item) => String(item.id) === targetSessionId);
          if (!targetSession) {
            responsePayload = { status: 400, body: { error: "Choose the class you want to buy." } };
            return;
          }
          const startsAt = targetSession.scheduledAt ? new Date(targetSession.scheduledAt).getTime() : 0;
          if (startsAt && startsAt + SESSION_PURCHASE_CUTOFF_MS < now.getTime()) {
            responsePayload = { status: 409, body: { error: "This class has already finished." } };
            return;
          }
        }
        const alreadyCovered =
          plan === "full"
            ? access.full
            : plan === "monthly"
              ? access.coversAll
              : helpers.hasCourseSessionAccess(course, userId, targetSessionId, now);
        if (alreadyCovered) {
          responsePayload = { status: 200, body: { success: true, course: await helpers.hydrateCourse(course, userId), alreadyEnrolled: true } };
          return;
        }
        // seats are students, not purchases: a returning student keeps theirs
        const seatedStudents = new Set(
          (course.enrollments || []).filter((item) => item.status !== "cancelled").map((item) => item.studentId)
        );
        if (!access.enrolled && seatedStudents.size >= (course.capacity || 30)) {
          responsePayload = { status: 409, body: { error: "This course is full." } };
          return;
        }
        const creditCost = Math.ceil(Number(course.pricing?.[plan]) || 0);
        if (creditCost <= 0) {
          responsePayload = { status: 409, body: { error: "This payment option is not available yet." } };
          return;
        }
        const creditResult = await helpers.spendCourseCredit({ studentId: userId, creditCost, session });
        if (!creditResult.ok) {
          responsePayload = { status: creditResult.status, body: { error: creditResult.message } };
          return;
        }

        const enrollment = {
          studentId: userId,
          student,
          paymentPlan: plan,
          sessionId: targetSessionId,
          creditPaid: creditCost,
          status: "active",
          enrolledAt: now,
          validUntil: plan === "monthly" ? new Date(now.getTime() + COURSE_MONTH_MS) : null,
        };
        const payment = {
          courseId: course._id.toString(),
          teacherId: course.teacherId,
          studentId: userId,
          paymentPlan: plan,
          sessionId: enrollment.sessionId,
          creditPaid: creditCost,
          status: "collected",
          createdAt: now,
        };
        await coursePayments.insertOne(payment, { session });
        await courseCollection.updateOne(
          { _id: course._id },
          {
            $push: { enrollments: enrollment },
            $inc: { totalCollectedCredit: creditCost },
            $set: { updatedAt: now },
          },
          { session }
        );
        const updated = await courseCollection.findOne({ _id: course._id }, { session });
        responsePayload = {
          status: 201,
          body: {
            success: true,
            course: await helpers.hydrateCourse(updated, userId),
            remainingCredit: creditResult.remainingCredit,
          },
        };
      });
      res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error enrolling in course:", err);
      res.status(500).json({ error: "Failed to buy course." });
    } finally {
      await session.endSession();
    }
  });

  router.post("/api/courses/:courseId/sessions/:sessionId/rate", async (req, res) => {
    try {
      const { rating, note = "" } = req.body;
      const userId = await resolveActor(req, res, req.body?.userId);
      if (!userId) return;
      const course = await getCourse(req.params.courseId);
      if (!course) return res.status(404).json({ error: "Course not found." });
      if (!(course.enrollments || []).some((item) => item.studentId === userId && item.status !== "cancelled"))
        return res.status(403).json({ error: "Enroll before rating course sessions." });
      const session = (course.sessions || []).find((item) => item.id === req.params.sessionId);
      if (!session) return res.status(404).json({ error: "Class session not found." });
      // the page only offers rating after attending; ratings move teacher quality
      if (!session.studentAttendance?.[userId])
        return res.status(403).json({ error: "Attend this class before rating it." });
      if ((session.ratings || []).some((item) => item.studentId === userId))
        return res.status(409).json({ error: "You already rated this session." });
      const review = {
        studentId: userId,
        rating: Math.min(Math.max(Number(rating) || 0, 1), 5),
        note: String(note || "").trim().slice(0, 300),
        createdAt: new Date(),
      };
      await courseCollection.updateOne(
        { _id: course._id, "sessions.id": req.params.sessionId },
        { $push: { "sessions.$.ratings": review }, $set: { updatedAt: new Date() } }
      );
      await recordRatingEvent({
        teacherId: course.teacherId,
        studentId: userId,
        source: "course_session_rating",
        sourceId: `${course._id}:${req.params.sessionId}`,
        dedupeKey: `course_session_rating:${course._id}:${req.params.sessionId}:${userId}`,
        rating: review.rating,
        metadata: {
          courseId: String(course._id),
          sessionId: req.params.sessionId,
        },
      });
      const teacher = await userCollection.findOne(
        { uid: course.teacherId },
        { projection: { points: 1 } }
      );
      await applyTeacherQualitySnapshot({ teacherId: course.teacherId, basePoints: teacher?.points || 0 });
      const updated = await courseCollection.findOne({ _id: course._id });
      res.json({ success: true, course: await helpers.hydrateCourse(updated, userId) });
    } catch (err) {
      console.error("Error rating course session:", err);
      res.status(500).json({ error: "Failed to rate session." });
    }
  });

  router.patch("/api/courses/:courseId/sessions/:sessionId/reschedule", async (req, res) => {
    try {
      // scheduledAt is an ISO instant from the app (built from the teacher's
      // local datetime-local value), so no server-timezone guessing here
      const { scheduledAt, time = "" } = req.body;
      const teacherId = await resolveActor(req, res, req.body?.teacherId);
      if (!teacherId) return;
      const course = await getCourse(req.params.courseId);
      if (!course) return res.status(404).json({ error: "Course not found." });
      if (course.teacherId !== teacherId)
        return res.status(403).json({ error: "Only the course teacher can reschedule classes." });
      if (!(course.sessions || []).some((item) => item.id === req.params.sessionId))
        return res.status(404).json({ error: "Class session not found." });
      const nextScheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      if (!nextScheduledAt || Number.isNaN(nextScheduledAt.getTime()))
        return res.status(400).json({ error: "Valid class time is required." });
      await courseCollection.updateOne(
        { _id: course._id, "sessions.id": req.params.sessionId },
        {
          $set: {
            "sessions.$.scheduledAt": nextScheduledAt,
            "sessions.$.time": String(time || "").trim(),
            "sessions.$.status": "scheduled",
            "sessions.$.rescheduledAt": new Date(),
            updatedAt: new Date(),
          },
        }
      );
      const updated = await courseCollection.findOne({ _id: course._id });
      // was `userId`, which this handler never declared: the reschedule saved
      // and then the response threw a ReferenceError (500)
      res.json({ success: true, course: await helpers.hydrateCourse(updated, teacherId) });
    } catch (err) {
      console.error("Error rescheduling course session:", err);
      res.status(500).json({ error: "Failed to reschedule class." });
    }
  });

  router.post("/api/courses/:courseId/sessions/:sessionId/attendance", async (req, res) => {
    res.status(410).json({
      error: "Course attendance is tracked automatically from class calls.",
    });
  });

  router.get("/api/admin/courses", async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.category) filter.category = req.query.category;
      if (req.query.type) filter.type = req.query.type;
      const list = await courseCollection.find(filter).sort({ updatedAt: -1 }).limit(120).toArray();
      const courses = await Promise.all(list.map(async (course) => ({
        ...(await helpers.hydrateCourse(course, "", { includeEnrollments: true })),
        earnings: await helpers.calculateCourseEarnings(course),
      })));
      res.json({ success: true, courses });
    } catch (err) {
      console.error("Error fetching admin courses:", err);
      res.status(500).json({ error: "Failed to fetch courses." });
    }
  });

  router.patch("/api/admin/courses/:courseId/approve", async (req, res) => {
    try {
      const { pricing = {}, status = "published", featured = false } = req.body;
      const course = await getCourse(req.params.courseId);
      if (!course) return res.status(404).json({ error: "Course not found." });
      const cleanPricing = {
        session: Math.max(0, Math.ceil(Number(pricing.session) || 0)),
        monthly: Math.max(0, Math.ceil(Number(pricing.monthly) || 0)),
        full: Math.max(0, Math.ceil(Number(pricing.full) || 0)),
      };
      await courseCollection.updateOne(
        { _id: course._id },
        {
          $set: {
            pricing: cleanPricing,
            status: status === "rejected" ? "rejected" : "published",
            featured: Boolean(featured),
            approvedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );
      const updated = await courseCollection.findOne({ _id: course._id });
      res.json({ success: true, course: await helpers.hydrateCourse(updated, "", { includeEnrollments: true }) });
    } catch (err) {
      console.error("Error approving course:", err);
      res.status(500).json({ error: "Failed to approve course." });
    }
  });

  router.post("/api/admin/courses/:courseId/pay-teacher", async (req, res) => {
    try {
      const course = await getCourse(req.params.courseId);
      if (!course) return res.status(404).json({ error: "Course not found." });
      const earnings = await helpers.calculateCourseEarnings(course);
      const payment = {
        courseId: course._id.toString(),
        teacherId: course.teacherId,
        amount: earnings.teacherPayable,
        pointsAdded: earnings.totalPointsToAdd,
        earnings,
        paidAt: new Date(),
        note: req.body?.note || "",
      };
      await databaseinmongo.collection("courseTeacherPayments").insertOne(payment);
      if (earnings.totalPointsToAdd > 0) {
        await userCollection.updateOne(
          { uid: course.teacherId, role: "teacher" },
          { $inc: { totalPoints: earnings.totalPointsToAdd } }
        );
      }
      await courseCollection.updateOne(
        { _id: course._id },
        { $push: { teacherPayments: payment }, $set: { updatedAt: new Date() } }
      );
      res.json({ success: true, payment });
    } catch (err) {
      console.error("Error paying course teacher:", err);
      res.status(500).json({ error: "Failed to mark course payment." });
    }
  });

  return router;
};
