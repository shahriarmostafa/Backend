const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { STUDY_ROOM_TEACHER_POINT_RATE } = require("../utils/constants");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");
// Billing arithmetic lives in moneyHelpers so it can be unit tested without a
// database or a transaction.
const {
  getGeneralCallPoints,
  getRoomCallCreditRate,
  getCallCreditForSeconds,
  getBillableCallSeconds,
  clampCreditRate,
} = require("../utils/moneyHelpers");
const { requireParty, resolveActor } = require("../utils/actor");
const { findDirectChatEntry } = require("../utils/chatAccess");
const { sendPush } = require("../utils/push");
const courseHelpersModule = require("../utils/courseHelpers");

// One ring per student and teacher in this window; a stuck button or a retry
// loop should not buzz the teacher's phone over and over.
const RING_THROTTLE_MS = 15 * 1000;

module.exports = ({ userCollection, activepackages, databaseinmongo, client, studyRooms, courses, admin }) => {
  const router = Router();

  // Whether a student's enrollment covers this course class.
  const courseHelpers = courseHelpersModule.makeCourseHelpers({ userCollection, activepackages, databaseinmongo, courses });
  const hasCourseAccess = (course, studentId, courseSessionId) => {
    const check = courseHelpersModule.hasCourseSessionAccess || courseHelpers.hasCourseSessionAccess;
    if (typeof check === "function") return check(course, studentId, courseSessionId);
    return (course.enrollments || []).some(
      (enrollment) => (enrollment.studentId || enrollment.student?.uid) === studentId
    );
  };
  const { createRoomNotification } = makeNotificationHelpers({
    databaseinmongo,
    userCollection,
    studyRooms,
  });


  /**
   * Both sides of a call post this once it is accepted; the first creates the
   * session. Who the student and teacher are, and the rate, used to be taken
   * as sent: a student could bill someone else or send `creditRate: 0.1`, and a
   * teacher could open sessions with no student and collect call points.
   */
  router.post("/start-call", async (req, res) => {
    try {
      const {
        sessionId,
        studentId,
        teacherId,
        roomId,
        roomCallId,
        parentSessionId,
        participantName,
        participantPhotoURL,
        courseId,
        courseSessionId,
        teacherStarted = false,
      } = req.body;
      if (!sessionId || typeof sessionId !== "string" || sessionId.length > 120) {
        return res.status(400).json({ success: false, message: "sessionId is required" });
      }
      if (!teacherId) return res.status(400).json({ success: false, message: "teacherId is required" });

      const callSession = databaseinmongo.collection("callSession");
      // A second /start-call for the same session (the other side) must name the
      // same people; it can't re-point a session at someone else.
      const existing = await callSession.findOne({ sessionId }, { projection: { studentId: 1, teacherId: 1 } });
      if (existing) {
        const caller = await requireParty(req, res, [existing.studentId, existing.teacherId], req.body.callerId);
        if (!caller) return;
        return res.status(200).json({ success: false, message: "Call session already exists" });
      }

      const caller = await requireParty(req, res, [studentId, teacherId], req.body.callerId);
      if (!caller) return;

      const teacher = await userCollection.findOne({ uid: teacherId }, { projection: { role: 1 } });
      if (teacher?.role !== "teacher") {
        return res.status(400).json({ success: false, message: "That account is not a teacher." });
      }

      let normalizedCreditRate = 1;
      let room = null;
      if (roomId) {
        room = ObjectId.isValid(roomId) ? await studyRooms.findOne({ _id: new ObjectId(roomId) }) : null;
        const isRoomTeacher = room?.teacherSessions?.some((session) => session.teacherId === teacherId);
        if (!room || !isRoomTeacher) {
          return res.status(403).json({ success: false, message: "That teacher is not part of this room." });
        }
        if (studentId && !(room.memberIds || []).includes(studentId)) {
          return res.status(403).json({ success: false, message: "Join this room before joining its classes." });
        }
        if (teacherStarted && room.teacherControl !== true) {
          return res.status(403).json({
            success: false,
            message: "Teacher-started classes are available only in teacher-controlled rooms.",
          });
        }
        // the room rate is settled for the whole group when the teacher ends
        normalizedCreditRate = clampCreditRate(1);
      } else if (courseId) {
        const course = ObjectId.isValid(courseId) ? await courses.findOne({ _id: new ObjectId(courseId) }) : null;
        if (!course || course.teacherId !== teacherId) {
          return res.status(403).json({ success: false, message: "That teacher does not run this course." });
        }
        if (studentId && !hasCourseAccess(course, studentId, courseSessionId)) {
          return res.status(403).json({ success: false, message: "Your course plan does not include this class." });
        }
      } else {
        // A 1:1 class needs a real student who already has a chat with this teacher.
        if (!studentId || studentId === teacherId) {
          return res.status(400).json({ success: false, message: "A class needs a student." });
        }
        const [student, chatEntry] = await Promise.all([
          userCollection.findOne({ uid: studentId }, { projection: { role: 1 } }),
          findDirectChatEntry(databaseinmongo, studentId, teacherId),
        ]);
        if (student?.role !== "student" || !chatEntry) {
          return res.status(403).json({ success: false, message: "Start a chat with this teacher first." });
        }
      }

      const sharedRoomCallId = roomId ? roomCallId || parentSessionId || sessionId : null;
      const studentProfile = studentId ? await userCollection.findOne({ uid: studentId }) : null;
      const startTime = Date.now();

      const result = await callSession.updateOne(
        { sessionId },
        {
          $setOnInsert: {
            studentId,
            teacherId,
            startTime,
            roomId: roomId || null,
            roomCallId: sharedRoomCallId,
            courseId: courseId || null,
            courseSessionId: courseSessionId || null,
            creditRate: normalizedCreditRate,
            participantName: studentProfile?.displayName || participantName || null,
            participantPhotoURL: studentProfile?.photoURL || participantPhotoURL || null,
            lastHeartbeatAt: startTime,
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        if (roomId && teacherId) {
          await createRoomNotification({
            roomId,
            type: "room_class_started",
            title: "Class started",
            message: "A room class is going on now.",
            actorId: teacherId,
            actorRole: "teacher",
            metadata: { roomCallId: sharedRoomCallId, sessionId },
            dedupeKey: `room-class-started:${roomId}:${sharedRoomCallId || sessionId}`,
          });
        }
        return res.status(201).json({ success: true, message: "Call session created" });
      } else {
        return res.status(200).json({ success: false, message: "Call session already exists" });
      }
    } catch (error) {
      console.error("Error starting call session:", error);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/end-call", async (req, res) => {
    const mongoSession = client.startSession();

    try {
      const { sessionId } = req.body;
      const endTime = Date.now();

      if (!sessionId)
        return res.status(400).json({ success: false, message: "sessionId is required" });

      const callSession = databaseinmongo.collection("callSession");
      const callRoomAwards = databaseinmongo.collection("callRoomAwards");
      let responsePayload = null;

      // Only someone on the call can end it, and only its teacher can close a
      // whole room class (any student could send endRoomCall before).
      const parties = await callSession.findOne({ sessionId }, { projection: { studentId: 1, teacherId: 1 } });
      if (!parties) return res.status(404).json({ success: false, message: "Session not found" });
      const caller = await requireParty(req, res, [parties.studentId, parties.teacherId], req.body.callerId);
      if (!caller) return;
      const endRoomCall = req.body.endRoomCall === true && caller === parties.teacherId;

      await mongoSession.withTransaction(async () => {
        let session = await callSession.findOne({ sessionId }, { session: mongoSession });

        if (!session) {
          responsePayload = { status: 404, body: { success: false, message: "Session not found" } };
          return;
        }

        if (endRoomCall && session.roomId && session.roomCallId && session.teacherId) {
          const groupSessions = await callSession
            .find(
              {
                roomId: session.roomId,
                roomCallId: session.roomCallId,
                teacherId: session.teacherId,
                studentId: { $exists: true, $ne: null },
              },
              { session: mongoSession }
            )
            .toArray();

          let totalCreditDeducted = 0;
          const finalizedSessions = [];
          const roomCallStudentCount = new Set(
            groupSessions.map((item) => item.studentId).filter(Boolean)
          ).size;
          const roomCreditRate = getRoomCallCreditRate(roomCallStudentCount);

          for (const item of groupSessions) {
            const itemSeconds = item.endTime
              ? Number(item.seconds) || 0
              : Math.floor((endTime - item.startTime) / 1000);
            const itemGeneralPoints =
              Number(item.callPoints) || getGeneralCallPoints(itemSeconds);

            if (!item.endTime) {
              await callSession.updateOne(
                { sessionId: item.sessionId, endTime: { $exists: false } },
                {
                  $set: {
                    endTime,
                    seconds: itemSeconds,
                    callPoints: itemGeneralPoints,
                    endedAt: new Date(endTime),
                    endedByTeacher: true,
                  },
                },
                { session: mongoSession }
              );
            }

            let itemCreditDeducted = Number(item.creditDeducted) || 0;
            if (!item.creditFinalized) {
              itemCreditDeducted = getCallCreditForSeconds(itemSeconds, roomCreditRate);

              if (itemCreditDeducted > 0) {
                await activepackages.updateOne(
                  { uid: item.studentId },
                  [
                    {
                      $set: {
                        credit: {
                          $max: [
                            { $subtract: [{ $ifNull: ["$credit", 0] }, itemCreditDeducted] },
                            0,
                          ],
                        },
                      },
                    },
                  ],
                  { session: mongoSession }
                );
              }

              await callSession.updateOne(
                { sessionId: item.sessionId },
                {
                  $set: {
                    creditDeducted: itemCreditDeducted,
                    creditFinalized: true,
                    creditFinalizedAt: new Date(),
                  },
                },
                { session: mongoSession }
              );
            }

            totalCreditDeducted += itemCreditDeducted;
            finalizedSessions.push({ ...item, seconds: itemSeconds, callPoints: itemGeneralPoints });
          }

          const totalStudentSeconds = finalizedSessions.reduce(
            (total, item) => total + (Number(item.seconds) || 0),
            0
          );
          const groupGeneralPoints = getGeneralCallPoints(totalStudentSeconds);
          const targetTeacherPoints =
            roomCallStudentCount > 1
              ? Math.ceil(STUDY_ROOM_TEACHER_POINT_RATE * groupGeneralPoints)
              : groupGeneralPoints;
          const awardId = `${session.roomId}:${session.roomCallId}:${session.teacherId}`;
          const awardResult = await callRoomAwards.findOneAndUpdate(
            { _id: awardId },
            [
              {
                $set: {
                  previousAwardedPoints: { $ifNull: ["$awardedPoints", 0] },
                  updatedAt: new Date(),
                },
              },
              {
                $set: {
                  awardedPoints: {
                    $max: [{ $ifNull: ["$awardedPoints", 0] }, targetTeacherPoints],
                  },
                },
              },
              {
                $set: {
                  lastDelta: { $subtract: ["$awardedPoints", "$previousAwardedPoints"] },
                  roomId: session.roomId,
                  roomCallId: session.roomCallId,
                  teacherId: session.teacherId,
                },
              },
            ],
            { upsert: true, returnDocument: "after", session: mongoSession }
          );
          const teacherPointsToAdd = Math.max(Number(awardResult?.lastDelta) || 0, 0);

          if (teacherPointsToAdd > 0) {
            await userCollection.updateOne(
              { _id: session.teacherId },
              { $inc: { points: teacherPointsToAdd } },
              { session: mongoSession }
            );
          }

          await callSession.updateMany(
            {
              roomId: session.roomId,
              roomCallId: session.roomCallId,
              teacherId: session.teacherId,
            },
            {
              $set: {
                roomCallFinalized: true,
                roomCallFinalizedAt: new Date(),
                teacherPointsFinalized: true,
              },
            },
            { session: mongoSession }
          );

          responsePayload = {
            status: 200,
            body: {
              success: true,
              roomCallEnded: true,
              studentsFinalized: roomCallStudentCount,
              pointsGiven: teacherPointsToAdd,
              generalCallPoints: groupGeneralPoints,
              totalStudentSeconds,
              creditDeducted: totalCreditDeducted,
            },
          };
          return;
        }

        const seconds = session.endTime
          ? Number(session.seconds) || 0
          : Math.floor((endTime - session.startTime) / 1000);

        let generalCallPoints = Number(session.callPoints) || 0;
        if (!session.endTime) {
          generalCallPoints = getGeneralCallPoints(seconds);

          await callSession.updateOne(
            { sessionId, endTime: { $exists: false } },
            {
              $set: {
                endTime,
                seconds,
                callPoints: generalCallPoints,
                endedAt: new Date(endTime),
              },
            },
            { session: mongoSession }
          );

          session = { ...session, endTime, seconds, callPoints: generalCallPoints };
        }

        if (session.courseId && session.courseSessionId && ObjectId.isValid(session.courseId)) {
          const attendanceField = session.studentId
            ? `sessions.$.studentAttendance.${session.studentId}`
            : "sessions.$.teacherAttendance";
          await courses.updateOne(
            { _id: new ObjectId(session.courseId), "sessions.id": session.courseSessionId },
            {
              $set: {
                [attendanceField]: true,
                "sessions.$.status": "completed",
                "sessions.$.lastCallEndedAt": new Date(endTime),
                updatedAt: new Date(),
              },
            },
            { session: mongoSession }
          );
        }

        // A direct class is billed, and the teacher paid, only for the part the
        // student's credit covered.
        const isDirectCall = Boolean(session.studentId && session.teacherId && !session.roomId && !session.courseId);
        const directRate = clampCreditRate(session.creditRate);
        let billableSeconds = seconds;
        if (isDirectCall && !session.creditFinalized) {
          const pkg = await activepackages.findOne(
            { uid: session.studentId },
            { projection: { credit: 1 }, session: mongoSession }
          );
          billableSeconds = getBillableCallSeconds(seconds, pkg?.credit, directRate);
        }

        let teacherPointsToAdd = Number(session.teacherPointsAdded) || 0;
        if (!session.teacherPointsFinalized && isDirectCall) {
          teacherPointsToAdd = getGeneralCallPoints(billableSeconds);

          if (teacherPointsToAdd > 0) {
            await userCollection.updateOne(
              { _id: session.teacherId },
              { $inc: { points: teacherPointsToAdd } },
              { session: mongoSession }
            );
          }

          await callSession.updateOne(
            { sessionId },
            {
              $set: {
                teacherPointsAdded: teacherPointsToAdd,
                teacherPointsFinalized: true,
                teacherPointsFinalizedAt: new Date(),
              },
            },
            { session: mongoSession }
          );
        }

        let creditToDeduct = Number(session.creditDeducted) || 0;
        if (!session.creditFinalized && isDirectCall) {
          creditToDeduct = getCallCreditForSeconds(billableSeconds, directRate);

          if (creditToDeduct > 0) {
            await activepackages.updateOne(
              { uid: session.studentId },
              [
                {
                  $set: {
                    credit: {
                      $max: [
                        { $subtract: [{ $ifNull: ["$credit", 0] }, creditToDeduct] },
                        0,
                      ],
                    },
                  },
                },
              ],
              { session: mongoSession }
            );
          }

          await callSession.updateOne(
            { sessionId },
            {
              $set: {
                creditDeducted: creditToDeduct,
                billedSeconds: billableSeconds,
                creditFinalized: true,
                creditFinalizedAt: new Date(),
              },
            },
            { session: mongoSession }
          );
        }

        responsePayload = {
          status: 200,
          body: {
            success: true,
            pointsGiven: teacherPointsToAdd,
            generalCallPoints,
            creditDeducted: creditToDeduct,
          },
        };
      });

      return res.status(responsePayload.status).json(responsePayload.body);
    } catch (err) {
      console.error("Error in /end-call:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    } finally {
      await mongoSession.endSession();
    }
  });

  /**
   * Rings the teacher's phone for a 1:1 class.
   *
   * The ring itself is the Firestore `calls/{teacherId}` doc, which only an
   * open, foregrounded app is listening to. The client's own push call was
   * disabled (`sendCallNotification` returned on its first line), so a teacher
   * with the app in the background or closed never knew a student was calling.
   */
  router.post("/api/calls/ring", async (req, res) => {
    try {
      const { sessionId, teacherId } = req.body || {};
      if (!sessionId || !teacherId) return res.status(400).json({ error: "sessionId and teacherId are required" });

      const studentId = await resolveActor(req, res, req.body.studentId);
      if (!studentId) return;
      if (!(await findDirectChatEntry(databaseinmongo, studentId, teacherId))) {
        return res.status(403).json({ error: "Start a chat with this teacher first." });
      }

      const rings = databaseinmongo.collection("callRings");
      const recent = await rings.findOne({
        studentId,
        teacherId,
        createdAt: { $gt: new Date(Date.now() - RING_THROTTLE_MS) },
      });
      if (recent) return res.json({ success: true, sent: false, throttled: true });
      await rings.insertOne({ studentId, teacherId, sessionId: String(sessionId), createdAt: new Date() });

      const [student, teacher] = await Promise.all([
        userCollection.findOne({ uid: studentId }, { projection: { displayName: 1 } }),
        userCollection.findOne({ uid: teacherId }, { projection: { FCMToken: 1, role: 1 } }),
      ]);
      if (teacher?.role !== "teacher" || !teacher.FCMToken) return res.json({ success: true, sent: false });

      const studentName = student?.displayName || "A student";
      const sent = await sendPush(admin, teacher.FCMToken, {
        title: "Incoming class",
        body: `${studentName} is calling you for a class`,
        data: { type: "incoming_call", callType: "incoming", sessionId, callerName: studentName, path: "/chat" },
      });
      res.json({ success: true, sent });
    } catch (err) {
      console.error("Error ringing teacher:", err);
      res.status(500).json({ error: "Could not notify the teacher." });
    }
  });

  router.post("/end-call-old-disabled", async (req, res) => {
    return res.status(410).json({ success: false, message: "This endpoint is disabled." });
  });

  return router;
};
