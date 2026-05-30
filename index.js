const express = require("express");
const app = express();
const cors =  require("cors");
const port = process.env.PORT || 5000;

require("dotenv").config();
const axios = require("axios");
app.use(cors());
app.use(express.json());


const http = require("http");

const {Server}  = require("socket.io");

const server = http.createServer(app);


const io = require("socket.io")(server,{
  cors: {
    origin: "*", // Allow frontend to connect (replace with frontend URL in production)
    methods: ["GET", "POST"]
  }
})




const shurjopay = require("shurjopay")();
shurjopay.config(
  process.env.SP_ENDPOINT,
  process.env.SP_USERNAME,
  process.env.SP_PASSWORD,
  process.env.SP_PREFIX,
  process.env.SP_RETURN_URL,
  process.env.SP_CANCEL_URL
);




const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

//setting up agora access token
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;



//setting agora white board token

const AUTHORIZATION_TOKEN = process.env.AUTHORIZATION_TOKEN;  // Make sure this is in .env


app.post('/create-whiteboard-room', async(req, res) => {
  const url = `https://api.netless.link/v5/rooms`;

    try {
        const response = await axios.post(url, 
          {
          isRecord: false
        }, 
        {
            headers: {
                'token': 'NETLESSSDK_YWs9Wk8xVHlldTdFM0RJa1RoeCZub25jZT1iNWE3N2NmMC1lOTliLTExZWYtYTdmZi1mMWQ4MmIxZjEwMDUmcm9sZT0wJnNpZz0wMjViYjg1NmU3ZmZmNWM2NTExODJiNjYyZjU2NjcxNGJhNTRjMGY0ZDFlNDU0NGU0ZjIxZDlkNzE3ZTJjOTA4',
                'Content-Type': 'application/json',
                'region': 'us-sv'
            },
        });
        
      

        res.status(200).json({uuid: response.data.uuid});
        
        
    } catch (error) {
        console.error("Error generating whiteboard token:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to generate whiteboard token" });
    }

})

app.post('/generate-whiteboard-token', async (req, res) => {

  const uuid = req.body.UUID;  
    try {
        
        const response = await axios.post(`https://api.netless.link/v5/tokens/rooms/${uuid}`,
          {lifespan:3600000,role:"admin"},
          {
            headers: {
              "token":"NETLESSSDK_YWs9Wk8xVHlldTdFM0RJa1RoeCZub25jZT0yZjU5NzllMC1lOTYwLTExZWYtYTdmZi1mMWQ4MmIxZjEwMDUmcm9sZT0wJnNpZz0zZDViZWFkOGM3Y2JiZTkzODdmMjJiNjkwNDY5OTQ3NDlmYmYyMjAyY2E4YWI3MDA1MTlhZDIwMDQyM2ZkMjVi",
              "Content-Type": "application/json",
              "region": "us-sv"
            }
          }
        )
        
      

        res.status(200).json({token: response.data});
        
        
    } catch (error) {
        console.error("Error generating whiteboard token:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to generate whiteboard token" });
    }
});


//agora call token

app.post("/generate-token", (req, res) => {
  
  const {channelName} = req.body;
  
  if(!channelName){    
    return res.status(400).json({ error: "Channel name is required" });
  }
  
  try{
    const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    const uid = Math.floor(100000 + Math.random() * 900000);
    const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpiredTs
    );

    console.log(token);
    
    
    
    res.json({ token, uid});
  }
  catch(err){
    console.log(err);
  }
})



//getting firestore

const {database, admin} = require("./firebase.config");





//setting notification token







app.post('/createCustomToken', async (req, res) => {
  const { uid } = req.body;

  try {
    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ token: customToken });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error creating token');
  }
});



// inbox message sending

