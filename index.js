const express = require("express");
const app = express();
const cors =  require("cors");
const port = process.env.PORT || 5000;

require("dotenv").config();
const axios = require("axios");
app.use(cors());
app.use(express.json());


const http = require("http");

const {Server} = require("socket.io")

const server = http.createServer(app);


const io = require("socket.io")(server,{
  cors: {
    origin: "http://localhost:5173", // Allow frontend to connect (replace with frontend URL in production)
    methods: ["GET", "POST"]
  }
})













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
    notification: { // ✅ Corrected 'nottification' → 'notification'
      title: senderName,
      body: nottificationMessage
    },
    token: nottificationToken // ✅ Corrected 'nottificationToken' → 'token'
  };
  

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
  const callerId = callerID;


  if (!nottificationToken || !callerName || !callerId) {
    
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


  try {
    await admin.messaging().send(payload);
    console.log("Notification sent successfully");
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending notification:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
});



// admin

app.get("/teacherList", async (req, res) => {
  try {

    const {category, subject} = req.query;
    
    let query = teacherCollection.where("approved", "==", true);


    if(category) {
      query = query.where("category", "==", category);
    }

    if(subject){
      query = query.where("subjects", "array-contains", subject)
    }

    // Fetch approved teachers from the teacher collection
    const result = await query.get();
    

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




app.get("/disabledTeacherList", async (req, res) => {
  try {
    // Fetch approved teachers from the teacher collection
    const result = await teacherCollection.where('approved', "==", false).get();

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




app.put("/disableTeacher/:uid", async (req, res) => {
  const uid = req.params.uid;
  try{
    const teacher = teacherCollection.doc(uid);
    const result = await teacher.update({approved: false})
    res.status(200).json({result})
  } catch(err){
    console.log(err);
  }
})

app.put("/enableTeacher/:uid", async (req, res) => {
  const uid = req.params.uid;
  try{
    const teacher = teacherCollection.doc(uid);
    const result = await teacher.update({approved: true})
    res.status(200).json({result})
  } catch(err){
    console.log(err);
  }
})


// have to do something about permanently deleting data from firestore in future

app.delete("/deleteUser/:uid", async (req, res) => {
  const uid = req.params.uid;
  try{
    const teacher = teacherCollection.doc(uid);
    const result = await teacher.delete();
    res.status(200).json(result);
  } catch(err){
    res.status(400).json({err})
  }
})

app.put("/subjects", async(req, res) => {
  const subjects = req.body.subjects;
  const uid = req.body.uid;
  
  const teacher = teacherCollection.doc(uid);
  const result = await teacher.update({subjects: subjects})
  res.status(200).json({success: true})
})



//get profile information
app.get("/userProfile/:uid", async(req, res) => {
  const uid = req.params.uid;
  
  

  try {
    if(!uid) return;
    const teacherRef = teacherCollection.doc(uid);
    const doc = await teacherRef.get()
    console.log(uid);
    
    
    if(doc.exists){
      res.status(200).json({data: doc.data()})
    }
    else{
      console.log("Not doc found");
      
    }


  } catch (error) {
    res.status(400).json({err: error})
    console.error("Error updating token:", error);
  }

})


// reset user points

app.post("/resetPoints", async (req, res) => {
  try{
    const teachers = await teacherCollection.get();

    const batch = database.batch();

    teachers.forEach(doc => {
      batch.update(doc.ref, {points: 0});
    })

    await batch.commit();

    res.json({
      success: true,
      message: "Teacher Points reset success!"
    })


  } catch(error){
    console.error("Error resetting points:", error);
    res.status(500).json({ success: false, message: "Server error." });
  }
})




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

    //check if admin

    app.get("/isOwner/:uid", async (req, res) => {
      try{
        const uid = req.params.uid;
        console.log(uid);
        
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


    //userProfile Informations
    app.post("/newStudent", async (req, res) => {
      try {
        const user = req.body;
    
        const query = await studentCollection.where("email", "==", user.email).get();
    
        if(!query.empty){
          return res.status(200).json({success: true})
        }
    
        // Save user to the student collection
        const result = await studentCollection.doc(user?.uid).set(user);
    
        // Initialize an empty chat list for the user
        const result2 = await databaseinmongo.collection("chatCollection").insertOne({_id: user?.uid,  chats: []});
    
    
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
    
    
    
        const query = await teacherCollection.where("email", "==", user.email).get();
    
    
        if(!query.empty){
          return res.status(200).json({success: true})
        }
    
        if (!user.rating){
          return res.status(200).json({success: false})
        }
    
        // Add teacher data to the teacher collection
        const result = await teacherCollection.doc(user?.uid).set(user);
    
        // Initialize an empty chat list for the teacher
        const result2 = await databaseinmongo.collection("chatCollection").updateOne(
          { _id: user?.uid },  // Check if the document for this user already exists
          {
            $setOnInsert: { chats: [] }, // Ensure 'chats' is initialized as an empty array if document is created
          },
          { upsert: true } // This will create the document if it doesn't exist
        );    
        // Log both results for debugging
    
        // Send a success response
        res.status(200).send({ success: true, message: "Teacher added successfully." });
      } catch (error) {
        console.error(error);
    
        // Handle errors and send an appropriate response
        res.status(500).send({ success: false, error: "Failed to add a new teacher." });
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


  // Backend: sendVoiceMessage route
  app.post('/sendVoiceMessage', async (req, res) => {
    const { chatId, senderId, receiverId, audioUrl } = req.body;
    
    if (!chatId || !senderId || !receiverId || !audioUrl) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    const chatDB = databaseinmongo.collection('chatDB');
    const chatCollection = databaseinmongo.collection('chatCollection');
  
    try {
        // Add voice message to chatDB collection
        const message = {
            senderId,
            audioUrl,
            createdAt: new Date(),
            lastMessageFeedback: null,
        };

        const result = await chatDB.updateOne(
            { _id: new ObjectId(chatId) },
            { $push: { messages: message } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: 'Chat not found.' });
        }

        // Fetch the updated chat document after the message is added
        const chatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });

        if (chatDoc) {
            // Emit the updated chat data to the sender and receiver
            io.to(senderId).emit('chatUpdate', chatDoc);
            io.to(receiverId).emit('chatUpdate', chatDoc);

            // Calculate and emit the last message timestamp for both users
            const lastMessageIndex = chatDoc.messages.length - 1;
            if (lastMessageIndex >= 0) {
                const createdAtValue = chatDoc.messages[lastMessageIndex].createdAt;
                const mntsAgoValue = Math.floor((Date.now() - createdAtValue) / 60000);
                io.to(senderId).emit('lastMessageTimestamp', mntsAgoValue);
                io.to(receiverId).emit('lastMessageTimestamp', mntsAgoValue);
            }
        }

        // Emit the updated chat list to both users
        io.to(senderId).emit('chatListUpdate', { success: true });
        io.to(receiverId).emit('chatListUpdate', { success: true });

        res.status(200).json({ success: true, message: 'Voice message sent.' });
    } catch (error) {
        console.error('Error sending voice message:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});




    //sending message
    app.post('/sendMessage', async (req, res) => {
      const chatCollection = databaseinmongo.collection("chatCollection");
      const chatDB = databaseinmongo.collection("chatDB");

      try {
          const { chatId, senderId, text, imgUrl, receiverId } = req.body;
  
          if (!chatId || !senderId || !receiverId) {
              return res.status(400).json({ error: 'Missing required fields.' });
          }
  
          const message = {
              senderId,
              ...(text && { text }), // Only include text if it exists
              createdAt: new Date(),
              ...(imgUrl && { imageUrl: imgUrl }), // Only include image if provided
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
          const userIds = [senderId, receiverId];
  
          await Promise.all(
              userIds.map(async (id) => {
                  await chatCollection.updateOne(
                      { _id: id, 'chats.chatId': chatId },
                      {
                          $set: {
                              'chats.$.lastMessage': text || '📷 Image',
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
                      const collectionName = item.yourRole === 'student' ? 'studentCollection' : 'teacherCollection';
                      const userDoc = await database.collection(collectionName).doc(item.receiverId).get();
                        const userss = userDoc.exists ? userDoc.data() : {};

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
    const { chatId, index, isLike } = req.body;
    if (!index || !chatId) {
        return;
    }

    try {
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
      socket.on('sendVoiceMessage', async ({ chatId, senderId, audioUrl }) => {
        try {    
            // Find the chat document
            const chatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });
    
            if (!chatDoc) {
                socket.emit('chatError', { message: 'Chat not found' });
                return;
            }
    
            // Ensure `messages` field is an array before updating
            const updatedMessages = Array.isArray(chatDoc.messages) ? [...chatDoc.messages] : [];
    
            // Add the new voice message
            const newMessage = {
                audioUrl: audioUrl,
                senderId: senderId,
                lastMessageFeedback: null,
                createdAt: Date.now()
            };
            updatedMessages.push(newMessage);
    
            // Update the chat document in MongoDB
            await chatDB.updateOne(
                { _id: new ObjectId(chatId) },
                { $set: { messages: updatedMessages, updatedAt: Date.now() } }
            );
    
            // Fetch the updated chat and emit it
            const updatedChatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });
    
            if (updatedChatDoc) {
                // Emit the updated chat to both users
                io.to(chatId).emit('chatUpdate', updatedChatDoc);
    
                // Emit the last message timestamp
                const mntsAgoValue = Math.floor((Date.now() - newMessage.createdAt) / 60000);
                io.to(chatId).emit('lastMessageTimestamp', mntsAgoValue);
            }
        } catch (err) {
            console.error('Error sending voice message:', err);
            socket.emit('chatError', { message: 'Failed to send voice message' });
        }
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
                      const collectionName = item.yourRole === 'student' ? 'studentCollection' : 'teacherCollection';
                      const userDoc = await database.collection(collectionName).doc(item.receiverId).get();
                      const userss = userDoc.exists ? userDoc.data() : {};
  
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
  
      
  });
    





  

    app.post("/closeCalculation", async(req, res) => {
      try{
        const teachers = await teacherCollection.get();
        let totalPoints = 0;
        let teacherEarnings = [];
        const totalRevenueResult = await databaseinmongo.collection("subscriptions").aggregate([
          {$group: {_id: null, totalRevenue: {$sum: "$price"}}}
        ]).toArray();
        const totalRevenue = totalRevenueResult[0]?.totalRevenue || 0;

        teachers.forEach(doc => {
          totalPoints += doc.data().points || 0;
        })

        teachers.forEach(doc => {
          const teacher = doc.data();
          const teacherPercentage = teacher.revenuePercent || 0;
          const income = totalPoints > 0 ? ((teacher.points/totalPoints) * totalRevenue * teacherPercentage) : 0;

          
          teacherEarnings.push({
            uid: teacher.uid,
            name: teacher.displayName,
            whatsapp: teacher.whatsapp,
            points: teacher.points,
            income: parseInt(income),
            paid: false
          })
        });

        const revenueHistory = databaseinmongo.collection("revenueHistory");
        await revenueHistory.insertOne({
          totalPoints,
          totalRevenue,
          createdAt: new Date(),
          enrols: await databaseinmongo.collection("subscriptions").countDocuments()
        });

        const salaryHistory = databaseinmongo.collection("salaryHistory");
        await salaryHistory.insertMany(teacherEarnings);

      }catch(err) {
        console.log(err);
        
      }
    })

    app.post("/subscriptions", async (req, res) => {
      try{
        const subscriptions = databaseinmongo.collection("subscriptions");
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
              dailyMinutesLimit: req.body.callDuration,
              name: req.body.name
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




// app.listen(port, () => {
//     console.log("The Server Is running...")
    
// });
server.listen(port, () => {
  console.log("The Server Is running...")
  
});