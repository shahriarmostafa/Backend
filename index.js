const express = require("express");
const app = express();
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient, ServerApiVersion } = require("mongodb");

require("dotenv").config();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const shurjopay = require("shurjopay")();
shurjopay.config(
  process.env.SP_ENDPOINT,
  process.env.SP_USERNAME,
  process.env.SP_PASSWORD,
  process.env.SP_PREFIX,
  process.env.SP_RETURN_URL,
  process.env.SP_CANCEL_URL
);

const { database, admin } = require("./firebase.config");

// Routes that don't need DB
app.use(require("./routes/whiteboard")());
app.use(require("./routes/notifications")({ admin }));

const uri = `mongodb+srv://ssmustafasahir:${process.env.PASSWORD_DB}@cluster0.c6fvj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("PoperL");
    const collections = {
      subscriptions: db.collection("subscriptions"),
      referrals: db.collection("referrals"),
      withdrawals: db.collection("withdrawals"),
      activepackages: db.collection("activePackages"),
      userCollection: db.collection("userCollection"),
      studyRooms: db.collection("studyRooms"),
      roomQuizzes: db.collection("roomQuizzes"),
      publicQuizzes: db.collection("publicQuizzes"),
      databaseinmongo: db,
      client,
    };

    app.use(require("./routes/users")({ ...collections, admin }));
    app.use(require("./routes/teachers")(collections));
    app.use(require("./routes/studyRooms")({ ...collections, admin }));
    app.use(require("./routes/quizzes")(collections));
    app.use(require("./routes/calls")(collections));
    app.use(require("./routes/chat")({ ...collections, io }));
    app.use(require("./routes/payment")({ ...collections, shurjopay }));
    app.use(require("./routes/admin")(collections));

    const { setupSocket } = require("./routes/chat");
    setupSocket({ io, userCollection: collections.userCollection, databaseinmongo: db });

    console.log("All routes mounted.");
  } catch (err) {
    console.log(err);
  }
}

run().catch(console.dir);

const port = process.env.PORT || 5000;
server.listen(port, () => {
  console.log("The Server Is running...");
});
