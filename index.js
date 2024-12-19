const express = require("express");
const app = express();
const cors =  require("cors");
const port = process.env.port || 5000;

app.use(cors());
app.use(express.json());



const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = "mongodb+srv://ssmustafasahir:EOP7u5NWjv9QtJmq@cluster0.c6fvj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

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
    
    const adminList = client.db("adminListDB").collection("AddedUserDb");

    app.get('/user', async (req, res) => {
      const dataFromList = adminList.find();
      const result = await dataFromList.toArray();
      res.send(result)
    })
    
    

    app.post('/user', async(req, res) => {
      const user = req.body;
      const result = await adminList.insertOne(user);   
    })

    app.delete('/user/:id', async(req, res) => {
      const id = req.params.id;
      const condition = {_id: new ObjectId(id)};
      const result = await adminList.deleteOne(condition);
      res.send(result);
    })


    // code for the packages

    const PackageListDB = client.db("packagesDB").collection("AddedPackage");
    app.post('/pack', async(req, res) => {
      const pack = req.body;
      const result = await PackageListDB.insertOne(pack);
      res.send(result);   

    })
    app.get('/pack', async(req, res) => {
      const Packages = PackageListDB.find();
      const result = await Packages.toArray();
      res.send(result);
    })

    app.get('/pack/:id', async(req, res) => {
      const id = req.params.id;
      const query = {_id : new ObjectId(id)};
      const result = await PackageListDB.findOne(query);
      res.send(result);
      
    })
    app.put('/pack/:id', async(req, res) => {
      const id = req.params.id;
      const query = {_id : new ObjectId(id)};
      const updatedInfo = req.body;
      const option = {upsert : true};
      const update = {
        $set: {
          packageName : updatedInfo.pName,
          price: updatedInfo.pPrice
        }
      }
      const result =  await PackageListDB.updateOne(query, update, option);
      res.send(result);
    })
    app.delete('/pack/:id', async(req, res) => {
      const id = req.params.id;
      const condition = {_id: new ObjectId(id)};
      const result = await PackageListDB.deleteOne(condition);
      res.send(result)
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);






app.listen(port, () => {
    console.log("The Server Is running...")
    
});