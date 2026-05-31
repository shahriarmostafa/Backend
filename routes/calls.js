const { Router } = require("express");
const {
  STUDY_ROOM_TEACHER_CREDIT_RATE,
  STUDY_ROOM_TEACHER_POINT_RATE,
} = require("../utils/constants");

module.exports = ({ userCollection, activepackages, databaseinmongo, client }) => {
  const router = Router();

  const getGeneralCallPoints = (totalSeconds) => {
    // Ignore extremely short calls
    if (totalSeconds < 40) return 0;

    // 40s - 3m
    if (totalSeconds < 180) return 3;

    // 3m - 5m
    if (totalSeconds < 300) return 5;

    // 5m - 10m
    if (totalSeconds < 600) return 8;

    // 10m - 15m
    if (totalSeconds < 900) return 12;

    // 15m - 20m
    if (totalSeconds < 1200) return 16;

    // 20m - 30m
    if (totalSeconds < 1800) return 22;
    return 28;
};

  router.post("/start-call", async (req, res) => {
    try {
      const {
        sessionId,
        studentId,
        teacherId,
        roomId,
        creditRate,
        roomCallId,
        parentSessionId,
        participantName,
        participantPhotoURL,
      } = req.body;
      const callSession = databaseinmongo.collection("callSession");
      const normalizedCreditRate = Math.min(Math.max(Number(creditRate) || 1, 0.1), 1);
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
            creditRate: normalizedCreditRate,
            participantName: participantName || studentProfile?.displayName || null,
            participantPhotoURL: participantPhotoURL || studentProfile?.photoURL || null,
            lastHeartbeatAt: startTime,
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
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
      const { sessionId, endRoomCall = false } = req.body;
      const endTime = Date.now();

      if (!sessionId)
        return res.status(400).json({ success: false, message: "sessionId is required" });

      const callSession = databaseinmongo.collection("callSession");
      const callRoomAwards = databaseinmongo.collection("callRoomAwards");
      let responsePayload = null;

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
          const roomCreditRate = roomCallStudentCount > 1 ? STUDY_ROOM_TEACHER_CREDIT_RATE : 1;

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
              const baseCreditToDeduct = Math.floor(itemSeconds / 10);
              itemCreditDeducted = Math.ceil(baseCreditToDeduct * roomCreditRate);

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

        let teacherPointsToAdd = Number(session.teacherPointsAdded) || 0;
        if (!session.teacherPointsFinalized && session.teacherId && !session.roomId) {
          teacherPointsToAdd = generalCallPoints;

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
        if (!session.creditFinalized && session.studentId && !session.roomId) {
          let creditRate = Math.min(Math.max(Number(session.creditRate) || 1, 0.1), 1);
          const baseCreditToDeduct = Math.floor(seconds / 10);
          creditToDeduct = Math.ceil(baseCreditToDeduct * creditRate);

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

  router.post("/end-call-old-disabled", async (req, res) => {
    return res.status(410).json({ success: false, message: "This endpoint is disabled." });
  });

  return router;
};
