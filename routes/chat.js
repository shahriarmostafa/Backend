const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeRoomHelpers } = require("../utils/roomHelpers");

module.exports = ({ userCollection, studyRooms, activepackages, databaseinmongo, io }) => {
  const router = Router();

  const { getRoomMembership } = makeRoomHelpers({
    userCollection,
    databaseinmongo,
    studyRooms,
    activepackages,
  });

  router.get("/chatExist/:userId/:receiverId", async (req, res) => {
    const { userId, receiverId } = req.params;
    const userChatCollection = databaseinmongo.collection("chatCollection");
    const userChat = await userChatCollection.findOne({ _id: userId });
    const existingChat = userChat.chats.find((chat) => chat.receiverId === receiverId);

    if (existingChat) {
      return res.json({ exists: true, chatId: existingChat.chatId });
    } else {
      return res.json({ exists: false });
    }
  });

  router.post("/createChat", async (req, res) => {
    const { userId, receiverId } = req.body;
    const chatDB = databaseinmongo.collection("chatDB");
    const userChatCollection = databaseinmongo.collection("chatCollection");

    const newChat = await chatDB.insertOne({ createdAt: new Date(), messages: [] });
    const chatId = newChat.insertedId.toString();

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

  router.post("/sendMessage", async (req, res) => {
    const chatCollection = databaseinmongo.collection("chatCollection");
    const chatDB = databaseinmongo.collection("chatDB");

    try {
      const {
        chatId,
        senderId,
        text,
        imageUrl,
        audioUrl,
        fileUrl,
        fileName,
        fileType,
        fileSize,
        receiverId,
        receiverIds,
        roomId,
      } = req.body;
      const messageReceiverIds =
        Array.isArray(receiverIds) && receiverIds.length
          ? receiverIds
          : receiverId
          ? [receiverId]
          : [];

      if (!chatId || !senderId || messageReceiverIds.length === 0)
        return res.status(400).json({ error: "Missing required fields." });

      if (roomId) {
        const room = await studyRooms.findOne({ _id: new ObjectId(roomId) });
        const isActiveStudentMember =
          room &&
          (room.memberIds || []).includes(senderId) &&
          getRoomMembership(room, senderId).isActive;
        const isAssignedRoomTeacher =
          room &&
          (room.teacherSessions || []).some(
            (session) => session.teacherId === senderId && session.chatId === chatId
          );

        if (!room || (!isActiveStudentMember && !isAssignedRoomTeacher))
          return res
            .status(403)
            .json({ error: "Renew this room membership before sending messages." });
      }

      if (fileUrl) {
        const allowedFileTypes = ["pdf", "docx", "pptx"];
        const normalizedFileType = String(fileType || "").toLowerCase();
        const fileNameExtension = String(fileName || "").split(".").pop().toLowerCase();

        if (
          !allowedFileTypes.includes(normalizedFileType) ||
          normalizedFileType !== fileNameExtension
        )
          return res
            .status(400)
            .json({ error: "Only PDF, DOCX, or PPTX files are supported." });

        if (Number(fileSize) > 1024 * 1024)
          return res.status(400).json({ error: "File size should not exceed 1MB." });
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

      const result = await chatDB.updateOne(
        { _id: new ObjectId(chatId) },
        { $push: { messages: message } }
      );

      if (result.modifiedCount === 0)
        return res.status(404).json({ error: "Chat not found." });

      const userIds = [...new Set([senderId, ...messageReceiverIds])];

      await Promise.all(
        userIds.map((id) =>
          chatCollection.updateOne(
            { _id: id, "chats.chatId": chatId },
            {
              $set: {
                "chats.$.lastMessage":
                  text || (audioUrl ? "🎙️ Voice" : fileUrl ? "📎 File" : "📷 Image"),
                "chats.$.isSeen": id === senderId,
                "chats.$.lastMessageFeedback": null,
                "chats.$.updatedAt": Date.now(),
              },
            }
          )
        )
      );

      const updatedChat = await chatDB.findOne({ _id: new ObjectId(chatId) });
      io.to(chatId).emit("chatUpdate", updatedChat);

      const updatedChatLists = await Promise.all(
        userIds.map(async (id) => {
          const userChatDoc = await chatCollection.findOne({ _id: id });
          if (!userChatDoc) return [];
          const chatInfos = userChatDoc.chats || [];
          return Promise.all(
            chatInfos.map(async (item) => {
              const userDoc = await userCollection.findOne({ uid: item.receiverId });
              return { ...item, userss: userDoc || {} };
            })
          );
        })
      );

      userIds.forEach((id, index) => {
        const chatList = updatedChatLists[index];
        const unseenCount = chatList.filter((chat) => !chat.isSeen).length;
        io.to(id).emit("chatListUpdate", { chatList, unseenCount });
      });

      res.json({ success: true, message });
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  router.put("/mark-chat-as-seen", async (req, res) => {
    const { userId, chatId } = req.body;
    const chatCollection = databaseinmongo.collection("chatCollection");

    if (!userId || !chatId)
      return res.status(400).json({ message: "userId and chatId are required" });

    try {
      const userChatDoc = await chatCollection.findOne({ _id: userId });
      if (!userChatDoc)
        return res.status(404).json({ message: "User chat document not found" });

      const chatIndex = userChatDoc.chats.findIndex((item) => item.chatId === chatId);
      if (chatIndex === -1) return res.status(404).json({ message: "Chat not found" });

      userChatDoc.chats[chatIndex].isSeen = true;
      await chatCollection.updateOne(
        { _id: userId },
        { $set: { chats: userChatDoc.chats } }
      );
      return res.status(200).json({ message: "Chat marked as seen successfully" });
    } catch (err) {
      console.error("Error marking chat as seen:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  router.put("/update-feedback", async (req, res) => {
    const { teacherId, chatId, index, isLike } = req.body;
    if (!index || !chatId) return;

    try {
      if (!teacherId) return res.status(400).json({ error: "teacherId required" });

      const teacher = await userCollection.findOne({ uid: teacherId });
      if (!teacher) return res.status(404).json({ error: "Teacher not found" });

      const { points = 0, rating = 0 } = teacher;
      const newPoints = isLike && chatId ? points + 2 : points - 2;
      const newRating = isLike ? (5 - rating) / 10 : -((5 - rating) / 10);

      await userCollection.updateOne(
        { uid: teacherId },
        { $set: { points: newPoints }, $inc: { rating: newRating } }
      );

      const chatDB = databaseinmongo.collection("chatDB");
      const chat = await chatDB.findOne({ _id: new ObjectId(chatId) });
      if (!chat) return;

      const messages = chat.messages || [];
      if (!messages[index]) return;

      messages[index] = {
        ...messages[index],
        lastMessageFeedback: isLike ? "liked" : "disliked",
      };

      await chatDB.updateOne({ _id: new ObjectId(chatId) }, { $set: { messages } });
      const updatedChat = await chatDB.findOne({ _id: new ObjectId(chatId) });
      io.to(chatId).emit("chatUpdate", updatedChat);
    } catch (err) {
      console.error(err);
      res.status(500).send("Internal server error.");
    }
  });

  return router;
};

// Socket.io setup — called once in index.js after io is created
module.exports.setupSocket = ({ io, userCollection, databaseinmongo }) => {
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);
    const chatDB = databaseinmongo.collection("chatDB");

    socket.on("typing", (chatId) => {
      console.log(socket.id);
      socket.to(chatId).emit("userTyping", { userId: socket.id });
    });

    socket.on("stopTyping", (chatId) => {
      socket.to(chatId).emit("userStopTyping", { userId: socket.id });
    });

    socket.on("joinChatRoom", async (chatId) => {
      socket.join(chatId);
      console.log(`User joined chat room: ${chatId}`);
      try {
        const chatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });
        if (chatDoc) {
          socket.emit("chatUpdate", chatDoc);
          const lastMessageIndex = chatDoc.messages.length - 1;
          if (lastMessageIndex >= 0) {
            const mntsAgoValue = Math.floor(
              (Date.now() - chatDoc.messages[lastMessageIndex].createdAt) / 60000
            );
            socket.emit("lastMessageTimestamp", mntsAgoValue);
          }
        } else {
          socket.emit("chatError", { message: "Chat not found" });
        }
      } catch (err) {
        console.error("Error fetching chat:", err);
        socket.emit("chatError", { message: "Failed to fetch chat" });
      }
    });

    socket.on("joinRoom", async (userId) => {
      socket.join(userId);
      console.log(`User ${userId} joined the room.`);
      try {
        const chatCollection = databaseinmongo.collection("chatCollection");
        const userChatDoc = await chatCollection.findOne({ _id: userId });
        if (userChatDoc) {
          const chatInfos = userChatDoc.chats || [];
          let totalUnseen = 0;
          const promises = chatInfos.map(async (item) => {
            const userDoc = await userCollection.findOne({ uid: item.receiverId });
            if (item.isSeen === false) totalUnseen++;
            return { ...item, userss: userDoc || {} };
          });
          const chatData = await Promise.all(promises);
          const sortedChatData = chatData.sort((a, b) => b.updatedAt - a.updatedAt);
          socket.emit("chatListUpdate", { chatList: sortedChatData, unseenCount: totalUnseen });
        }
      } catch (err) {
        console.error("Error fetching chat list:", err);
        socket.emit("chatListError", { message: "Failed to fetch chat list" });
      }
    });

    socket.on("register-user", ({ userId }) => {
      socket.join(userId);
      console.log(`✅ ${userId} joined room`);
    });
  });
};