// ✅ General Push Notification
app.post("/send-notification", async (req, res) => {
  const { nottificationToken, senderName, nottificationMessage } = req.body;

  if (!nottificationToken || !nottificationMessage || !senderName) {
    return res.status(400).json({ error: "Token, sender name, or message missing" });
  }

  const payload = {
  notification: {
    title: senderName,
    body: nottificationMessage
    // Do NOT put `sound` here
  },
  android: {
    priority: "high",
    notification: {
      sound: "default", // ✅ REQUIRED for sound in killed state
      channelId: "high_importance_channel", // ✅ must match AndroidManifest
      clickAction: "FLUTTER_NOTIFICATION_CLICK"
    }
  },
  apns: {
    payload: {
      aps: {
        sound: "default", // ✅ for iOS
        contentAvailable: true
      }
    }
  },
  data: {
    type: "chat_message",
    senderName,
    message: nottificationMessage
  },
  token: nottificationToken
};



  try {
    await admin.messaging().send(payload);
    console.log("📩 Notification sent successfully");
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error sending notification:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});




// ✅ Call Notification (Auto open UI in RN or Web)
app.post("/send-call-notification", async (req, res) => {
  const { receiverToken, callerName, callType, roomId } = req.body;

  if (!receiverToken || !callerName || !roomId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const payload = {
  notification: {
    title: "Class invitation",
    body: `${callerName} is requesting a class session`
  },
  android: {
    priority: "high",
    notification: {
      channelId: "high_importance_channel", // ✅ correct place
      sound: "default",
      clickAction: "FLUTTER_NOTIFICATION_CLICK"
    }
  },
  data: {
    type: "incoming_call",
    callerName,
    callType,
    roomId
  },
  token: receiverToken
};

  try {
    await admin.messaging().send(payload);
    res.json({ success: true });
  } catch (error) {
    console.error("Error sending call notification:", error);
    res.status(500).json({ error: "Failed to send call notification" });
  }
});











const newOne = 'https://www.dropbox.com/scl/fi/jv183z6fo0ywkl3sj0i3r/PoperL-android-64bit.apk?rlkey=5eiwrnguqvt5l5v4l8llz5hmi&st=y29g63si&dl=1';
const oldOne = 'https://www.dropbox.com/scl/fi/lkmh1gsgerx9p0owjja3y/PoperL-android-32bit.apk?rlkey=rdzczako0lzi4xlunnmab2vsl&st=wpceufgp&dl=1';

app.get('/download-link', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  let apkUrl;

  if (ua.includes('arm64')) {
    apkUrl = newOne;
  } else {
    apkUrl = oldOne;
  }

  res.json({ url: "https://www.dropbox.com/scl/fi/syo7s5nvt44iq5sufn516/PoperL.apk?rlkey=w91illigslfci3lq1olytuub6&st=f2zjqc8g&dl=1" });
});



const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://ssmustafasahir:${process.env.PASSWORD_DB}@cluster0.c6fvj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const databaseinmongo = client.db("PoperL");
    const subscriptions = databaseinmongo.collection("subscriptions");
    const referrals = databaseinmongo.collection("referrals");
    const withdrawals = databaseinmongo.collection("withdrawals");
    const activepackages = databaseinmongo.collection("activePackages");
    const userCollection = databaseinmongo.collection("userCollection");
    const studyRooms = databaseinmongo.collection("studyRooms");
    const STUDY_ROOM_MAX_STUDENTS = 10;
    const STUDY_ROOM_JOIN_CREDIT = 20;
    const STUDY_ROOM_CREATE_CREDIT = 50;
    const STUDY_ROOM_TEACHER_CREDIT_RATE = 0.7;
    const STUDY_ROOM_TEACHER_POINT_RATE = 0.7;
    const STUDY_ROOM_TEACHER_SESSION_MS = 60 * 60 * 1000;
    const STUDY_ROOM_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
    const REFERRAL_REWARD_CREDIT = 50;
    const REFERRAL_REWARD_DURATION_HOURS = 1;

    const awardReferralCredit = async (referredUid, qualifyingOrderId = null) => {
      if (!referredUid) return { awarded: false, reason: "missing-referred-uid" };

      const referredUser = await userCollection.findOne({ uid: referredUid });
      const referrerUid = referredUser?.referredByUid;

      if (!referrerUid || referrerUid === referredUid) {
        return { awarded: false, reason: "no-valid-referrer" };
      }

      const alreadyAwarded = await referrals.findOne({
        referredUid,
        rewardStatus: "awarded",
      });

      if (alreadyAwarded) {
        return { awarded: false, reason: "already-awarded" };
      }

      const referrerUser = await userCollection.findOne({ uid: referrerUid });
      if (!referrerUser) return { awarded: false, reason: "referrer-not-found" };

      const now = new Date();
      const existingPackage = await activepackages.findOne({ uid: referrerUid });
      const hasActiveDuration =
        existingPackage?.isUnlimited ||
        (existingPackage?.expiryDate && new Date(existingPackage.expiryDate) > now);

      if (existingPackage && hasActiveDuration) {
        const expiryDate = existingPackage.isUnlimited
          ? existingPackage.expiryDate
          : new Date(existingPackage.expiryDate);

        if (!existingPackage.isUnlimited) {
          expiryDate.setHours(expiryDate.getHours() + REFERRAL_REWARD_DURATION_HOURS);
        }

        await activepackages.updateOne(
          { uid: referrerUid },
          {
            $set: {
              ...(existingPackage.isUnlimited ? {} : { expiryDate: expiryDate.toISOString() }),
              credit: Number(existingPackage.credit || 0) + REFERRAL_REWARD_CREDIT,
              totalCredit: Number(existingPackage.totalCredit || 0) + REFERRAL_REWARD_CREDIT,
              updatedAt: now,
            },
          }
        );
      } else {
        const startDate = now;
        const expiryDate = new Date(startDate);
        expiryDate.setHours(expiryDate.getHours() + REFERRAL_REWARD_DURATION_HOURS);

        await activepackages.updateOne(
          { uid: referrerUid },
          {
            $set: {
              uid: referrerUid,
              packageName: "Referral Reward",
              startDate: startDate.toISOString(),
              expiryDate: expiryDate.toISOString(),
              credit: REFERRAL_REWARD_CREDIT,
              totalCredit: REFERRAL_REWARD_CREDIT,
              isActive: true,
              paymentStatus: "approved",
              purchasedAt: now,
              category: existingPackage?.category || "referral",
              type: existingPackage?.type || "referral",
              isUnlimited: false,
              price: 0,
              updatedAt: now,
            },
          },
          { upsert: true }
        );
      }

      await referrals.updateOne(
        { referredUid },
        {
          $set: {
            referrerUid,
            referredUid,
            qualifyingOrderId,
            rewardCredit: REFERRAL_REWARD_CREDIT,
            rewardDurationHours: REFERRAL_REWARD_DURATION_HOURS,
            rewardStatus: "awarded",
            awardedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true }
      );

      await userCollection.updateOne(
        { uid: referredUid },
        { $set: { referralRewardedAt: now } }
      );

      await subscriptions.insertOne({
        uid: referrerUid,
        name: referrerUser.displayName,
        packageName: "Referral Reward",
        credit: REFERRAL_REWARD_CREDIT,
        price: 0,
        durationDays: REFERRAL_REWARD_DURATION_HOURS,
        category: existingPackage?.category || "referral",
        orderId: qualifyingOrderId,
        type: "referral-reward",
        paymentStatus: "approved",
        referredUid,
        createdAt: now,
      });

      return { awarded: true, referrerUid };
    };

    const makeRoomKeyword = () => {
      const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let keyword = "";
      for (let i = 0; i < 7; i++) {
        keyword += letters[Math.floor(Math.random() * letters.length)];
      }
      return keyword;
    };

    const getUniqueRoomKeyword = async () => {
      for (let i = 0; i < 10; i++) {
        const keyword = makeRoomKeyword();
        const existingRoom = await studyRooms.findOne({ keyword });
        if (!existingRoom) return keyword;
      }
      return `${makeRoomKeyword()}${Date.now().toString(36).slice(-1)}`.slice(0, 7);
    };

    const getStudentCreditPackage = async (studentId) => {
      const activePackage = await activepackages.findOne({ uid: studentId });
      if (!activePackage) return { activePackage: null, credit: 0, isValid: false };

      const isValid =
        activePackage.isActive === true &&
        new Date(activePackage.expiryDate) > new Date();

      return {
        activePackage,
        credit: Number(activePackage.credit) || 0,
        isValid,
      };
    };

    const spendStudentCredit = async (studentId, amount) => {
      const { credit, isValid } = await getStudentCreditPackage(studentId);

      if (!isValid) {
        return { ok: false, status: 403, message: "No active package found for this student." };
      }

      if (credit < amount) {
        return { ok: false, status: 402, message: `At least ${amount} credit is required.` };
      }

      await activepackages.updateOne(
        { uid: studentId },
        { $inc: { credit: -amount } }
      );

      return { ok: true, credit: credit - amount };
    };

    const getRoomMembership = (room, userId) => {
      const rawStatus = room?.memberStatuses?.[userId];
      const joinedAt = rawStatus?.joinedAt ? new Date(rawStatus.joinedAt) : new Date(room?.createdAt || Date.now());
      const nextBillingAt = rawStatus?.nextBillingAt
        ? new Date(rawStatus.nextBillingAt)
        : new Date(joinedAt.getTime() + STUDY_ROOM_MONTH_MS);
      const isActive = rawStatus?.isActive !== false && nextBillingAt.getTime() > Date.now();

      return {
        joinedAt,
        lastPaymentAt: rawStatus?.lastPaymentAt ? new Date(rawStatus.lastPaymentAt) : joinedAt,
        nextBillingAt,
        isActive,
      };
    };

    const buildMemberStatuses = (room) => {
      return (room.memberIds || []).reduce((acc, memberId) => {
        acc[memberId] = getRoomMembership(room, memberId);
        return acc;
      }, {});
    };

    const renewRoomMembership = async (room, userId) => {
      if (!(room.memberIds || []).includes(userId)) {
        return { ok: false, status: 404, message: "Student is not a member of this room." };
      }

      const creditResult = await spendStudentCredit(userId, STUDY_ROOM_JOIN_CREDIT);
      if (!creditResult.ok) return creditResult;

      const now = new Date();
      const nextBillingAt = new Date(now.getTime() + STUDY_ROOM_MONTH_MS);
      const membership = {
        joinedAt: getRoomMembership(room, userId).joinedAt,
        lastPaymentAt: now,
        nextBillingAt,
        isActive: true,
      };

      await studyRooms.updateOne(
        { _id: room._id },
        {
          $set: {
            [`memberStatuses.${userId}`]: membership,
            updatedAt: Date.now(),
          },
        }
      );

      return { ok: true, membership, credit: creditResult.credit };
    };

    const createStudyRoomChat = async ({ name, type, participantIds, teacherId = null, subject = null }) => {
      const chatDB = databaseinmongo.collection("chatDB");
      const newChat = await chatDB.insertOne({
        createdAt: new Date(),
        messages: [],
        roomChat: true,
        name,
        type,
        participantIds,
        teacherId,
        subject,
      });

      return {
        chatId: newChat.insertedId.toString(),
        name,
        type,
        participantIds,
        teacherId,
        subject,
        createdAt: new Date(),
      };
    };

    const hydrateRoomProgress = (room) => {
      const memberCount = (room.memberIds || []).length;
      const goals = (room.progress?.goals || []).map((goal) => {
        const votes = goal.votes || {};
        const yesCount = Object.values(votes).filter(Boolean).length;
        const noCount = Object.values(votes).filter((value) => value === false).length;
        const voteCount = Object.keys(votes).length;
        const completionPercent = memberCount > 0 ? Math.round((yesCount / memberCount) * 100) : 0;

        return {
          ...goal,
          yesCount,
          noCount,
          voteCount,
          memberCount,
          completionPercent,
          status: memberCount > 0 && yesCount >= memberCount ? "completed" : "active",
        };
      }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      const activeGoals = goals.filter((goal) => goal.status !== "completed");
      const completedGoals = goals.filter((goal) => goal.status === "completed");
      const averageCompletion = goals.length
        ? Math.round(goals.reduce((sum, goal) => sum + goal.completionPercent, 0) / goals.length)
        : 0;

      return {
        goals,
        summary: {
          totalGoals: goals.length,
          activeGoals: activeGoals.length,
          completedGoals: completedGoals.length,
          averageCompletion,
        },
      };
    };

    const hydrateStudyRoom = async (room) => {
      if (!room) return null;

      const [members, teachers] = await Promise.all([
        userCollection.find({ uid: { $in: room.memberIds || [] } }).toArray(),
        userCollection.find({ uid: { $in: (room.teacherSessions || []).map((item) => item.teacherId) } }).toArray(),
      ]);

      const teachersById = teachers.reduce((acc, teacher) => {
        acc[teacher.uid] = teacher;
        return acc;
      }, {});

      return {
        ...room,
        id: room._id.toString(),
        memberCount: (room.memberIds || []).length,
        memberStatuses: buildMemberStatuses(room),
        maxStudents: room.maxStudents || STUDY_ROOM_MAX_STUDENTS,
        members,
        progress: hydrateRoomProgress(room),
        teacherSessions: (room.teacherSessions || []).map((session) => ({
          ...session,
          teacher: teachersById[session.teacherId] || null,
        })),
      };
    };

    const hydrateTeacherRoomChat = (room, session) => {
      const chatName = session.name || `${room.name || "Study Room"} - ${session.subject || "Teacher Chat"}`;

      return {
        ...session,
        name: chatName,
        roomId: room._id.toString(),
        roomName: room.name,
        roomKeyword: room.keyword,
        memberIds: room.memberIds || [],
        memberCount: (room.memberIds || []).length,
        maxStudents: room.maxStudents || STUDY_ROOM_MAX_STUDENTS,
        roomCreditRate: STUDY_ROOM_TEACHER_CREDIT_RATE,
      };
    };

    //check if admin

    app.get("/isOwner/:uid", async (req, res) => {
      try{
        const uid = req.params.uid;
        
        const ownerCollection = databaseinmongo.collection("owner");
        const result = await ownerCollection.findOne({uid: uid})
        
        if(result.owner === "1"){
          res.status(200).json({owner: true})
        }
        else{
          res.status(200).json({owner: false})
        }
        
      }catch(err){
        console.log(err);
        
      }
    })



    //authentication
    app.post("/newTeacher", async (req, res) => {
  try {
    const user = req.body;

    // Check if user already exists (by email)
    const existingUser = await userCollection.findOne({ email: user.email });

    if (existingUser) {
      // Update FCM Token only
      await userCollection.updateOne(
        { _id: user.uid },
        { $set: { FCMToken: user.FCMToken } }
      );

      return res.status(200).json({
        success: true,
        message: "User already exists, skipping teacher registration."
      });
    }

    // Insert teacher (or upsert)
    await userCollection.updateOne(
      { _id: user.uid },
      { $set: user },
      { upsert: true }
    );

    // Initialize empty chat list (if not already exists)
    await databaseinmongo.collection("chatCollection").updateOne(
      { _id: user.uid },
      { $setOnInsert: { chats: [] } },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      message: "Teacher added successfully."
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: "Failed to add a new teacher."
    });
  }
});

  app.post("/newStudent", async (req, res) => {
  try {
    const user = req.body;
    const referredByUid =
      typeof user.referredByUid === "string" && user.referredByUid.trim()
        ? user.referredByUid.trim()
        : null;

    if (referredByUid && referredByUid !== user.uid) {
      user.referredByUid = referredByUid;
      user.referredAt = new Date();
    } else {
      delete user.referredByUid;
    }

    // Check if user already exists (by email)
    const existingUser = await userCollection.findOne({ email: user.email });

    if (existingUser) {
      // Update FCM Token only
      await userCollection.updateOne(
        { _id: user.uid },
        { $set: { FCMToken: user.FCMToken } }
      );

      return res.status(200).json({
        success: true,
        message: "User already exists, skipping student registration."
      });
    }

    // Insert student (or upsert)
    await userCollection.updateOne(
      { _id: user.uid },
      { $set: user },
      { upsert: true }
    );

    // Initialize empty chat list
    await databaseinmongo.collection("chatCollection").updateOne(
      { _id: user.uid },
      { $setOnInsert: { chats: [] } },
      { upsert: true }
    );

    if (user.referredByUid) {
      await referrals.updateOne(
        { referredUid: user.uid },
        {
          $setOnInsert: {
            referrerUid: user.referredByUid,
            referredUid: user.uid,
            rewardCredit: REFERRAL_REWARD_CREDIT,
            rewardDurationHours: REFERRAL_REWARD_DURATION_HOURS,
            rewardStatus: "pending",
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    res.status(200).json({
      success: true,
      message: "Student added successfully."
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "An error occurred while processing the request."
    });
  }
});

  app.get("/api/referrals/stats/:uid", async (req, res) => {
    try {
      const { uid } = req.params;

      if (!uid) {
        return res.status(400).json({
          success: false,
          error: "uid is required",
        });
      }

      const referralDocs = await referrals.find({ referrerUid: uid }).toArray();
      const totalReferrals = referralDocs.length;
      const qualifiedReferrals = referralDocs.filter(
        (referral) => referral.rewardStatus === "awarded"
      ).length;
      const pendingReferrals = Math.max(0, totalReferrals - qualifiedReferrals);
      const totalRewardCredit = referralDocs.reduce(
        (sum, referral) => referral.rewardStatus === "awarded"
          ? sum + Number(referral.rewardCredit || 0)
          : sum,
        0
      );

      res.status(200).json({
        success: true,
        data: {
          totalReferrals,
          qualifiedReferrals,
          pendingReferrals,
          totalRewardCredit,
        },
      });
    } catch (error) {
      console.error("referral stats error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to load referral stats",
      });
    }
  });


// For teachers

// ========== 3. Active Teacher List ==========
app.get("/ActiveTeacherList", async (req, res) => {
  try {
    const { category, subject, type } = req.query;

    // Base filter for active + approved teachers
    let filter = { role: "teacher", approved: true, isActive: true };

    if (category) {
      filter.category = category;
    }

    if (subject) {
      filter.subjects = subject; // matches if subject is inside the array
    }

    if (type) {
      filter.type = type;
    }

    const result = await userCollection.find(filter).toArray();

    const teacherList = result.map(doc => ({
      id: doc._id,
      ...doc,
    }));

    res.status(200).send({ success: true, teachers: teacherList });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      error: "Failed to retrieve the teacher list.",
    });
  }
});




// admin

// ========== 4. Admin Teacher List ==========
app.get("/teacherList", async (req, res) => {
  try {
    const { category, subject } = req.query;

    // Base filter for approved teachers
    let filter = { role: "teacher", approved: true };

    if (category) {
      filter.category = category;
    }

    if (subject) {
      filter.subjects = subject;
    }

    const result = await userCollection.find(filter).toArray();

    const teacherList = result.map(doc => ({
      id: doc._id,
      ...doc,
    }));

    res.status(200).send({ success: true, teachers: teacherList });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      error: "Failed to retrieve the teacher list.",
    });
  }
});

// ========== Disabled Teacher List ==========
app.get("/disabledTeacherList", async (req, res) => {
  try {
    const result = await userCollection
      .find({ role: "teacher", approved: false })
      .toArray();

    const teacherList = result.map(doc => ({
      id: doc._id,
      ...doc,
    }));

    res.status(200).send({ success: true, teachers: teacherList });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      error: "Failed to retrieve the teacher list.",
    });
  }
});


