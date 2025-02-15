const express = require("express");
const app = express();
const cors =  require("cors");
const port = process.env.port || 5000;

require("dotenv").config();
const axios = require("axios");
app.use(cors());
app.use(express.json());

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
        console.log(uuid);
        
      

        res.status(200).json({token: response.data});
        
        
    } catch (error) {
        console.error("Error generating whiteboard token:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to generate whiteboard token" });
    }
});


//agora call token

app.post("/generate-token", (req, res) => {
  
  const {channelName, receiverID} = req.body;
  
  if(!channelName){    
    return res.status(400).json({ error: "Channel name is required" });
  }
  const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    const uid = receiverID;
    const token = RtcTokenBuilder.buildTokenWithUid(
        APP_ID,
        APP_CERTIFICATE,
        channelName,
        uid, // Auto-generate UID if not provided
        role,
        privilegeExpiredTs
    );
    
    

    res.json({ token, uid});
})



//getting firestore

const {database, admin} = require("./firebase.config");
const studentCollection = database.collection("studentCollection");
const teacherCollection = database.collection("teacherCollection");

const chatListCollection = database.collection("chatCollection");

app.post("/newStudent", async (req, res) => {
  try {
    const user = req.body;

    // Save user to the student collection
    const result = await studentCollection.doc(user?.uid).set(user);

    // Initialize an empty chat list for the user
    const result2 = await chatListCollection.doc(user.uid).set({ chats: [] });

    console.log(result, result2);

    // Send response with HTTP status 200 and response body
    res.status(200).send({ result, result2 });
  } catch (error) {
    console.error(error);

    // Handle errors and send appropriate error response
    res.status(500).send({ error: "An error occurred while processing the request." });
  }
});

app.post("/newTeacher", async (req, res) => {
  try {
    const user = req.body;

    // Add teacher data to the teacher collection
    const result = await teacherCollection.doc(user?.uid).set(user);

    // Initialize an empty chat list for the teacher
    const result2 = await chatListCollection.doc(user.uid).set({ chats: [] });

    // Log both results for debugging
    console.log(result, result2);

    // Send a success response
    res.status(200).send({ success: true, message: "Teacher added successfully." });
  } catch (error) {
    console.error(error);

    // Handle errors and send an appropriate response
    res.status(500).send({ success: false, error: "Failed to add a new teacher." });
  }
});


app.get("/teacherList", async (req, res) => {
  try {
    // Fetch approved teachers from the teacher collection
    const result = await teacherCollection.where('approved', "==", true).get();

    const teacherList = [];
    result.forEach(doc => {
      teacherList.push({ id: doc.id, ...doc.data() });
    });

    // Send the list of teachers as the response
    res.status(200).send({ success: true, teachers: teacherList });
  } catch (error) {
    console.error(error);

    // Handle errors and send an appropriate response
    res.status(500).send({ success: false, error: "Failed to retrieve the teacher list." });
  }
});




//setting notification token

app.post("/setTokenToProfile", async(req, res) => {
  const {token, uid} = req.body;

  if(!token || !uid) return;
  

  try {
    let userRef;

    // Check in studentCollection
    const studentQuery = await studentCollection.where("uid", "==", uid).get();
    if (!studentQuery.empty) {
      userRef = studentQuery.docs[0].ref;
    }

    // Check in teacherCollection if not found in studentCollection
    if (!userRef) {
      const teacherQuery = await teacherCollection.where("uid", "==", uid).get();
      if (!teacherQuery.empty) {
        userRef = teacherQuery.docs[0].ref;
      }
    }

    // If user found, update token
    if (userRef) {
      await userRef.update({ FCMToken: token });
    }


  } catch (error) {
    console.error("Error updating token:", error);
  }

})





// inbox message sending

app.post("/send-notification", async (req, res) => {
  const { nottificationToken, senderName, nottificationMessage } = req.body;

  if (!nottificationToken || !nottificationMessage || !senderName) {
    return res.status(400).json({ error: "Token or message was unavailable" });
  }

  const payload = {
    data: { // ✅ Corrected 'nottification' → 'notification'
      title: senderName,
      body: nottificationMessage
    },
    token: nottificationToken // ✅ Corrected 'nottificationToken' → 'token'
  };

  console.log(payload);

  try {
    await admin.messaging().send(payload);
    console.log("Notification sent successfully");
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending notification:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

app.post("/send-call-notification", async (req, res) => {
  
  const { nottificationToken, callerName, callerID } = req.body;
  console.log(nottificationToken, callerName, callerID);
  const callerId = callerID;


  if (!nottificationToken || !callerName || !callerID) {
    return res.status(400).json({ error: "Token or message was unavailable" });
  }

  const payload = {
    data: { 
      callType: "incoming",
      callerName,
      callerId
    },
    token: nottificationToken
  };

  console.log(payload);

  try {
    await admin.messaging().send(payload);
    console.log("Notification sent successfully");
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending notification:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});







app.listen(port, () => {
    console.log("The Server Is running...")
    
});