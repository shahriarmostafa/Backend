const express = require("express");
const app = express();
const cors =  require("cors");
const port = process.env.port || 5000;

require("dotenv").config();

app.use(cors());
app.use(express.json());


//getting firestore

const database = require("./firebase.config");
const studentCollection = database.collection("studentCollection");
const teacherCollection = database.collection("teacherCollection");

const chatListCollection = database.collection("chatCollection");

app.post("/newStudent", async(req, res) => {
  const user = req.body;
  const result = await studentCollection.doc(user?.uid).set(user);
  const result2 = await chatListCollection.doc(user.uid).set({chats: []});
  console.log(result, result2);
})

app.post("/newTeacher", async(req, res) => {
  const user = req.body;
  const result = await teacherCollection.doc(user?.uid).set(user);
  const result2 = await chatListCollection.doc(user.uid).set({chats: []});
  res.send(result2);
})

app.get("/teacherList", async(req, res) => {
  const result = await teacherCollection.where('approved', "==", true).get();
  const teacherList = [];
  result.forEach(doc => {
      teacherList.push({ id: doc.id, ...doc.data() });
    });
    res.send(teacherList)
})



app.listen(port, () => {
    console.log("The Server Is running...")
    
});