// ========== Disable Teacher ==========
app.put("/disableTeacher/:uid", async (req, res) => {
  const uid = req.params.uid;
  try {
    const result = await userCollection.updateOne(
      { _id: uid, role: "teacher" },
      { $set: { approved: false } }
    );

    res.status(200).json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ========== Enable Teacher ==========
app.put("/enableTeacher/:uid", async (req, res) => {
  const uid = req.params.uid;
  try {
    const result = await userCollection.updateOne(
      { _id: uid, role: "teacher" },
      { $set: { approved: true } }
    );

    res.status(200).json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ========== Delete User ==========
app.delete("/deleteUser/:uid", async (req, res) => {
  const uid = req.params.uid;
  try {
    const result = await userCollection.deleteOne({ _id: uid });
    res.status(200).json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: err.message });
  }
});


// ========== Update Teacher Subjects ==========
app.put("/subjects", async (req, res) => {
  const { subjects, uid } = req.body;
  try {
    const result = await userCollection.updateOne(
      { _id: uid, role: "teacher" },
      { $set: { subjects: subjects } }
    );

    res.status(200).json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: err.message });
  }
});


// ========== Get Teacher Profile ==========
app.get("/userProfile/:uid", async (req, res) => {
  
  const uid = req.params.uid;

  try {
    const user = await userCollection.findOne({ uid: uid });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(200).json({ data: user });
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(400).json({ success: false, error: error.message });
  }
});


//set active for teachers
  app.post("/api/users/toggle-active", async (req, res) => {
  try {
    const { userId, isActive } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const updateResult = await userCollection.updateOne(
      { uid: userId },
      { $set: { isActive: isActive } }
    );

    res.json({ success: true, updateResult });
  } catch (err) {
    console.error("Error toggling active:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


//update fcm token

app.post("/api/users/update-fcm", async (req, res) => {
  try {
    const { userId, FCMToken } = req.body;

    if (!userId || !FCMToken) {
      return res.status(400).json({ error: "Missing userId or FCMToken" });
    }

    await userCollection.updateOne(
      { uid: userId },
      { $set: { FCMToken } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating FCM token:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});





    //study room codes
    app.get("/api/study-rooms", async (req, res) => {
      try {
        const { category, type, userId, memberOnly } = req.query;
        const filter = userId && memberOnly === "true"
          ? { memberIds: userId }
          : userId
          ? { $or: [{ visibility: "public" }, { memberIds: userId }] }
          : { visibility: "public" };

        if (category) filter.category = category;
        if (type) filter.type = type;

        const rooms = await studyRooms
          .find(filter)
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(50)
          .toArray();
        const hydratedRooms = await Promise.all(rooms.map(hydrateStudyRoom));

        res.json({
          success: true,
          rooms: hydratedRooms,
          costs: { join: STUDY_ROOM_JOIN_CREDIT, create: STUDY_ROOM_CREATE_CREDIT },
        });
      } catch (err) {
        console.error("Error fetching study rooms:", err);
        res.status(500).json({ error: "Failed to fetch study rooms." });
      }
    });

    app.get("/api/study-rooms/search/:keyword", async (req, res) => {
      try {
        const keyword = String(req.params.keyword || "").trim().toUpperCase();
        const room = await studyRooms.findOne({ keyword });
        if (!room) return res.status(404).json({ error: "Room not found." });
        res.json({ success: true, room: await hydrateStudyRoom(room) });
      } catch (err) {
        console.error("Error searching study room:", err);
        res.status(500).json({ error: "Failed to search study room." });
      }
    });

    app.get("/api/study-rooms/:roomId", async (req, res) => {
      try {
        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
        if (!room) return res.status(404).json({ error: "Room not found." });
        res.json({ success: true, room: await hydrateStudyRoom(room) });
      } catch (err) {
        console.error("Error fetching study room:", err);
        res.status(500).json({ error: "Failed to fetch study room." });
      }
    });

    app.post("/api/study-rooms", async (req, res) => {
      try {
        const { userId, name, visibility = "public", category = "school", type = "bangla_medium" } = req.body;
        const cleanName = String(name || "").trim();
        const cleanVisibility = visibility === "private" ? "private" : "public";
        const cleanCategory = ["school", "college", "university"].includes(category) ? category : "school";
        const cleanType = ["english_medium", "bangla_medium"].includes(type) ? type : "bangla_medium";

        if (!userId || !cleanName) {
          return res.status(400).json({ error: "userId and room name are required." });
        }

        const userDoc = await userCollection.findOne({ uid: userId, role: "student" });
        if (!userDoc) return res.status(403).json({ error: "Only students can create study rooms." });

        const creditResult = await spendStudentCredit(userId, STUDY_ROOM_CREATE_CREDIT);
        if (!creditResult.ok) return res.status(creditResult.status).json({ error: creditResult.message });

        const keyword = await getUniqueRoomKeyword();
        const now = new Date();
        const studentChat = await createStudyRoomChat({
          name: `${cleanName} Students`,
          type: "students",
          participantIds: [userId],
        });
        const roomDoc = {
          name: cleanName,
          visibility: cleanVisibility,
          category: cleanCategory,
          type: cleanType,
          keyword,
          createdBy: userId,
          memberIds: [userId],
          memberStatuses: {
            [userId]: {
              joinedAt: now,
              lastPaymentAt: now,
              nextBillingAt: new Date(now.getTime() + STUDY_ROOM_MONTH_MS),
              isActive: true,
            },
          },
          maxStudents: STUDY_ROOM_MAX_STUDENTS,
          studentChatId: studentChat.chatId,
          chats: [studentChat],
          teacherSessions: [],
          createdAt: now,
          updatedAt: Date.now(),
        };

        const result = await studyRooms.insertOne(roomDoc);
        const room = await studyRooms.findOne({ _id: result.insertedId });
        res.status(201).json({ success: true, room: await hydrateStudyRoom(room), remainingCredit: creditResult.credit });
      } catch (err) {
        console.error("Error creating study room:", err);
        res.status(500).json({ error: "Failed to create study room." });
      }
    });

    app.patch("/api/study-rooms/:roomId", async (req, res) => {
      try {
        const { userId, name, visibility, category, type } = req.body;
        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
        if (!room) return res.status(404).json({ error: "Room not found." });
        if (!userId || !(room.memberIds || []).includes(userId)) {
          return res.status(403).json({ error: "Only room members can edit this room." });
        }

        const update = { updatedAt: Date.now() };
        if (typeof name === "string" && name.trim()) update.name = name.trim();
        if (visibility === "public" || visibility === "private") update.visibility = visibility;
        if (["school", "college", "university"].includes(category)) update.category = category;
        if (["english_medium", "bangla_medium"].includes(type)) update.type = type;

        await studyRooms.updateOne({ _id: room._id }, { $set: update });
        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
      } catch (err) {
        console.error("Error updating study room:", err);
        res.status(500).json({ error: "Failed to update study room." });
      }
    });

    app.post("/api/study-rooms/:roomId/progress/goals", async (req, res) => {
      try {
        const { userId, title, note = "", dueDate = null } = req.body;
        const cleanTitle = String(title || "").trim();
        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

        if (!room) return res.status(404).json({ error: "Room not found." });
        if (!userId || !(room.memberIds || []).includes(userId) || !getRoomMembership(room, userId).isActive) {
          return res.status(403).json({ error: "Only active room students can add goals." });
        }
        if (!cleanTitle) return res.status(400).json({ error: "Goal title is required." });

        const now = new Date();
        const goal = {
          id: new ObjectId().toString(),
          title: cleanTitle.slice(0, 120),
          note: String(note || "").trim().slice(0, 400),
          dueDate: dueDate ? new Date(dueDate) : null,
          createdBy: userId,
          createdAt: now,
          votes: {
            [userId]: false,
          },
        };

        await studyRooms.updateOne(
          { _id: room._id },
          {
            $push: { "progress.goals": goal },
            $set: { updatedAt: Date.now() },
          }
        );

        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.status(201).json({ success: true, room: await hydrateStudyRoom(updatedRoom), goal });
      } catch (err) {
        console.error("Error adding study room goal:", err);
        res.status(500).json({ error: "Failed to add room goal." });
      }
    });

    app.patch("/api/study-rooms/:roomId/progress/goals/:goalId/vote", async (req, res) => {
      try {
        const { userId, completed } = req.body;
        const { goalId } = req.params;
        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

        if (!room) return res.status(404).json({ error: "Room not found." });
        if (!userId || !(room.memberIds || []).includes(userId) || !getRoomMembership(room, userId).isActive) {
          return res.status(403).json({ error: "Only active room students can update progress." });
        }
        if (!(room.progress?.goals || []).some((goal) => goal.id === goalId)) {
          return res.status(404).json({ error: "Goal not found." });
        }

        await studyRooms.updateOne(
          { _id: room._id, "progress.goals.id": goalId },
          {
            $set: {
              [`progress.goals.$.votes.${userId}`]: Boolean(completed),
              "progress.goals.$.updatedAt": new Date(),
              updatedAt: Date.now(),
            },
          }
        );

        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
      } catch (err) {
        console.error("Error voting on study room goal:", err);
        res.status(500).json({ error: "Failed to update room progress." });
      }
    });

    app.delete("/api/study-rooms/:roomId/progress/goals/:goalId", async (req, res) => {
      try {
        const { userId } = req.body;
        const { goalId } = req.params;
        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

        if (!room) return res.status(404).json({ error: "Room not found." });
        if (!userId || !(room.memberIds || []).includes(userId) || !getRoomMembership(room, userId).isActive) {
          return res.status(403).json({ error: "Only active room students can delete goals." });
        }

        const goalExists = (room.progress?.goals || []).some((goal) => goal.id === goalId);
        if (!goalExists) return res.status(404).json({ error: "Goal not found." });

        await studyRooms.updateOne(
          { _id: room._id },
          {
            $pull: { "progress.goals": { id: goalId } },
            $set: { updatedAt: Date.now() },
          }
        );

        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.json({ success: true, room: await hydrateStudyRoom(updatedRoom) });
      } catch (err) {
        console.error("Error deleting study room goal:", err);
        res.status(500).json({ error: "Failed to delete room goal." });
      }
    });

    app.post("/api/study-rooms/:roomId/join", async (req, res) => {
      try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required." });

        const userDoc = await userCollection.findOne({ uid: userId, role: "student" });
        if (!userDoc) return res.status(403).json({ error: "Only students can join study rooms." });

        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
        if (!room) return res.status(404).json({ error: "Room not found." });
        if ((room.memberIds || []).includes(userId)) {
          const membership = getRoomMembership(room, userId);
          if (membership.isActive) {
            return res.json({ success: true, room: await hydrateStudyRoom(room), alreadyJoined: true });
          }

          const renewalResult = await renewRoomMembership(room, userId);
          if (!renewalResult.ok) return res.status(renewalResult.status).json({ error: renewalResult.message });

          const renewedRoom = await studyRooms.findOne({ _id: room._id });
          return res.json({
            success: true,
            room: await hydrateStudyRoom(renewedRoom),
            renewed: true,
            remainingCredit: renewalResult.credit,
          });
        }
        if ((room.memberIds || []).length >= (room.maxStudents || STUDY_ROOM_MAX_STUDENTS)) {
          return res.status(409).json({ error: "This room is full." });
        }

        const creditResult = await spendStudentCredit(userId, STUDY_ROOM_JOIN_CREDIT);
        if (!creditResult.ok) return res.status(creditResult.status).json({ error: creditResult.message });

        const now = new Date();
        const nextMemberIds = [...(room.memberIds || []), userId];
        const updatedChats = (room.chats || []).map((chat) => (
          chat.type === "students"
            ? { ...chat, participantIds: nextMemberIds }
            : { ...chat, participantIds: [...new Set([...(chat.participantIds || []), userId])] }
        ));

        await studyRooms.updateOne(
          { _id: room._id },
          {
            $set: {
              memberIds: nextMemberIds,
              chats: updatedChats,
              [`memberStatuses.${userId}`]: {
                joinedAt: now,
                lastPaymentAt: now,
                nextBillingAt: new Date(now.getTime() + STUDY_ROOM_MONTH_MS),
                isActive: true,
              },
              updatedAt: Date.now(),
            },
          }
        );

        const chatDB = databaseinmongo.collection("chatDB");
        await Promise.all(updatedChats.map((chat) => (
          chat.chatId
            ? chatDB.updateOne({ _id: new ObjectId(chat.chatId) }, { $set: { participantIds: chat.participantIds } })
            : Promise.resolve()
        )));

        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.json({ success: true, room: await hydrateStudyRoom(updatedRoom), remainingCredit: creditResult.credit });
      } catch (err) {
        console.error("Error joining study room:", err);
        res.status(500).json({ error: "Failed to join study room." });
      }
    });

    app.post("/api/study-rooms/:roomId/renew", async (req, res) => {
      try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId is required." });

        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
        if (!room) return res.status(404).json({ error: "Room not found." });

        const renewalResult = await renewRoomMembership(room, userId);
        if (!renewalResult.ok) return res.status(renewalResult.status).json({ error: renewalResult.message });

        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.json({
          success: true,
          room: await hydrateStudyRoom(updatedRoom),
          remainingCredit: renewalResult.credit,
        });
      } catch (err) {
        console.error("Error renewing study room:", err);
        res.status(500).json({ error: "Failed to renew study room membership." });
      }
    });

    app.post("/api/study-rooms/:roomId/teachers", async (req, res) => {
      try {
        const { userId, teacherId, subject } = req.body;
        if (!userId || !teacherId) return res.status(400).json({ error: "userId and teacherId are required." });

        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });
        if (!room) return res.status(404).json({ error: "Room not found." });
        if (!(room.memberIds || []).includes(userId)) {
          return res.status(403).json({ error: "Join this room before adding a teacher." });
        }

        if (!getRoomMembership(room, userId).isActive) {
          return res.status(402).json({ error: "Renew this room membership before adding a teacher." });
        }

        const teacher = await userCollection.findOne({ uid: teacherId, role: "teacher", approved: true, isActive: true });
        if (!teacher) return res.status(404).json({ error: "Available teacher not found." });

        const teacherSubjects = Array.isArray(teacher.subjects) ? teacher.subjects : [];
        const selectedSubject = subject || teacherSubjects[0] || teacher.category || "General";
        const teacherChat = await createStudyRoomChat({
          name: `${teacher.displayName || "Teacher"} - ${selectedSubject}`,
          type: "teacher",
          participantIds: [...new Set([...(room.memberIds || []), teacherId])],
          teacherId,
          subject: selectedSubject,
        });
        const teacherSession = {
          ...teacherChat,
          addedBy: userId,
          addedAt: new Date(),
          expiresAt: new Date(Date.now() + STUDY_ROOM_TEACHER_SESSION_MS),
        };

        await studyRooms.updateOne(
          { _id: room._id },
          {
            $push: { chats: teacherChat, teacherSessions: teacherSession },
            $set: { updatedAt: Date.now() },
          }
        );

        const updatedRoom = await studyRooms.findOne({ _id: room._id });
        res.status(201).json({ success: true, room: await hydrateStudyRoom(updatedRoom), chat: teacherChat });
      } catch (err) {
        console.error("Error adding teacher to study room:", err);
        res.status(500).json({ error: "Failed to add teacher." });
      }
    });

    app.get("/api/teacher-room-chats/:teacherId", async (req, res) => {
      try {
        const { teacherId } = req.params;
        const teacher = await userCollection.findOne({ uid: teacherId, role: "teacher" });

        if (!teacher) {
          return res.status(403).json({ error: "Only teachers can view room chats." });
        }

        const rooms = await studyRooms
          .find({ "teacherSessions.teacherId": teacherId })
          .sort({ updatedAt: -1, createdAt: -1 })
          .toArray();

        const chats = rooms.flatMap((room) => (
          (room.teacherSessions || [])
            .filter((session) => session.teacherId === teacherId)
            .map((session) => hydrateTeacherRoomChat(room, session))
        ));

        chats.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

        res.json({
          success: true,
          chats,
          roomCreditRate: STUDY_ROOM_TEACHER_CREDIT_RATE,
        });
      } catch (err) {
        console.error("Error fetching teacher room chats:", err);
        res.status(500).json({ error: "Failed to fetch teacher room chats." });
      }
    });

    app.post("/api/study-rooms/:roomId/call-notification", async (req, res) => {
      try {
        const { callerId, callerName, chatName } = req.body;
        const room = await studyRooms.findOne({ _id: new ObjectId(req.params.roomId) });

        if (!room) {
          return res.status(404).json({ error: "Room not found." });
        }

        const memberIds = (room.memberIds || []).filter((memberId) => memberId !== callerId);
        if (!memberIds.length) {
          return res.json({ success: true, sent: 0 });
        }

        const members = await userCollection
          .find({ uid: { $in: memberIds }, FCMToken: { $exists: true, $ne: null } })
          .project({ FCMToken: 1 })
          .toArray();
        const tokens = [...new Set(members.map((member) => member.FCMToken).filter(Boolean))];

        if (!tokens.length) {
          return res.json({ success: true, sent: 0 });
        }

        const payload = {
          tokens,
          notification: {
            title: "Room class started",
            body: `${callerName || "A student"} started ${chatName || room.name}.`,
          },
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: "high_importance_channel",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
                contentAvailable: true,
              },
            },
          },
          data: {
            type: "room_class_invitation",
            roomId: room._id.toString(),
            roomName: room.name || "",
            chatName: chatName || "",
          },
        };

        const response = await admin.messaging().sendEachForMulticast(payload);
        res.json({ success: true, sent: response.successCount, failed: response.failureCount });
      } catch (err) {
        console.error("Error sending room call notification:", err);
        res.status(500).json({ error: "Failed to notify room members." });
      }
    });

    app.get("/api/room-calls/:roomCallId/participants", async (req, res) => {
      try {
        const { roomCallId } = req.params;
        const { teacherId, roomId } = req.query;

        const filter = { roomCallId };
        if (teacherId) filter.teacherId = teacherId;
        if (roomId) filter.roomId = roomId;

        const sessions = await databaseinmongo.collection("callSession")
          .find(filter)
          .project({ studentId: 1, participantName: 1, participantPhotoURL: 1, startTime: 1, endTime: 1 })
          .toArray();

        res.json({
          success: true,
          participants: sessions.map((item) => ({
            uid: item.studentId,
            displayName: item.participantName,
            photoURL: item.participantPhotoURL,
            joinedAt: item.startTime,
            leftAt: item.endTime || null,
            isActive: !item.endTime,
          })),
        });
      } catch (err) {
        console.error("Error fetching room call participants:", err);
        res.status(500).json({ error: "Failed to fetch participants." });
      }
    });

    app.post("/api/call-session/heartbeat", async (req, res) => {
      try {
        const { sessionId } = req.body;

        if (!sessionId) {
          return res.status(400).json({ error: "sessionId is required." });
        }

        await databaseinmongo.collection("callSession").updateOne(
          { sessionId, endTime: { $exists: false } },
          { $set: { lastHeartbeatAt: Date.now() } }
        );

        res.json({ success: true });
      } catch (err) {
        console.error("Error updating call heartbeat:", err);
        res.status(500).json({ error: "Failed to update heartbeat." });
      }
    });


    //chat codes
    //check if a chat already exist
    app.get("/chatExist/:userId/:receiverId", async (req, res) => {
      const { userId, receiverId } = req.params;
      const userChatCollection = databaseinmongo.collection("chatCollection");
    
      // Fetch the user's chat document
      const userChat = await userChatCollection.findOne({ _id: userId });
    
    
      // Check if the chat with the receiver exists
      const existingChat = userChat.chats.find(chat => chat.receiverId === receiverId);
    
      if (existingChat) {
        return res.json({ exists: true, chatId: existingChat.chatId });
      } else {
        return res.json({ exists: false });
      }
    });

    app.post("/createChat", async (req, res) => {
      const { userId, receiverId } = req.body;
      const chatDB = databaseinmongo.collection("chatDB");
      const userChatCollection = databaseinmongo.collection("chatCollection");
    
      // Create a new chat document
      const newChat = await chatDB.insertOne({
        createdAt: new Date(),
        messages: [],
      });
    
      const chatId = newChat.insertedId.toString();
    
      // Update chatCollection for both users
      await userChatCollection.updateOne(
        { _id: receiverId },
        {
          $push: {
            chats: {
              yourRole: "student",
              chatId,
              lastMessage: "",
              receiverId: userId,
              updatedAt: Date.now(),
            },
          },
        },
        { upsert: true }
      );
    
      await userChatCollection.updateOne(
        { _id: userId },
        {
          $push: {
            chats: {
              yourRole: "teacher",
              chatId,
              lastMessage: "",
              receiverId,
              updatedAt: Date.now(),
            },
          },
        },
        { upsert: true }
      );
    
      res.json({ chatId });
    });


    //call session and point update...
app.post("/start-call", async (req, res) => {
  try {
    const { sessionId, studentId, teacherId, roomId, creditRate, roomCallId, parentSessionId, participantName, participantPhotoURL } = req.body;
    const callSession = databaseinmongo.collection("callSession");
    const normalizedCreditRate = Math.min(Math.max(Number(creditRate) || 1, 0.1), 1);
    const sharedRoomCallId = roomId ? (roomCallId || parentSessionId || sessionId) : null;
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
        }
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

    app.post("/end-call", async (req, res) => {
      const mongoSession = client.startSession();

      try {
        const { sessionId, endRoomCall = false } = req.body;
        const endTime = Date.now();

        if (!sessionId) {
          return res.status(400).json({ success: false, message: "sessionId is required" });
        }

        const callSession = databaseinmongo.collection("callSession");
        const callRoomAwards = databaseinmongo.collection("callRoomAwards");
        let responsePayload = null;

        await mongoSession.withTransaction(async () => {
          let session = await callSession.findOne({ sessionId }, { session: mongoSession });

          if (!session) {
            responsePayload = { status: 404, body: { success: false, message: "Session not found" } };
            return;
          }

          const getGeneralCallPoints = (totalSeconds) => {
            if (totalSeconds >= 40 && totalSeconds < 180) return 2;
            if (totalSeconds >= 180 && totalSeconds < 300) return 3;
            if (totalSeconds >= 300 && totalSeconds < 600) return 5;
            if (totalSeconds >= 600 && totalSeconds < 900) return 8;
            if (totalSeconds >= 900 && totalSeconds < 1200) return 12;
            if (totalSeconds >= 1200 && totalSeconds < 1500) return 15;
            if (totalSeconds >= 1500) return 18;
            return 0;
          };

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
            const roomCallStudentCount = new Set(groupSessions.map((item) => item.studentId).filter(Boolean)).size;
            const roomCreditRate = roomCallStudentCount > 1 ? STUDY_ROOM_TEACHER_CREDIT_RATE : 1;

            for (const item of groupSessions) {
              const itemSeconds = item.endTime
                ? Number(item.seconds) || 0
                : Math.floor((endTime - item.startTime) / 1000);
              const itemGeneralPoints = Number(item.callPoints) || getGeneralCallPoints(itemSeconds);

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
              finalizedSessions.push({
                ...item,
                seconds: itemSeconds,
                callPoints: itemGeneralPoints,
              });
            }

            const totalStudentSeconds = finalizedSessions.reduce((total, item) => total + (Number(item.seconds) || 0), 0);
            const groupGeneralPoints = getGeneralCallPoints(totalStudentSeconds);
            const targetTeacherPoints = roomCallStudentCount > 1
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
                    lastDelta: {
                      $subtract: ["$awardedPoints", "$previousAwardedPoints"],
                    },
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

            session = {
              ...session,
              endTime,
              seconds,
              callPoints: generalCallPoints,
            };
          }

          let teacherPointsToAdd = Number(session.teacherPointsAdded) || 0;
          if (!session.teacherPointsFinalized && session.teacherId && !session.roomId) {
            teacherPointsToAdd = generalCallPoints;

            if (session.roomId && session.roomCallId) {
              const groupSessions = await callSession
                .find(
                  {
                    roomId: session.roomId,
                    roomCallId: session.roomCallId,
                    teacherId: session.teacherId,
                    endTime: { $exists: true },
                  },
                  { session: mongoSession }
                )
                .toArray();

              const studentCount = new Set(groupSessions.map((item) => item.studentId).filter(Boolean)).size;
              const groupGeneralPoints = Math.max(
                ...groupSessions.map((item) => Number(item.callPoints) || 0),
                generalCallPoints
              );
              const targetTeacherPoints = studentCount > 1
                ? Math.ceil(STUDY_ROOM_TEACHER_POINT_RATE * studentCount * groupGeneralPoints)
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
                      lastDelta: {
                        $subtract: ["$awardedPoints", "$previousAwardedPoints"],
                      },
                      roomId: session.roomId,
                      roomCallId: session.roomCallId,
                      teacherId: session.teacherId,
                    },
                  },
                ],
                { upsert: true, returnDocument: "after", session: mongoSession }
              );

              teacherPointsToAdd = Math.max(Number(awardResult?.lastDelta) || 0, 0);
            }

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
            if (session.roomId && session.roomCallId && session.teacherId) {
              const roomCallStudentSessions = await callSession
                .find(
                  {
                    roomId: session.roomId,
                    roomCallId: session.roomCallId,
                    teacherId: session.teacherId,
                    studentId: { $exists: true, $ne: null },
                  },
                  { session: mongoSession, projection: { studentId: 1 } }
                )
                .toArray();
              const roomCallStudentCount = new Set(roomCallStudentSessions.map((item) => item.studentId)).size;
              creditRate = roomCallStudentCount > 1 ? STUDY_ROOM_TEACHER_CREDIT_RATE : 1;
            }
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


    app.post("/end-call-old-disabled", async (req, res) => {
      return res.status(410).json({ success: false, message: "This endpoint is disabled." });
  try {
    const { sessionId } = req.body;
    const endTime = Date.now();

    const callSession = databaseinmongo.collection("callSession");

    // Find session by sessionId
    const session = await callSession.findOne({ sessionId });

    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }

    // Check if session already ended
    if (session.endTime) {
      return res.status(200).json({ 
        success: true, 
        message: "Call already ended", 
        pointsGiven: session.teacherPointsAdded || session.callPoints || 0 
      });
    }

    // Calculate duration
    const seconds = Math.floor((endTime - session.startTime) / 1000);

    // Determine call points
    let callPoints = 0;
    if (seconds >= 40 && seconds < 180) callPoints = 2;
    else if (seconds >= 180 && seconds < 300) callPoints = 3;
    else if (seconds >= 300 && seconds < 600) callPoints = 5;
    else if (seconds >= 600 && seconds < 900) callPoints = 8;
    else if (seconds >= 900 && seconds < 1200) callPoints = 12;
    else if (seconds >= 1200 && seconds < 1500) callPoints = 15;
    else if (seconds >= 1500) callPoints = 18;
    const generalCallPoints = callPoints;

    // Update session with end data once. If two clients end together, only one should process credits/points.
    const endSessionResult = await callSession.updateOne(
      { sessionId, endTime: { $exists: false } },
      {
        $set: {
          endTime,
          seconds,
          callPoints,
          endedAt: new Date(endTime),
        },
      }
    );

    if (endSessionResult.modifiedCount === 0) {
      const endedSession = await callSession.findOne({ sessionId });
      return res.status(200).json({
        success: true,
        message: "Call already ended",
        pointsGiven: endedSession?.teacherPointsAdded || endedSession?.callPoints || 0,
      });
    }

        // Update teacher points in MongoDB
    // ✅ Update teacher points atomically
      let teacherPointsToAdd = generalCallPoints;

      if (session.roomId && session.roomCallId && session.teacherId) {
        const callRoomAwards = databaseinmongo.collection("callRoomAwards");
        const groupSessions = await callSession
          .find({
            roomId: session.roomId,
            roomCallId: session.roomCallId,
            teacherId: session.teacherId,
            endTime: { $exists: true },
          })
          .toArray();
        const studentCount = new Set(groupSessions.map((item) => item.studentId).filter(Boolean)).size;
        const groupGeneralPoints = Math.max(...groupSessions.map((item) => Number(item.callPoints) || 0), generalCallPoints);
        const targetTeacherPoints = studentCount > 1
          ? Math.ceil(STUDY_ROOM_TEACHER_POINT_RATE * studentCount * groupGeneralPoints)
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
                lastDelta: {
                  $subtract: ["$awardedPoints", "$previousAwardedPoints"],
                },
                roomId: session.roomId,
                roomCallId: session.roomCallId,
                teacherId: session.teacherId,
              },
            },
          ],
          { upsert: true, returnDocument: "after" }
        );

        teacherPointsToAdd = Math.max(Number(awardResult?.lastDelta) || 0, 0);
      }

      if (teacherPointsToAdd > 0 && session.teacherId) {
        await userCollection.updateOne(
          { _id: session.teacherId },
          { $inc: { points: teacherPointsToAdd } }
        );

        await callSession.updateOne(
          { sessionId },
          { $set: { teacherPointsAdded: teacherPointsToAdd } }
        );
      }
      console.log("student id found!", session.studentId);

      // ✅ Deduct student credits atomically (avoid going below 0)
      if (session.studentId) {

        const creditRate = Math.min(Math.max(Number(session.creditRate) || 1, 0.1), 1);
        const baseCreditToDeduct = Math.floor(seconds / 10); // 1 credit per 10 seconds
        const creditToDeduct = Math.ceil(baseCreditToDeduct * creditRate);
      console.log("credit counted: ", creditToDeduct);

        if (creditToDeduct > 0) {

          const studentPackage = await activepackages.findOne({ uid: session.studentId });
          if (studentPackage) {
              console.log("student package found: ", studentPackage.uid);

            const currentCredit = studentPackage.credit || 0;
            const newCredit = Math.max(currentCredit - creditToDeduct, 0);
            console.log("new credit: ", newCredit);

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
              ]
            );
          }
        }
      }

    return res.status(200).json({ success: true, pointsGiven: teacherPointsToAdd, generalCallPoints });
  } catch (err) {
    console.error("Error in /end-call:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});







    //sending message
    app.post('/sendMessage', async (req, res) => {
      const chatCollection = databaseinmongo.collection("chatCollection");
      const chatDB = databaseinmongo.collection("chatDB");

      try {
          const { chatId, senderId, text, imageUrl, audioUrl, fileUrl, fileName, fileType, fileSize, receiverId, receiverIds, roomId } = req.body;
          const messageReceiverIds = Array.isArray(receiverIds) && receiverIds.length
            ? receiverIds
            : (receiverId ? [receiverId] : []);

          if (!chatId || !senderId || messageReceiverIds.length === 0) {
              return res.status(400).json({ error: 'Missing required fields.' });
          }

          if (roomId) {
              const room = await studyRooms.findOne({ _id: new ObjectId(roomId) });
              const isActiveStudentMember = room && (room.memberIds || []).includes(senderId) && getRoomMembership(room, senderId).isActive;
              const isAssignedRoomTeacher = room && (room.teacherSessions || []).some((session) => (
                  session.teacherId === senderId && session.chatId === chatId
              ));

              if (!room || (!isActiveStudentMember && !isAssignedRoomTeacher)) {
                  return res.status(403).json({ error: 'Renew this room membership before sending messages.' });
              }
          }

          if (fileUrl) {
              const allowedFileTypes = ['pdf', 'docx', 'pptx'];
              const normalizedFileType = String(fileType || '').toLowerCase();
              const fileNameExtension = String(fileName || '').split('.').pop().toLowerCase();

              if (!allowedFileTypes.includes(normalizedFileType) || normalizedFileType !== fileNameExtension) {
                  return res.status(400).json({ error: 'Only PDF, DOCX, or PPTX files are supported.' });
              }

              if (Number(fileSize) > 1024 * 1024) {
                  return res.status(400).json({ error: 'File size should not exceed 1MB.' });
              }
          }

          const message = {
              senderId,
              ...(text && { text }),
              createdAt: new Date(),
              ...(imageUrl && { imageUrl }),
              ...(audioUrl && { audioUrl }),
              ...(fileUrl && { fileUrl }),
              ...(fileName && { fileName }),
              ...(fileType && { fileType }),
              ...(fileSize && { fileSize }),
              lastMessageFeedback: null,
          };
  
          // Add message to chatDB collection
          const result = await chatDB.updateOne(
              { _id: new ObjectId(chatId) },
              { $push: { messages: message } }
          );
  
          if (result.modifiedCount === 0) {
              return res.status(404).json({ error: 'Chat not found.' });
          }
  
          // Update last message details for both users in chatCollection
          const userIds = [...new Set([senderId, ...messageReceiverIds])];
  
          await Promise.all(
              userIds.map(async (id) => {
                  await chatCollection.updateOne(
                      { _id: id, 'chats.chatId': chatId },
                      {
                          $set: {
                              'chats.$.lastMessage': text || (audioUrl ? '🎙️ Voice' : (fileUrl ? '📎 File' : '📷 Image')),
                              'chats.$.isSeen': id === senderId,
                              'chats.$.lastMessageFeedback': null,
                              'chats.$.updatedAt': Date.now(),
                          },
                      }
                  );
              })
          );
  
          // Fetch the updated chat document
          const updatedChat = await chatDB.findOne({ _id: new ObjectId(chatId) });
  
          // Emit the updated chat to all users in the chat room
          io.to(chatId).emit('chatUpdate', updatedChat);
          


          // Fetch the updated chat list for both users and populate `userss`
        const updatedChatLists = await Promise.all(
          userIds.map(async (id) => {
              const userChatDoc = await chatCollection.findOne({ _id: id });
              if (!userChatDoc) return [];

              const chatInfos = userChatDoc.chats || [];
              const populatedChats = await Promise.all(
                  chatInfos.map(async (item) => {
                      const userDoc = await userCollection.findOne({ uid: item.receiverId });
                      const userss = userDoc || {};
                      return { ...item, userss };
                  })
              );

              return populatedChats;
          })
      );
      // Emit the updated chat list to both users
      userIds.forEach((id, index) => {
          const chatList = updatedChatLists[index];
          const unseenCount = chatList.filter(chat => !chat.isSeen).length;
          io.to(id).emit('chatListUpdate', { chatList, unseenCount });
      });

          
  
          res.json({ success: true, message });
      } catch (error) {
          console.error('Error sending message:', error);
          res.status(500).json({ error: 'Internal server error.' });
      }
  });

    //mark message as seen
    app.put('/mark-chat-as-seen', async (req, res) => {
      const { userId, chatId } = req.body;

      const chatCollection = databaseinmongo.collection("chatCollection");
  
      if (!userId || !chatId) {
          return res.status(400).json({ message: 'userId and chatId are required' });
      }
  
      try {
          // Find the user's chat document in MongoDB
          const userChatDoc = await chatCollection.findOne({ _id: userId });
  
          if (!userChatDoc) {
              return res.status(404).json({ message: 'User chat document not found' });
          }
  
          // Find the chat to mark as seen
          const chatIndex = userChatDoc.chats.findIndex((item) => item.chatId === chatId);
  
          if (chatIndex === -1) {
              return res.status(404).json({ message: 'Chat not found' });
          }
  
          // Update the isSeen status
          userChatDoc.chats[chatIndex].isSeen = true;
  
          // Update the chat document in MongoDB
          await chatCollection.updateOne(
              {_id: userId },
              { $set: { chats: userChatDoc.chats } }
          );
          return res.status(200).json({ message: 'Chat marked as seen successfully' });
      } catch (err) {
          console.error('Error marking chat as seen:', err);
          return res.status(500).json({ message: 'Internal server error' });
      }
  });

  app.put('/update-feedback', async (req, res) => {
    const {teacherId, chatId, index, isLike } = req.body;
    if (!index || !chatId) {
        return;
    }

    try {
      if (!teacherId) {
      return res.status(400).json({ error: "teacherId required" });
    }

      // Find teacher
      const teacher = await userCollection.findOne({ uid: teacherId }); 
      if (!teacher) {
        return res.status(404).json({ error: "Teacher not found" });
      }

      const { points = 0, rating = 0 } = teacher;

      // Calculate new values
      const newPoints = isLike && chatId ? points + 2 : points - 2;
      const newRating = isLike ? (5 - rating) / 10 : -((5 - rating) / 10);

      // Update in MongoDB
      const updateResult = await userCollection.updateOne(
        { uid: teacherId },
        {
          $set: { points: newPoints },
          $inc: { rating: newRating },
        }
      );

        const chatDB = databaseinmongo.collection('chatDB');

        const chat = await chatDB.findOne({ _id: new ObjectId(chatId) });

        if (!chat) {
            return;
        }

        let messages = chat.messages || [];

        if (messages[index]) {
            messages[index] = {
                ...messages[index],
                lastMessageFeedback: isLike ? 'liked' : 'disliked',
            };

            await chatDB.updateOne(
                { _id: new ObjectId(chatId) },
                { $set: { messages } }
            );

            const updatedChat = await chatDB.findOne({ _id: new ObjectId(chatId) });
            io.to(chatId).emit('chatUpdate', updatedChat);

            return;
        } else {
            return;
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal server error.');
    }
});


    io.on('connection', (socket) => {
      console.log('A user connected:', socket.id);
      const chatDB = databaseinmongo.collection("chatDB");

    //get data of user typing
    socket.on('typing', (chatId) => {
    // Broadcast to everyone in the same chat room except sender
    console.log(socket.id);
    
      socket.to(chatId).emit('userTyping', { userId: socket.id });
    });

    socket.on('stopTyping', (chatId) => {
        socket.to(chatId).emit('userStopTyping', { userId: socket.id });
    });


      socket.on('joinChatRoom', async (chatId) => {
        const chatDB = databaseinmongo.collection("chatDB");

        socket.join(chatId);
        console.log(`User joined chat room: ${chatId}`);

        try {
            // Fetch the chat document from MongoDB
            const chatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });

            

            if (chatDoc) {
                // Emit the initial chat data to the user
                socket.emit('chatUpdate', chatDoc);

                // Calculate and emit the last message timestamp
                const lastMessageIndex = chatDoc.messages.length - 1;
                if (lastMessageIndex >= 0) {
                    const createdAtValue = chatDoc.messages[lastMessageIndex].createdAt;
                    const mntsAgoValue = Math.floor((Date.now() - createdAtValue) / 60000);
                    socket.emit('lastMessageTimestamp', mntsAgoValue);
                }
            } else {
                socket.emit('chatError', { message: 'Chat not found' });
            }
        } catch (err) {
            console.error('Error fetching chat:', err);
            socket.emit('chatError', { message: 'Failed to fetch chat' });
        }
    });

  
      // Listen for user joining (e.g., when a user logs in)
      socket.on('joinRoom', async (userId) => {
          socket.join(userId);
          console.log(`User ${userId} joined the room.`);
  
          // Fetch and send the chat list for the user
          try {
              const chatCollection = databaseinmongo.collection('chatCollection');
              const userChatDoc = await chatCollection.findOne({ _id: userId });
  
              if (userChatDoc) {
                  const chatInfos = userChatDoc.chats || [];
                  let totalUnseen = 0;
                  const promises = chatInfos.map(async (item) => {
                    
                      const userDoc = await userCollection.findOne({ uid: item.receiverId });
                      const userss = userDoc || {};
  
                      // Count unseen messages
                      if (item.isSeen === false) {
                          totalUnseen++;
                      }
  
                      return { ...item, userss };
                  });
  
                  const chatData = await Promise.all(promises);
                  const sortedChatData = chatData.sort((a, b) => b.updatedAt - a.updatedAt);
  
                  // Emit the chat list to the user
                  socket.emit('chatListUpdate', { chatList: sortedChatData, unseenCount: totalUnseen });
              }
          } catch (err) {
              console.error('Error fetching chat list:', err);
              socket.emit('chatListError', { message: 'Failed to fetch chat list' });
          }
      });

      socket.on('register-user', ({ userId }) => {
        socket.join(userId);
        console.log(`✅ ${userId} joined room`);
      });

      
  });


  //payment
//
// ================================
// PAY POPERL (NEW PACKAGE)
// ================================
//

app.post('/pay-poperl', async (req, res) => {

  const {
    amount,
    order_id,
    customer_name,
    customer_phone,
    uid,
    displayName,
    packageName,
    price,
    durationDays,
    customer_city,
    currency,
    customer_address,
    credit,
    category,
    type,
    isUnlimited
  } = req.body;

  if (amount < 10) {
  // Calculate subscription dates
  const startDate = new Date();

  // Make a copy of startDate
  const expiryDate = new Date(startDate);

  expiryDate.setHours(
    expiryDate.getHours() + Number(durationDays)
  );

  await activepackages.updateOne(
    { uid }, // match by uid to prevent duplicates
    {
      $set: {
        uid,
        packageName,
        startDate: startDate.toISOString(),
        expiryDate: expiryDate.toISOString(),
        credit: Number(credit),
        totalCredit: credit,
        isActive: true,
        paymentStatus: "approved",
        purchasedAt: new Date(),
        category,
        type,
        isUnlimited: Boolean(isUnlimited),
        price: Number(price),
      },
    },
    {
      upsert: true, // insert if not exists
    }
  );

  res.json({
    checkout_url: "poperl://webview",
  });

  return;
}

  const metadata = {
  customOrderId: order_id,
  paymentType: "new-package",
  uid,
  displayName,
  packageName,
  price,
  durationDays,
  credit,
  category,
  type,
  isUnlimited: Boolean(isUnlimited)
};

  shurjopay.makePayment({

    amount,
    order_id,
    customer_name,
    customer_phone,
    client_ip: req.ip || "127.0.0.1",
    customer_city,
    currency,
    customer_address,
    value1: JSON.stringify(metadata)

  },

  async (resp) => {

    console.log(resp);

    res.json({
      checkout_url: resp.checkout_url
    });

  },

  (err) => {

    console.error("Payment error:", err);

    res.status(500).json({
      error: err.message
    });

  });

});

//
// ================================
// EXTEND PACKAGE
// ================================
//

app.post('/extend-package', async (req, res) => {

  const {
    amount,
    order_id,
    customer_name,
    customer_phone,
    uid,
    displayName,
    packageName,
    price,
    durationDays,
    customer_city,
    currency,
    customer_address,
    credit,
    category,
    type,
    isUnlimited
  } = req.body;

  //
  // FREE / INSTANT EXTENSION
  //

  if (Number(amount) < 10) {

    try {

      const existingPackage =
        await activepackages.findOne({ uid });

      if (!existingPackage) {

        return res.status(404).json({
          error: "No active package found"
        });
      }

      const now = new Date();

      let expiryDate;

      if (
        existingPackage.expiryDate &&
        new Date(existingPackage.expiryDate) > now
      ) {

        expiryDate = new Date(
          existingPackage.expiryDate
        );

      } else {

        expiryDate = new Date(now);
      }

      // Extend duration
      expiryDate.setHours(
        expiryDate.getHours() +
        Number(durationDays)
      );

      // Add credits
      const updatedCredit =
        Number(existingPackage.credit || 0) +
        Number(credit);

      const updatedTotalCredit =
        Number(existingPackage.totalCredit || 0) +
        Number(credit);

      // Update active package
      await activepackages.updateOne(

        { uid },

        {
          $set: {
            expiryDate: expiryDate.toISOString(),
            credit: updatedCredit,
            totalCredit: updatedTotalCredit,
            price: (existingPackage.price || 0) + Number(price),
            isUnlimited: Boolean(isUnlimited) || Boolean(existingPackage.isUnlimited),
            updatedAt: new Date()
          }
        }

      );

      // Insert history
      await subscriptions.insertOne({

        uid,
        name: displayName,
        packageName,
        credit: Number(credit),
        price: Number(price),
        durationDays: Number(durationDays),
        category,

        type: "extension",

        paymentStatus: "free-extension",

        orderId: null,

        internalReference:
          `FREE_EXT_${Date.now()}`,

        createdAt: new Date()

      });

      return res.json({
        success: true,
        instantExtension: true,
        checkout_url: 'poperl://webview'
      });

    } catch (error) {

      console.error(error);

      return res.status(500).json({
        error: "Extension failed"
      });
    }
  }

  //
  // PAID EXTENSION
  //

  const metadata = {
    paymentType: "extension",
    uid,
    displayName,
    packageName,
    price,
    durationDays,
    credit,
    category,
    type,
    isUnlimited: Boolean(isUnlimited)
  };

  shurjopay.makePayment({

    amount,
    order_id,
    customer_name,
    customer_phone,
    client_ip: req.ip || "127.0.0.1",
    customer_city,
    currency,
    customer_address,
    value1: JSON.stringify(metadata)

  },

  async (resp) => {

    console.log(resp);

    res.json({
      checkout_url: resp.checkout_url
    });

  },

  (err) => {

    console.error("Payment error:", err);

    res.status(500).json({
      error: err.message
    });

  });

});

//
// ================================
// IPN
// ================================
//

app.get('/ipn', async (req, res) => {

  const { order_id } = req.query;

  if (!order_id) {

    return res.status(400).json({
      error: "Missing order_id"
    });
  }

  try {

    console.log(
      "🔍 Verifying payment:",
      order_id
    );

    shurjopay.verifyPayment(

      order_id,

      async (result) => {

        if (!result || result.length === 0) {

          return res.status(200).json({
            message: "Payment not verified"
          });
        }

        const data = result[0];

        console.log(data);

        //
        // SUCCESS
        //

        if (
          data.sp_code === '1000' &&
          data.sp_message === 'Success'
        ) {

          const metadata =
            JSON.parse(data.value1);

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
            isUnlimited
          } = metadata;

          //
          // DUPLICATE IPN PROTECTION
          //

          const existingOrder =
            await subscriptions.findOne({
              orderId: order_id
            });

          if (existingOrder) {

            return res.status(200).json({
              message: "Already processed"
            });
          }

          //
          // ==================================
          // NEW PACKAGE PURCHASE
          // ==================================
          //

          if (paymentType === "new-package") {

            const startDate = new Date();

            const expiryDate =
              new Date(startDate);

            expiryDate.setHours(
              expiryDate.getHours() +
              Number(durationDays)
            );

            await activepackages.updateOne(

              { uid },

              {
                $set: {

                  uid,
                  packageName,

                  startDate:
                    startDate.toISOString(),

                  expiryDate:
                    expiryDate.toISOString(),

                  credit: Number(credit),

                  totalCredit:
                    Number(credit),

                  isActive: true,

                  paymentStatus: "approved",

                  purchasedAt: new Date(),

                  category,

                  type,

                  isUnlimited: Boolean(isUnlimited),

                  price: Number(price)

                }
              },

              { upsert: true }

            );

          }

          //
          // ==================================
          // PACKAGE EXTENSION
          // ==================================
          //

          else if (
            paymentType === "extension"
          ) {

            const existingPackage =
              await activepackages.findOne({
                uid
              });

            if (!existingPackage) {

              return res.status(404).json({
                error: "Package not found"
              });
            }

            const now = new Date();

            let expiryDate;

            if (
              existingPackage.expiryDate &&
              new Date(
                existingPackage.expiryDate
              ) > now
            ) {

              expiryDate = new Date(
                existingPackage.expiryDate
              );

            } else {

              expiryDate = new Date(now);
            }

            // Extend duration
            expiryDate.setHours(
              expiryDate.getHours() +
              Number(durationDays)
            );

            // Add credits
            const updatedCredit =
              Number(
                existingPackage.credit || 0
              ) +
              Number(credit);

            const updatedTotalCredit =
              Number(
                existingPackage.totalCredit || 0
              ) +
              Number(credit);

            // Update package
            await activepackages.updateOne(

              { uid },

              {
                $set: {

                  expiryDate:
                    expiryDate.toISOString(),

                  credit: updatedCredit,

                  totalCredit:
                    updatedTotalCredit,

                  price: (existingPackage.price || 0) + Number(price),

                  isUnlimited: Boolean(isUnlimited) || Boolean(existingPackage.isUnlimited),

                  updatedAt: new Date()

                }
              }

            );

          }

          //
          // ==================================
          // SUBSCRIPTION HISTORY
          // ==================================
          //

          await subscriptions.insertOne({

            uid,

            name: displayName,

            packageName,

            credit: Number(credit),

            price: Number(price),

            durationDays:
              Number(durationDays),

            category,

            orderId: order_id,

            type: paymentType,

            paymentStatus: "approved",

            createdAt: new Date()

          });

          if (
            paymentType === "new-package" &&
            Number(price) > 0
          ) {
            try {
              const referralResult = await awardReferralCredit(uid, order_id);
              if (referralResult.awarded) {
                console.log(`Referral reward awarded to UID: ${referralResult.referrerUid}`);
              }
            } catch (referralError) {
              console.error("Referral reward failed:", referralError);
            }
          }

          console.log(
            `✅ ${paymentType} completed for UID: ${uid}`
          );

          return res.status(200).json({
            message: "Success"
          });

        }

        //
        // FAILED PAYMENT
        //

        else {

          console.warn(
            `⚠️ Payment failed for ${order_id}`
          );

          return res.status(200).json({
            message: "Payment failed"
          });
        }

      },

      (error) => {

        console.error(
          "Verification error:",
          error
        );

        return res.status(500).json({
          error: "Verification failed"
        });

      }

    );

  } catch (error) {

    console.error(
      "❌ IPN error:",
      error
    );

    return res.status(500).json({
      error: "Internal server error"
    });

  }

});






