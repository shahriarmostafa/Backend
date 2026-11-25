const express = require("express");
const app = express();
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient, ServerApiVersion } = require("mongodb");

require("dotenv").config();

// ALLOWED_ORIGINS is a comma-separated list. Unset keeps the old allow-all
// behaviour so a misconfigured deploy cannot black-hole every client.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const corsOptions = allowedOrigins.length
  ? {
      origin: (origin, callback) => {
        // no Origin header = server-to-server (ShurjoPay IPN, native fetch)
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} not allowed`));
      },
      credentials: true,
    }
  : {};

if (!allowedOrigins.length) {
  console.warn("[cors] ALLOWED_ORIGINS is unset — accepting every origin. Set it in production.");
}

app.use(cors(corsOptions));
app.use(express.json({ limit: "35mb" }));

const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : "*",
    methods: ["GET", "POST"],
  },
});

// The shurjopay library takes one return URL per instance and sends both paid
// and cancelled checkouts to it (SP_CANCEL_URL is never used - the app asks
// /api/payments/:orderId/status for the outcome). One instance returns to the
// native app's poperl:// link, the other to the web app, which can't open it.
const makeShurjopay = (returnUrl) => {
  const instance = require("shurjopay")();
  instance.config(
    process.env.SP_ENDPOINT,
    process.env.SP_USERNAME,
    process.env.SP_PASSWORD,
    process.env.SP_PREFIX,
    returnUrl
  );
  return instance;
};
const shurjopay = makeShurjopay(process.env.SP_RETURN_URL);
const shurjopayWeb = makeShurjopay(process.env.SP_WEB_RETURN_URL || "https://app.poperl.com/payment-done");

const { database, admin } = require("./firebase.config");

// Authentication must sit in front of every route, including the ones mounted
// before Mongo connects.
const { makeAuthMiddleware } = require("./middleware/auth");
const auth = makeAuthMiddleware({ admin });
app.use(auth.attachUser);
app.use(auth.gate);

// Routes that don't need DB
// whiteboard and call tokens check call membership, so they mount once Mongo is up (see run())
app.use(require("./routes/notifications")());

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

    // the owner gate reads from Mongo, so hand it the connection
    auth.setDatabase(db);
    await require("./utils/ensureIndexes").ensureIndexes(db);

    const collections = {
      subscriptions: db.collection("subscriptions"),
      referrals: db.collection("referrals"),
      withdrawals: db.collection("withdrawals"),
      activepackages: db.collection("activePackages"),
      userCollection: db.collection("userCollection"),
      studyRooms: db.collection("studyRooms"),
      courses: db.collection("courses"),
      roomQuizzes: db.collection("roomQuizzes"),
      publicQuizzes: db.collection("publicQuizzes"),
      // the payment routes price purchases from these rather than from the
      // request body
      packages: db.collection("packages"),
      creditPrices: db.collection("creditPrices"),
      databaseinmongo: db,
      client,
    };

    app.use(require("./routes/whiteboard")({ databaseinmongo: db }));
    app.use(require("./routes/users")({ ...collections, admin }));
    app.use(require("./routes/teachers")(collections));
    app.use(require("./routes/studyRooms")({ ...collections, admin }));
    app.use(require("./routes/courses")(collections));
    app.use(require("./routes/storage")({ databaseinmongo: db }));
    app.use(require("./routes/quizzes")(collections));
    app.use(require("./routes/progress")(collections));
    app.use(require("./routes/notificationFeed")(collections));
    app.use(require("./routes/calls")({ ...collections, admin }));
    app.use(require("./routes/chat")({ ...collections, io, admin }));
    app.use(require("./routes/payment")({ ...collections, shurjopay, shurjopayWeb }));
    app.use(require("./routes/admin")(collections));

    const { setupSocket } = require("./routes/chat");
    setupSocket({ io, userCollection: collections.userCollection, databaseinmongo: db, admin });

    // Close call sessions abandoned by a dead client, so billing finalises
    // instead of the session hanging open forever.
    require("./utils/sessionReaper")
      .makeSessionReaper({
        databaseinmongo: db,
        activepackages: collections.activepackages,
        userCollection: collections.userCollection,
      })
      .start();

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
