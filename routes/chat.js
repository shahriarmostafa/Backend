const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { makeRoomHelpers } = require("../utils/roomHelpers");
const { makeSupabaseStorage } = require("../utils/supabaseStorage");
const { makeTeacherQualityHelpers } = require("../utils/teacherQualityHelpers");
const { makeNotificationHelpers } = require("../utils/notificationHelpers");
const { CHAT_REACTION_STUDENT_XP, CHAT_REACTION_WEEKLY_TARGET } = require("../utils/constants");
const {
  getMessageCreditCost,
  getMessageTeacherPoints,
  resolveMessageEconomy,
} = require("../utils/messageEconomy");

// How many messages a client receives when it opens a chat. Older pages are
// fetched on demand from /chat-messages/:chatId.
const MESSAGE_PAGE_SIZE = 50;

module.exports = ({ userCollection, studyRooms, activepackages, databaseinmongo, io }) => {
  const router = Router();

  const { getRoomMembership, ensureRoomChatSubscriptions } = makeRoomHelpers({
    userCollection,
    databaseinmongo,
    studyRooms,
    activepackages,
  });
  const supabaseStorage = makeSupabaseStorage();
  const { recordReactionEvent, recordFirstReplySpeedEvent, applyTeacherQualitySnapshot } =
    makeTeacherQualityHelpers({ databaseinmongo, userCollection });
  const { createRoomNotification } = makeNotificationHelpers({
    databaseinmongo,
    userCollection,
    studyRooms,
  });

  const recordTeacherFirstReplyIfNeeded = async ({ chatId, teacherId }) => {
    try {
      if (!ObjectId.isValid(chatId) || !teacherId) return;
      const sender = await userCollection.findOne(
        { uid: teacherId },
        { projection: { uid: 1, role: 1, points: 1 } }
      );
      if (sender?.role !== "teacher") return;

      const chatDB = databaseinmongo.collection("chatDB");
      const chat = await chatDB.findOne({ _id: new ObjectId(chatId) });
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      const teacherMessageIndex = messages.findIndex((item) => item.senderId === teacherId);
      if (teacherMessageIndex < 0) return;

      const firstStudentMessage = messages.find(
        (item, index) => index < teacherMessageIndex && item.senderId && item.senderId !== teacherId
      );
      if (!firstStudentMessage?.createdAt) return;

      const firstTeacherMessage = messages[teacherMessageIndex];
      const replyAt = new Date(firstTeacherMessage.createdAt || Date.now()).getTime();
      const askedAt = new Date(firstStudentMessage.createdAt).getTime();
      const minutes = Math.max((replyAt - askedAt) / 60000, 0);

      await recordFirstReplySpeedEvent({
        teacherId,
        studentId: firstStudentMessage.senderId,
        sourceId: chatId,
        dedupeKey: `first_reply_speed:${chatId}:${teacherId}:${firstStudentMessage.senderId}`,
        minutes,
        metadata: {
          chatId,
          teacherMessageIndex,
          studentMessageIndex: messages.indexOf(firstStudentMessage),
        },
      });
      await applyTeacherQualitySnapshot({ teacherId, basePoints: sender.points || 0 });
    } catch (err) {
      console.error("Error recording teacher first reply quality:", err);
    }
  };

  const hydrateChatListForUser = async (userId, chatCollection) => {
    const currentUser = await userCollection.findOne(
      { uid: userId },
      { projection: { uid: 1, role: 1 } }
    );
    if (currentUser?.role === "teacher") {
      const teacherRooms = await studyRooms
        .find({ "teacherSessions.teacherId": userId })
        .project({ _id: 1, memberIds: 1, chats: 1 })
        .toArray();
      await Promise.all(
        teacherRooms.flatMap((room) =>
          (room.chats || [])
            .filter((chat) => chat.teacherId === userId)
            .map((chat) =>
              ensureRoomChatSubscriptions({
                chat: { ...chat, roomId: room._id.toString() },
                participantIds: chat.participantIds || [...(room.memberIds || []), userId],
                roomId: room._id.toString(),
              })
            )
        )
      );
    }

    const userChatDoc = await chatCollection.findOne({ _id: userId });
    if (!userChatDoc) return { chatList: [], unseenCount: 0 };

    const chatInfos = userChatDoc.chats || [];
    const receiverIds = [
      ...new Set(
        chatInfos
          .filter((item) => !item.roomChat && item.receiverId)
          .map((item) => item.receiverId)
      ),
    ];
    const users = receiverIds.length
      ? await userCollection.find({ uid: { $in: receiverIds } }).toArray()
      : [];
    const usersById = users.reduce((acc, item) => {
      acc[item.uid] = item;
      return acc;
    }, {});

    const roomChatInfos = chatInfos.filter((item) => item.roomChat || item.roomId);
    const roomIds = [...new Set(roomChatInfos.map((item) => item.roomId).filter(Boolean))]
      .filter((id) => ObjectId.isValid(id));
    const rooms = roomIds.length
      ? await studyRooms.find({ _id: { $in: roomIds.map((id) => new ObjectId(id)) } }).toArray()
      : [];
    const roomsById = rooms.reduce((acc, room) => {
      acc[room._id.toString()] = room;
      return acc;
    }, {});
    const roomParticipantIds = [
      ...new Set(
        roomChatInfos
          .flatMap((item) => [
            item.receiverId,
            item.teacherId,
            ...(Array.isArray(item.participantIds) ? item.participantIds : []),
            ...(roomsById[item.roomId]?.memberIds || []),
          ])
          .filter(Boolean)
      ),
    ];
    const roomParticipants = roomParticipantIds.length
      ? await userCollection
          .find({ uid: { $in: roomParticipantIds } })
          .project({ uid: 1, displayName: 1, photoURL: 1, email: 1, role: 1 })
          .toArray()
      : [];
    const roomParticipantsById = roomParticipants.reduce((acc, person) => {
      acc[person.uid] = person;
      return acc;
    }, {});

    const hydrateRoomReceiver = (item) => {
      const room = roomsById[item.roomId] || {};
      const receiverRole = item.receiverRole || item.yourRole || null;
      const teacher = item.teacherId ? roomParticipantsById[item.teacherId] : null;
      const memberIds = room.memberIds || [];
      const members = memberIds.map((id) => roomParticipantsById[id]).filter(Boolean);
      const participantIds = Array.isArray(item.participantIds) && item.participantIds.length
        ? item.participantIds
        : [...memberIds, item.teacherId].filter(Boolean);
      const participants = participantIds.map((id) => roomParticipantsById[id]).filter(Boolean);
      const isStudentViewingTeacherChat = receiverRole === "teacher" && teacher;

      return {
        uid: isStudentViewingTeacherChat ? teacher.uid : item.roomId || item.receiverId,
        displayName: item.chatName || room.name || "Room chat",
        photoURL: isStudentViewingTeacherChat ? teacher.photoURL : null,
        email: isStudentViewingTeacherChat ? teacher.email : null,
        role: receiverRole,
        roomId: item.roomId || room._id?.toString() || null,
        roomName: room.name || "",
        roomKeyword: room.keyword || "",
        teacherControl: room.teacherControl === true,
        roomCreditRate: 0.7,
        teacher,
        members,
        participants,
        participantIds,
        backTo: "/chat",
      };
    };

    const chatList = chatInfos
      .map((item) => ({
        ...item,
        receiverRole: item.receiverRole || item.yourRole || null,
        userss: item.roomChat || item.roomId
          ? hydrateRoomReceiver(item)
          : usersById[item.receiverId] || {},
      }))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));

    return {
      chatList,
      unseenCount: chatList.filter((chat) => chat.isSeen === false).length,
    };
  };

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
            receiverRole: "student",
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
            receiverRole: "teacher",
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

  /**
   * How many answers this student has rated this week, so the chat can show
   * honest progress toward a weekly goal instead of an unexplained prompt.
   */
  router.get("/api/students/:studentId/reaction-progress", async (req, res) => {
    try {
      const { studentId } = req.params;
      if (req.auth?.uid && req.auth.uid !== studentId)
        return res.status(403).json({ error: "Forbidden", reason: "uid_mismatch" });

      const startOfWeek = new Date();
      startOfWeek.setUTCHours(0, 0, 0, 0);
      startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());

      const rated = await databaseinmongo.collection("teacherQualityEvents").countDocuments({
        studentId,
        source: "chat_reaction",
        createdAt: { $gte: startOfWeek },
      });

      return res.json({
        rated,
        target: CHAT_REACTION_WEEKLY_TARGET,
        xpPerReaction: CHAT_REACTION_STUDENT_XP,
      });
    } catch (err) {
      console.error("Failed to load reaction progress:", err);
      return res.status(500).json({ error: "Failed to load reaction progress" });
    }
  });

  /**
   * Older messages, for scroll-back. `before` is the number of messages the
   * client already holds, counted from the end of the conversation.
   */
  router.get("/chat-messages/:chatId", async (req, res) => {
    try {
      const { chatId } = req.params;
      if (!ObjectId.isValid(chatId)) return res.status(400).json({ error: "Invalid chatId" });

      const alreadyLoaded = Math.max(Number(req.query.before) || 0, 0);
      const limit = Math.min(Math.max(Number(req.query.limit) || MESSAGE_PAGE_SIZE, 1), 100);
      const chatDB = databaseinmongo.collection("chatDB");

      const [doc] = await chatDB
        .aggregate([
          { $match: { _id: new ObjectId(chatId) } },
          {
            $project: {
              totalMessages: { $size: { $ifNull: ["$messages", []] } },
              messages: { $ifNull: ["$messages", []] },
            },
          },
        ])
        .toArray();

      if (!doc) return res.status(404).json({ error: "Chat not found" });

      const end = Math.max(doc.totalMessages - alreadyLoaded, 0);
      const start = Math.max(end - limit, 0);
      const messages = doc.messages.slice(start, end);

      return res.json({
        messages,
        totalMessages: doc.totalMessages,
        hasMoreMessages: start > 0,
      });
    } catch (err) {
      console.error("Failed to load older messages:", err);
      return res.status(500).json({ error: "Failed to load messages" });
    }
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
        imagePath,
        audioUrl,
        audioPath,
        audioDuration,
        fileUrl,
        filePath,
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
      let roomForNotification = null;

      if (!chatId || !senderId || messageReceiverIds.length === 0)
        return res.status(400).json({ error: "Missing required fields." });

      if (roomId) {
        const room = await studyRooms.findOne({ _id: new ObjectId(roomId) });
        roomForNotification = room;
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

        if (isAssignedRoomTeacher && room.teacherControl !== true) {
          const chatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });
          if (!chatDoc) return res.status(404).json({ error: "Chat not found." });
          const roomStudentIds = new Set(room.memberIds || []);
          let consecutiveTeacherMessages = 0;

          for (let index = (chatDoc.messages || []).length - 1; index >= 0; index -= 1) {
            const messageSender = chatDoc.messages[index]?.senderId;
            if (roomStudentIds.has(messageSender)) break;
            if (messageSender === senderId) consecutiveTeacherMessages += 1;
          }

          if (consecutiveTeacherMessages >= 3) {
            return res.status(429).json({
              error: "A room teacher can send up to 3 consecutive messages. Please wait for a student reply.",
            });
          }
        }
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

      // Who pays, decided from the sender's stored role and the chat itself
      // rather than from anything the client sent.
      const sender = await userCollection.findOne(
        { uid: senderId },
        { projection: { uid: 1, role: 1 } }
      );
      const economy = resolveMessageEconomy({
        senderRole: sender?.role,
        roomId,
        chatId,
        room: roomForNotification,
      });
      const messageFacts = {
        text,
        hasImage: Boolean(imageUrl),
        audioDuration: audioUrl ? audioDuration : null,
        hasFile: Boolean(fileUrl),
      };
      const creditCost = economy.charges ? getMessageCreditCost(messageFacts) : 0;

      // Conditional deduct: the filter refuses to match without enough credit,
      // so a message can neither be sent for free nor push a balance negative.
      if (creditCost > 0) {
        const paid = await activepackages.updateOne(
          { uid: senderId, credit: { $gte: creditCost } },
          { $inc: { credit: -creditCost } }
        );
        if (paid.matchedCount === 0) {
          return res.status(402).json({ error: "Not enough credit to send this message." });
        }
      }

      // The client mints the id so its optimistic copy and the broadcast copy
      // are the same message - the socket event usually beats this response,
      // and without a shared id the sender would render it twice.
      const clientMessageId = String(req.body.messageId || "");
      const safeMessageId = /^[A-Za-z0-9_-]{8,64}$/.test(clientMessageId)
        ? clientMessageId
        : new ObjectId().toString();

      const message = {
        messageId: safeMessageId,
        senderId,
        ...(text && { text }),
        createdAt: new Date(),
        ...(imageUrl && { imageUrl }),
        ...(imagePath && { imagePath }),
        ...(audioUrl && { audioUrl }),
        ...(audioPath && { audioPath }),
        ...(fileUrl && { fileUrl }),
        ...(filePath && { filePath }),
        ...(fileName && { fileName }),
        ...(fileType && { fileType }),
        ...(fileSize && { fileSize }),
        lastMessageFeedback: null,
      };

      const result = await chatDB.updateOne(
        { _id: new ObjectId(chatId) },
        { $push: { messages: message } }
      );

      if (result.modifiedCount === 0) {
        // refund: the student paid above but the message never landed
        if (creditCost > 0) {
          await activepackages.updateOne({ uid: senderId }, { $inc: { credit: creditCost } });
        }
        return res.status(404).json({ error: "Chat not found." });
      }

      // teachers earn points for the reply they just sent
      const pointsAwarded = economy.awardsPoints ? getMessageTeacherPoints(messageFacts) : 0;
      if (pointsAwarded > 0) {
        await userCollection.updateOne(
          { uid: senderId, role: "teacher" },
          { $inc: { points: pointsAwarded } }
        );
      }

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

      // Send the one new message, not the whole conversation. Re-broadcasting
      // the full document meant a 1,000-message chat re-sent ~200KB to every
      // participant on every "ok", and the cost grew with the conversation.
      io.to(chatId).emit("messageAdded", { chatId, message });

      const updatedChatLists = await Promise.all(
        userIds.map((id) => hydrateChatListForUser(id, chatCollection))
      );

      userIds.forEach((id, index) => {
        const { chatList, unseenCount } = updatedChatLists[index];
        io.to(id).emit("chatListUpdate", { chatList, unseenCount });
      });

      const remainingCredit =
        creditCost > 0
          ? (await activepackages.findOne({ uid: senderId }, { projection: { credit: 1 } }))?.credit ?? null
          : null;

      res.json({ success: true, message, creditSpent: creditCost, pointsAwarded, remainingCredit });
      setImmediate(() => {
        recordTeacherFirstReplyIfNeeded({ chatId, teacherId: senderId });
        if (roomForNotification) {
          const preview = text || (audioUrl ? "Sent a voice message" : fileUrl ? `Shared ${fileName || "a file"}` : "Shared an image");
          createRoomNotification({
            room: roomForNotification,
            type: "room_chat_message",
            title: "New room message",
            message: String(preview || "New message").slice(0, 160),
            actorId: senderId,
            metadata: {
              chatId,
              roomId: roomForNotification._id.toString(),
              hasAttachment: Boolean(imageUrl || audioUrl || fileUrl),
            },
          }).catch((err) => console.error("Error creating room chat notification:", err));
        }
      });
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  router.delete("/api/chats/:chatId", async (req, res) => {
    try {
      const { chatId } = req.params;
      const { userId } = req.body || {};
      if (!ObjectId.isValid(chatId)) return res.status(400).json({ error: "Invalid chatId." });
      if (!userId) return res.status(400).json({ error: "userId is required." });

      const chatCollection = databaseinmongo.collection("chatCollection");
      const chatDB = databaseinmongo.collection("chatDB");
      const userChatDoc = await chatCollection.findOne({ _id: userId, "chats.chatId": chatId });
      if (!userChatDoc) return res.status(404).json({ error: "Chat not found for this user." });

      const chatEntry = (userChatDoc.chats || []).find((item) => item.chatId === chatId);
      if (chatEntry?.roomChat || chatEntry?.roomId)
        return res.status(403).json({ error: "Room chats are deleted with the room by admin." });

      const participants = await chatCollection
        .find({ "chats.chatId": chatId }, { projection: { _id: 1 } })
        .toArray();
      const participantIds = participants.map((item) => item._id);
      const chatDoc = await chatDB.findOne({ _id: new ObjectId(chatId) });
      const storagePaths = supabaseStorage.collectMessageStoragePaths(chatDoc?.messages || []);
      const storageResult = await supabaseStorage.deletePaths(storagePaths);
      const folderStorageResult = await supabaseStorage.deleteFolders([`chats/${chatId}`]);

      await chatDB.deleteOne({ _id: new ObjectId(chatId) });
      await chatCollection.updateMany({}, { $pull: { chats: { chatId } } });

      const updatedChatLists = await Promise.all(
        participantIds.map((id) => hydrateChatListForUser(id, chatCollection))
      );
      participantIds.forEach((id, index) => {
        const { chatList, unseenCount } = updatedChatLists[index];
        io.to(id).emit("chatListUpdate", { chatList, unseenCount });
      });
      io.to(chatId).emit("chatDeleted", { chatId });

      res.json({ success: true, storage: { files: storageResult, folders: folderStorageResult } });
    } catch (err) {
      console.error("Error deleting chat:", err);
      res.status(500).json({ error: "Failed to delete chat." });
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
      const { chatList, unseenCount } = await hydrateChatListForUser(userId, chatCollection);
      io.to(userId).emit("chatListUpdate", { chatList, unseenCount });
      return res.status(200).json({ message: "Chat marked as seen successfully" });
    } catch (err) {
      console.error("Error marking chat as seen:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  router.put("/update-feedback", async (req, res) => {
    const { teacherId, chatId, index, messageId, isLike, feedbackType, reaction, reactionMs } = req.body;
    // XP is awarded to the reacting student, so trust the verified caller over
    // whatever the body claims.
    const studentId = req.auth?.uid || req.body.studentId;

    try {
      const isCall = feedbackType === "call";
      const isChat = !isCall;
      const resolvedReaction = reaction || (isLike ? "liked" : "disliked");

      // A chat reaction is write-once. The conditional update is the lock: it
      // only matches while the message still has no reaction, so a repeated
      // request can never re-score the teacher or rewrite the student's choice.
      //
      // Prefer messageId - array position is not a stable identity and breaks
      // as soon as the client is paginated or a message is ever removed. Fall
      // back to index for messages written before messageId existed.
      const claimChatMessageReaction = async () => {
        if (!chatId || !ObjectId.isValid(chatId)) return false;
        const chatDB = databaseinmongo.collection("chatDB");
        let result;

        if (messageId) {
          result = await chatDB.updateOne(
            { _id: new ObjectId(chatId) },
            { $set: { "messages.$[target].lastMessageFeedback": resolvedReaction } },
            {
              arrayFilters: [
                { "target.messageId": messageId, "target.lastMessageFeedback": null },
              ],
            }
          );
        } else {
          const messageIndex = Number(index);
          if (!Number.isInteger(messageIndex) || messageIndex < 0) return false;
          result = await chatDB.updateOne(
            {
              _id: new ObjectId(chatId),
              // guard against $set padding the array when the index does not exist
              [`messages.${messageIndex}`]: { $exists: true },
              [`messages.${messageIndex}.lastMessageFeedback`]: null,
            },
            { $set: { [`messages.${messageIndex}.lastMessageFeedback`]: resolvedReaction } }
          );
        }

        if (!result.modifiedCount) return false;

        // one changed field, not the whole conversation
        io.to(chatId).emit("messageUpdated", {
          chatId,
          messageId: messageId || null,
          index: messageId ? null : Number(index),
          changes: { lastMessageFeedback: resolvedReaction },
        });
        return true;
      };

      // Claim before scoring: if the claim fails the reaction already happened
      // (or the message is gone), so nothing downstream should run.
      if (isChat && !(await claimChatMessageReaction())) {
        return res.json({
          success: true,
          reaction: resolvedReaction,
          xpAwarded: 0,
          alreadyReacted: true,
        });
      }

      if (!teacherId) {
        if (isChat) {
          return res.json({ success: true, reaction: resolvedReaction, xpAwarded: 0 });
        }
        return res.status(400).json({ error: "teacherId required" });
      }

      const teacher = await userCollection.findOne({ uid: teacherId });
      if (!teacher || teacher.role !== "teacher") {
        if (isChat) {
          return res.json({
            success: true,
            reaction: resolvedReaction,
            xpAwarded: 0,
            teacherFeedbackSkipped: true,
          });
        }
        return res.status(404).json({ error: "Teacher not found" });
      }

      const pointDelta = isLike ? (isCall ? 5 : 3) : (isCall ? -5 : -3);
      const newPoints = (teacher.points || 0) + pointDelta;

      const { rating = 0 } = teacher;
      const ratingDelta = isLike ? (5 - rating) / 10 : -((5 - rating) / 10);

      await userCollection.updateOne(
        { uid: teacherId },
        { $set: { points: newPoints }, $inc: { rating: ratingDelta } }
      );

      const qualityResult = await recordReactionEvent({
        teacherId,
        studentId,
        source: isCall ? "call_review" : "chat_reaction",
        // key on messageId where we have it: array position shifts under
        // pagination, so it cannot identify a message across requests
        sourceId: isCall
          ? `call:${teacherId}:${studentId || "unknown"}:${Date.now()}`
          : `${chatId}:${messageId || index}`,
        dedupeKey: isCall
          ? `call_review:${teacherId}:${studentId || "unknown"}:${Date.now()}`
          : `chat_reaction:${chatId}:${messageId || index}:${studentId || "unknown"}`,
        isLike,
        reaction,
        // reactionMs is recorded, not acted on. It exists so reflex taps can be
        // told apart from considered ones before anyone decides whether to
        // weight them differently in teacher quality.
        metadata: {
          chatId,
          index,
          messageId: messageId || null,
          feedbackType,
          reactionMs: Number.isFinite(Number(reactionMs)) ? Math.round(Number(reactionMs)) : null,
        },
      });
      await applyTeacherQualitySnapshot({ teacherId, basePoints: newPoints });

      const xpAwarded = !isCall && studentId && qualityResult?.inserted
        ? CHAT_REACTION_STUDENT_XP
        : 0;
      if (xpAwarded > 0) {
        await userCollection.updateOne(
          { uid: studentId, role: "student" },
          {
            $inc: {
              reactionXp: xpAwarded,
              "progressXp.reactionXp": xpAwarded,
              "progressXp.xp": xpAwarded,
            },
            $set: { reactionXpUpdatedAt: new Date() },
          }
        );
        await databaseinmongo.collection("leaderboardSnapshots").updateOne(
          { scope: "public", scopeId: "public", studentId },
          {
            $inc: { xp: xpAwarded, reactionXp: xpAwarded },
            $set: { updatedAt: new Date() },
          }
        );
      }

      res.json({
        success: true,
        reaction: resolvedReaction,
        xpAwarded,
        alreadyReacted: !qualityResult?.inserted,
      });
    } catch (err) {
      console.error(err);
      res.status(500).send("Internal server error.");
    }
  });

  return router;
};

// Socket.io setup — called once in index.js after io is created
module.exports.setupSocket = ({ io, userCollection, databaseinmongo, admin }) => {
  const socketAuthEnforced = () =>
    String(process.env.AUTH_ENFORCE ?? "true").toLowerCase() !== "false";

  // Identity comes from the verified handshake token, never from the payload a
  // client sends. Previously any connection could claim any uid and receive
  // that user's chat list and messages.
  io.use(async (socket, next) => {
    const token = socket.handshake?.auth?.token || null;
    if (token && admin) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        socket.data.uid = decoded.uid;
        return next();
      } catch (err) {
        if (socketAuthEnforced()) return next(new Error("unauthorized"));
        console.warn(`[socket] bad token accepted (AUTH_ENFORCE=false): ${err?.code || err}`);
        return next();
      }
    }
    if (socketAuthEnforced()) return next(new Error("unauthorized"));
    console.warn("[socket] unauthenticated connection allowed (AUTH_ENFORCE=false)");
    return next();
  });

  // While enforcing, the client-supplied id is ignored outright.
  const identify = (socket, requested) =>
    socket.data.uid || (socketAuthEnforced() ? null : requested);

  const studyRooms = databaseinmongo.collection("studyRooms");
  const activepackages = databaseinmongo.collection("activePackages");
  const { ensureRoomChatSubscriptions } = makeRoomHelpers({
    userCollection,
    databaseinmongo,
    studyRooms,
    activepackages,
  });

  const hydrateChatListForUser = async (userId, chatCollection) => {
    const currentUser = await userCollection.findOne(
      { uid: userId },
      { projection: { uid: 1, role: 1 } }
    );
    if (currentUser?.role === "teacher") {
      const teacherRooms = await studyRooms
        .find({ "teacherSessions.teacherId": userId })
        .project({ _id: 1, memberIds: 1, chats: 1 })
        .toArray();
      await Promise.all(
        teacherRooms.flatMap((room) =>
          (room.chats || [])
            .filter((chat) => chat.teacherId === userId)
            .map((chat) =>
              ensureRoomChatSubscriptions({
                chat: { ...chat, roomId: room._id.toString() },
                participantIds: chat.participantIds || [...(room.memberIds || []), userId],
                roomId: room._id.toString(),
              })
            )
        )
      );
    }

    const userChatDoc = await chatCollection.findOne({ _id: userId });
    if (!userChatDoc) return { chatList: [], unseenCount: 0 };

    const chatInfos = userChatDoc.chats || [];
    const receiverIds = [
      ...new Set(
        chatInfos
          .filter((item) => !item.roomChat && item.receiverId)
          .map((item) => item.receiverId)
      ),
    ];
    const users = receiverIds.length
      ? await userCollection.find({ uid: { $in: receiverIds } }).toArray()
      : [];
    const usersById = users.reduce((acc, item) => {
      acc[item.uid] = item;
      return acc;
    }, {});

    const roomChatInfos = chatInfos.filter((item) => item.roomChat || item.roomId);
    const roomIds = [...new Set(roomChatInfos.map((item) => item.roomId).filter(Boolean))]
      .filter((id) => ObjectId.isValid(id));
    const rooms = roomIds.length
      ? await studyRooms.find({ _id: { $in: roomIds.map((id) => new ObjectId(id)) } }).toArray()
      : [];
    const roomsById = rooms.reduce((acc, room) => {
      acc[room._id.toString()] = room;
      return acc;
    }, {});
    const roomParticipantIds = [
      ...new Set(
        roomChatInfos
          .flatMap((item) => [
            item.receiverId,
            item.teacherId,
            ...(Array.isArray(item.participantIds) ? item.participantIds : []),
            ...(roomsById[item.roomId]?.memberIds || []),
          ])
          .filter(Boolean)
      ),
    ];
    const roomParticipants = roomParticipantIds.length
      ? await userCollection
          .find({ uid: { $in: roomParticipantIds } })
          .project({ uid: 1, displayName: 1, photoURL: 1, email: 1, role: 1 })
          .toArray()
      : [];
    const roomParticipantsById = roomParticipants.reduce((acc, person) => {
      acc[person.uid] = person;
      return acc;
    }, {});

    const hydrateRoomReceiver = (item) => {
      const room = roomsById[item.roomId] || {};
      const receiverRole = item.receiverRole || item.yourRole || null;
      const teacher = item.teacherId ? roomParticipantsById[item.teacherId] : null;
      const memberIds = room.memberIds || [];
      const members = memberIds.map((id) => roomParticipantsById[id]).filter(Boolean);
      const participantIds = Array.isArray(item.participantIds) && item.participantIds.length
        ? item.participantIds
        : [...memberIds, item.teacherId].filter(Boolean);
      const participants = participantIds.map((id) => roomParticipantsById[id]).filter(Boolean);
      const isStudentViewingTeacherChat = receiverRole === "teacher" && teacher;

      return {
        uid: isStudentViewingTeacherChat ? teacher.uid : item.roomId || item.receiverId,
        displayName: item.chatName || room.name || "Room chat",
        photoURL: isStudentViewingTeacherChat ? teacher.photoURL : null,
        email: isStudentViewingTeacherChat ? teacher.email : null,
        role: receiverRole,
        roomId: item.roomId || room._id?.toString() || null,
        roomName: room.name || "",
        roomKeyword: room.keyword || "",
        teacherControl: room.teacherControl === true,
        roomCreditRate: 0.7,
        teacher,
        members,
        participants,
        participantIds,
        backTo: "/chat",
      };
    };

    const chatList = chatInfos
      .map((item) => ({
        ...item,
        receiverRole: item.receiverRole || item.yourRole || null,
        userss: item.roomChat || item.roomId
          ? hydrateRoomReceiver(item)
          : usersById[item.receiverId] || {},
      }))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));

    return {
      chatList,
      unseenCount: chatList.filter((chat) => chat.isSeen === false).length,
    };
  };

  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);
    const chatDB = databaseinmongo.collection("chatDB");
    const sendChatList = async (userId) => {
      if (!userId) return;
      try {
        const chatCollection = databaseinmongo.collection("chatCollection");
        const { chatList, unseenCount } = await hydrateChatListForUser(userId, chatCollection);
        socket.emit("chatListUpdate", { chatList, unseenCount });
      } catch (err) {
        console.error("Error fetching chat list:", err);
        socket.emit("chatListError", { message: "Failed to fetch chat list" });
      }
    };

    socket.on("typing", (chatId) => {
      socket.to(chatId).emit("userTyping", { userId: socket.id });
    });

    socket.on("stopTyping", (chatId) => {
      socket.to(chatId).emit("userStopTyping", { userId: socket.id });
    });

    socket.on("joinChatRoom", async (chatId) => {
      if (!chatId) return;
      // joining streams every message in the chat, so confirm membership first
      const viewerId = identify(socket, null);
      if (viewerId) {
        try {
          const userChatDoc = await databaseinmongo
            .collection("chatCollection")
            .findOne({ _id: viewerId }, { projection: { chats: 1 } });
          const isMember = (userChatDoc?.chats || []).some(
            (entry) => String(entry.chatId) === String(chatId)
          );
          if (!isMember) {
            socket.emit("chatError", { message: "Not a participant of this chat" });
            return;
          }
        } catch (err) {
          console.error("Error verifying chat membership:", err);
          socket.emit("chatError", { message: "Failed to open chat" });
          return;
        }
      }

      socket.join(chatId);
      try {
        // Only the most recent page. Sending every message meant opening a long
        // conversation transferred the entire history before anything rendered.
        const [chatDoc] = await chatDB
          .aggregate([
            { $match: { _id: new ObjectId(chatId) } },
            {
              $addFields: {
                totalMessages: { $size: { $ifNull: ["$messages", []] } },
                messages: { $slice: [{ $ifNull: ["$messages", []] }, -MESSAGE_PAGE_SIZE] },
              },
            },
          ])
          .toArray();

        if (chatDoc) {
          socket.emit("chatUpdate", {
            ...chatDoc,
            hasMoreMessages: chatDoc.totalMessages > chatDoc.messages.length,
          });
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

    socket.on("leaveChatRoom", (chatId) => {
      if (!chatId) return;
      socket.leave(chatId);
    });

    socket.on("joinRoom", async (requestedUserId) => {
      const userId = identify(socket, requestedUserId);
      if (!userId) return;
      socket.join(userId);
      await sendChatList(userId);
    });

    socket.on("requestChatList", (requestedUserId) => sendChatList(identify(socket, requestedUserId)));

    socket.on("leaveRoom", (requestedUserId) => {
      const userId = identify(socket, requestedUserId);
      if (!userId) return;
      socket.leave(userId);
    });

    socket.on("register-user", ({ userId } = {}) => {
      const id = identify(socket, userId);
      if (!id) return;
      socket.join(id);
    });
  });
};