// ================================
// ADMIN: ADD SUBSCRIPTION TO USER
// ================================

app.post('/admin-add-subscription', async (req, res) => {
  const { email, durationHours, credit, amountReceived } = req.body;

  if (!email || !durationHours || credit === undefined || amountReceived === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const user = await userCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const uid = user.uid || user._id?.toString();
    const displayName = user.displayName || user.name || email;

    const existingPackage = await activepackages.findOne({ uid });
    const now = new Date();
    let type;

    if (existingPackage && existingPackage.expiryDate && new Date(existingPackage.expiryDate) > now) {
      // Active package exists — extend it
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
            updatedAt: new Date()
          }
        }
      );

      type = "admin-extension";
    } else {
      // No active package or expired — create new
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
            category: "custom",
            price: Number(amountReceived),
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      type = "admin-new";
    }

    await subscriptions.insertOne({
      uid,
      name: displayName,
      email,
      packageName: "Admin Custom",
      credit: Number(credit),
      price: Number(amountReceived),
      durationDays: Number(durationHours),
      category: "custom",
      type,
      paymentStatus: "admin-added",
      orderId: null,
      internalReference: `ADMIN_${Date.now()}`,
      createdAt: new Date()
    });

    return res.json({ success: true, type, uid, displayName });

  } catch (error) {
    console.error("admin-add-subscription error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/api/getUserRole/:userId', async (req, res) => {
  const userId = req.params.userId;
  
  try {
    // Try to find the user by _id
    const userDoc = await userCollection.findOne({ uid: userId });
    
    if (userDoc) {
      res.json({ userRole: userDoc.role, userDoc });
    } else {
      res.status(404).json({ message: 'User not found or not a student' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

//check subscription
// GET /api/subscription/:userId
app.get("/api/subscription/:userId", async (req, res) => {
  const { userId } = req.params;  

  try {
    
    const sub = await activepackages.findOne({ uid: userId });
    

    if (!sub) {
      return res.json({subscription: null });
    }
    
    const isValid =
      new Date(sub.expiryDate) > new Date() && sub.credit > 0 && sub.isActive === true;

    res.json({
      isSubscribed: isValid,
      subscription: sub,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});


//change points and credit
app.post("/api/messages/credit-point", async (req, res) => {
  try {
    const { userId, role, creditToDeduct, pointsToAdd } = req.body;
    const normalizedCreditToDeduct = Math.ceil(Number(creditToDeduct) || 0);

    if (!userId || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (role === "teacher" && pointsToAdd) {
      // Teacher gets points

      if (pointsToAdd > 0) {
        await userCollection.updateOne(
          { uid: userId, role: "teacher" },
          { $inc: { points: pointsToAdd } }
        );
      }
    } else if (role === "student") {
      // Student loses credit
      

      if (normalizedCreditToDeduct > 0 && userId) {
        await activepackages.updateOne(
          { uid: userId },
          { $inc: { credit: -normalizedCreditToDeduct } }
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error in process route:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/sub-check/:callerId", async (req, res) => {
  try {
    const { callerId } = req.params;

    // 🔹 if you store callerId as uid instead of _id, change query to { uid: callerId }
    const subscription = await activepackages.findOne({
      uid: callerId,
    });

    if (!subscription) {
      return res.json({ isValid: false, credit: 0 });
    }    

    const now = new Date();
    const expiryDate = new Date(subscription.expiryDate);

    const isValid =
      subscription?.isActive === true &&
      expiryDate > now &&
      subscription.credit > 0;

    res.json({ isValid, credit: subscription.credit });
  } catch (err) {
    console.error("Error fetching subscription:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});













    





  

    app.post("/closeCalculation", async (req, res) => {
  try {
    // 1. Get all teachers from Firestore
    const teachersSnapshot = await userCollection.where("role", "==", "teacher").get();

    if (teachersSnapshot.empty) {
      return res.status(404).json({
        success: false,
        message: "No teachers found."
      });
    }

    // 2. Calculate total revenue from MongoDB
    const totalRevenueResult = await subscriptions.aggregate([
      { $group: { _id: null, totalRevenue: { $sum: "$price" } } }
    ]).toArray();
    
    const totalRevenue = totalRevenueResult[0]?.totalRevenue || 0;

    let totalPoints = 0;
    let teacherEarnings = [];

    // 3. Calculate total points
    teachersSnapshot.forEach(doc => {
      const points = doc.data().points || 0;
      totalPoints += points;
    });

    // 4. Compute income for each teacher
    teachersSnapshot.forEach(doc => {
      const teacher = doc.data();
      const points = teacher.points || 0;
      const revenuePercent = teacher.revenuePercent || 0;

      const income = totalPoints > 0
        ? (points / totalPoints) * totalRevenue * revenuePercent
        : 0;

      teacherEarnings.push({
        uid: teacher.uid,
        name: teacher.displayName,
        whatsapp: teacher.whatsapp,
        points: points,
        income: Math.floor(income), // Round down to integer
        paid: false
      });
    });

    // 5. Save revenue history to MongoDB
    await databaseinmongo.collection("revenueHistory").insertOne({
      totalPoints,
      totalRevenue,
      createdAt: new Date(),
      enrols: await databaseinmongo.collection("subscriptions").countDocuments()
    });

    // 6. Save salary breakdown to MongoDB
    await databaseinmongo.collection("salaryHistory").insertMany(teacherEarnings);

    res.json({
      success: true,
      message: "Calculation completed and salary data stored successfully.",
      totalRevenue,
      totalPoints,
      teachersProcessed: teacherEarnings.length
    });

  } catch (err) {
    console.error("Error in /closeCalculation:", err);
    res.status(500).json({
      success: false,
      message: "Server error during calculation process."
    });
  }
});


const calculatePlatformMoney = async () => {
  
  

  // 1️⃣ Total subscription money (only paid subscriptions)
  const totalMoneyAgg = await subscriptions.aggregate([
    { $group: { _id: null, totalMoney: { $sum: "$price" } } }
  ]).toArray();
  const totalMoney = totalMoneyAgg[0]?.totalMoney || 0;

  // 2️⃣ Total available credit (only paid + active subscriptions)
  const now = new Date();

const availableCreditWorthAgg = await activepackages.aggregate([
  {
    $addFields: {
      expiryDateObj: { $toDate: "$expiryDate" } // convert string to Date
    }
  },
  { 
    $match: { 
      expiryDateObj: { $gt: now } // only not expired
    } 
  },
  { 
    $project: { 
      creditWorth: { $multiply: ["$credit", { $divide: ["$price", "$totalCredit"] }] } 
    } 
  },
  { 
    $group: { 
      _id: null, 
      totalCreditWorth: { $sum: "$creditWorth" } 
    } 
  }
]).toArray();


const totalAvailableCreditWorth = availableCreditWorthAgg[0]?.totalCreditWorth || 0;


  // 3️⃣ Total withdrawals (only paid)
  const totalWithdrawalsAgg = await withdrawals.aggregate([
    { $match: { paid: true } },
    { $group: { _id: null, totalWithdrawals: { $sum: "$amount" } } }
  ]).toArray();
  const totalWithdrawals = totalWithdrawalsAgg[0]?.totalWithdrawals || 0;

  // 4️⃣ Money available in the platform
  const moneyInPlatform = totalMoney - totalAvailableCreditWorth - totalWithdrawals;

  const totalTeacherPoints = await calculateTotalTeacherPoints();



  const summaryCollection = databaseinmongo.collection("platform_money_summary");

// Define a fixed _id for the single document
const summaryId = "current_platform_money";

const summaryDoc = {
  _id: summaryId,                     // ensures only one document exists
  totalMoney,
  totalAvailableCreditWorth,
  totalWithdrawals,
  moneyInPlatform,
  totalTeacherPoints,
  updatedAt: new Date()               // timestamp of latest calculation
};

// Upsert: create if not exists, otherwise update
await summaryCollection.updateOne(
  { _id: summaryId },
  { $set: summaryDoc },
  { upsert: true }
);




  return {
    totalMoney,
    totalAvailableCreditWorth,
    totalWithdrawals,
    moneyInPlatform,
    totalTeacherPoints
  };
};


async function calculateTotalTeacherPoints() {
  const result = await userCollection.aggregate([
    { $match: { role: "teacher", points: { $exists: true } } }, // only teachers with points
    { $group: { _id: null, totalPoints: { $sum: "$points" } } } // sum points
  ]).toArray();

  return result[0]?.totalPoints || 0;
}


// GET endpoint to compute pointValue
app.get('/point-value', async (req, res) => {
  const summaryId = "current_platform_money"; 

  await calculatePlatformMoney()
  .then(console.log)
  .catch(console.error);
  
  

  try {
    const summaryCollection = databaseinmongo.collection("platform_money_summary");

    // Fetch the document by ID
    const summaryDoc = await summaryCollection.findOne({ _id: summaryId });

    if (!summaryDoc) {
      return res.status(404).json({ error: "Summary document not found." });
    }

    const { moneyInPlatform, totalTeacherPoints } = summaryDoc;

    // Prevent division by zero
    if (!totalTeacherPoints || totalTeacherPoints === 0) {
      return res.status(400).json({ error: "totalTeacherPoints is zero or missing." });
    }

    // Calculate point value
    const pointValue = moneyInPlatform / totalTeacherPoints;

    // Send result
    res.json({ pointValue });

  } catch (error) {
    console.error("Error fetching point value:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});


// Example usage:







    app.post("/subscriptions", async (req, res) => {
      try{
        const result = await subscriptions.insertOne(req.body);
      }catch(err){
        console.log(err);
      }
    })

    app.get("/salaryData", async(req, res) => {
      try{
        const salaryCollection = databaseinmongo.collection("salaryHistory");
        const result = await salaryCollection.find().toArray()
        
        res.status(200).json({success: true, data: result})
      }catch(err){
        console.log(err);
        
      }
      
    })

    app.get("/historyData", async (req, res) => {
      try{

        const revenueHistory = databaseinmongo.collection("revenueHistory");
        const result = await revenueHistory.find().toArray()
        res.status(200).json({success: true, data: result})

      }catch(error){
        console.log(error);
        
      }
    })

    app.patch("/paySalary/:id", async (req, res) => {
      try{
        const id = req.params.id;
      const salaryCollection = databaseinmongo.collection("salaryHistory");
      await salaryCollection.updateOne({uid: id},
        {
          $set: {
            paid: true
          }
        });
        res.status(200).json({success: true})
      } catch(err){
        console.log(err);
      }
    })

    app.post("/complain", async (req, res) => {
      try{
        const complains = databaseinmongo.collection("complains");
        const result = await complains.insertOne(req.body)
        res.status(200).json({success: true})
      } catch(err){
        console.log(err);
        
      }
    })

    app.get("/complain/:id", async (req, res) => {
      try{
        const uid = req.params.id;
        const complains = databaseinmongo.collection("complains");
        const result = await complains.find({uid: uid}).toArray()
        res.status(200).json({success: true, data: result})
      } catch(err){
        console.log(err);
      }
    })

    app.get("/complain", async (req, res) => {
      try{
        const complains = databaseinmongo.collection("complains");
        const result = await complains.find().toArray()
        res.status(200).json({success: true, data: result})
      } catch(err){
        console.log(err);
      }
    })

    app.delete("/complain/:id", async (req, res) => {
      try{
        const _id = req.params.id;
        const complains = databaseinmongo.collection("complains");
        const result = await complains.deleteOne({_id: new ObjectId(_id)})
        res.status(200).json({success: true})
      } catch(err){
        console.log(err);
      }
    })


    //packages

    app.post("/pack", async (req, res) => {
      try{
        const packages = databaseinmongo.collection("packages");
        const result = await packages.insertOne(req.body);
        res.status(200).json({success: true})
      } catch(err){
        console.log(err);
      }
    })

    app.get("/pack", async (req, res) => {
      try{
        const packages = databaseinmongo.collection("packages");
        const result = await packages.find().toArray();
        res.status(200).json({success: true, data: result})
      } catch(err){
        console.log(err);
      }
    })

    app.post("/credit-price", async (req, res) => {
      try{
        const { category, type, pricePerCredit } = req.body;
        const creditPrices = databaseinmongo.collection("creditPrices");
        await creditPrices.updateOne(
          { category, type },
          { $set: { category, type, pricePerCredit: Number(pricePerCredit), updatedAt: new Date() } },
          { upsert: true }
        );
        res.status(200).json({ success: true });
      } catch(err){
        console.log(err);
        res.status(500).json({ success: false });
      }
    })

    app.get("/credit-prices", async (req, res) => {
      try{
        const creditPrices = databaseinmongo.collection("creditPrices");
        const result = await creditPrices.find().toArray();
        res.status(200).json({ success: true, data: result });
      } catch(err){
        console.log(err);
        res.status(500).json({ success: false, data: [] });
      }
    })

    app.delete("/pack/:id", async (req, res) => {
      try{
        const _id = req.params.id;
        const packages = databaseinmongo.collection("packages");
        const result = await packages.deleteOne({_id: new ObjectId(_id)});
        res.status(200).json({success: true})
      } catch(err){
        console.log(err);
      }
    })

    app.put("/pack/:id", async (req, res) => {
      try{
        const _id = req.params.id;
        const packages = databaseinmongo.collection("packages");
        const result = await packages.updateOne(
          {_id: new ObjectId(_id)},
          {
            $set: {
              price: req.body.price,
              credit: req.body.credit,
              name: req.body.name,
              type: req.body.type
            }
          }
        );
        res.status(200).json({success: true})
      } catch(err){
        console.log(err);
      }
    })


  } catch(err){
    console.log(err);
    
  }
}
run().catch(console.dir);





server.listen(port, () => {
  console.log("The Server Is running...")
  
});
