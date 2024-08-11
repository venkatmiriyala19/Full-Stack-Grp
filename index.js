const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const port = 3020;

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
var key = require("./firebase.json");

initializeApp({
  credential: cert(key),
});
const db = getFirestore();

app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.render("home");
});

app.set("view engine", "ejs");

app.get("/signup", (req, res) => {
  res.render("signup");
});

const axios = require("axios");

app.use(express.static("public"));

const bcrypt = require("bcryptjs");

app.post("/signupsubmit", async (req, res) => {
  const uname = req.body.uname;
  const email = req.body.email;
  const password = req.body.password;
  const cpass = req.body.cpass;

  if (password !== cpass) {
    return res.status(400).send("Passwords do not match");
  }

  try {
    const userSnapshot = await db
      .collection("users")
      .where("email", "==", email)
      .get();
    if (!userSnapshot.empty) {
      return res.status(400).send("User already exists with this email");
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10); // 10 is the saltRounds

    // Add the user to the database
    await db.collection("users").add({
      name: uname,
      email: email,
      password: hashedPassword, // Store hashed password
    });
    res.render("signin");
  } catch (error) {
    console.error("Error adding user:", error);
    res.status(500).send("Error signing up. Please try again later.");
  }
});
app.get("/signin", (req, res) => {
  res.render("signin");
});

app.post("/signinsubmit", async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  try {
    // Check if a user with this email exists
    const userSnapshot = await db
      .collection("users")
      .where("email", "==", email)
      .get();
    if (userSnapshot.empty) {
      return res.send("Login failed: User not found");
    }

    // Retrieve the user data
    const userData = userSnapshot.docs[0].data();

    // Compare hashed passwords
    const isPasswordMatch = await bcrypt.compare(password, userData.password);

    if (isPasswordMatch) {
      // Passwords match, authentication successful
      res.render("index");
    } else {
      // Passwords do not match
      res.send("Login failed: Incorrect password");
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
