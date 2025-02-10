const express = require("express");
const app = express();
const cors =  require("cors");
const port = process.env.port || 5000;

require("dotenv").config();

app.use(cors());
app.use(express.json());

const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

//setting up agora access token
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;

app.post("/generate-token", (req, res) => {
  
  const {channelName, uid} = req.body;
  
  if(!channelName){    
    return res.status(400).json({ error: "Channel name is required" });
  }
  const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

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

const database = require("./firebase.config");
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




app.listen(port, () => {
    console.log("The Server Is running...")
    
});