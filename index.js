// Required modules
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const multer = require("multer");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");
const key = require("./firebase.json");

// Initialize Firebase Admin SDK with storageBucket
initializeApp({
  credential: cert(key),
  storageBucket: "node401app.appspot.com",
});

const db = getFirestore();
const bucket = getStorage().bucket();
const auth = getAuth();

const app = express();
const port = 3020;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); // Add this line to parse JSON requests

app.use(
  session({
    secret: "yourSecretKey", // Replace with a strong secret key
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // Set to true if using HTTPS
  })
);

app.set("view engine", "ejs");
app.use(express.static("public"));

// Initialize multer for file upload handling
const storage = multer.memoryStorage(); // Use memory storage for file uploads
const upload = multer({ storage: storage });

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  } else {
    res.redirect("/signin");
  }
}

// Routes

// Home route
app.get("/", (req, res) => {
  res.render("home");
});

// Authenticated home route
app.get("/home2", isAuthenticated, async (req, res) => {
  const location = req.session.user.location;

  try {
    const postsSnapshot = await db.collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .get();

    const posts = postsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.render("home2", { user: req.session.user, posts });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).send("Error fetching posts. Please try again later.");
  }
});

// Sign up route
app.get("/signup", (req, res) => {
  res.render("signup");
});
app.get("/about",(req,res)=>{
  res.render("about",{ user: req.session.user })
});

app.post("/signupsubmit", async (req, res) => {
  const uname = req.body.uname;
  const email = req.body.email;
  const password = req.body.password;
  const location = req.body.location;
  const cpass = req.body.cpass;

  if (password !== cpass) {
    return res.status(400).send("Passwords do not match");
  }

  try {
    const userRecord = await auth.createUser({
      email: email,
      password: password,
      displayName: uname,
    });

    await db.collection("Cities")
      .doc(location)
      .collection("Residents")
      .doc(userRecord.uid)
      .set({
        UserName: uname,
        Email: email,
        Location: location,
        Image: null,
      });

    // Redirect to signin page after successful signup
    res.redirect("/signin");
  } catch (error) {
    console.error("Error signing up:", error.message);
    res.status(500).send(`Error signing up: ${error.message}`);
  }
});

// Sign in route
app.get("/signin", (req, res) => {
  res.render("signin");
});

app.post("/signinsubmit", async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;
  const location = req.body.location.trim(); // Trim whitespace to avoid accidental errors

  if (!location || location === "") {
    return res.status(400).send("Location is required");
  }

  try {
    // Check if the user exists in Firebase Authentication
    const userRecord = await auth.getUserByEmail(email);
    const idToken = await auth.createCustomToken(userRecord.uid);

    // Check if the user exists in Firestore under the specified city and residents
    const cityDoc = await db.collection("Cities").doc(location).collection("Residents").doc(userRecord.uid).get();

    if (!cityDoc.exists) {
      // If the user is not found in the city, inform them about the issue
      return res.status(400).send("Either your location is incorrect, or you are not a registered user.");
    }

    // If the user exists in both Authentication and Firestore, create a session and redirect to home
    req.session.user = {
      uid: userRecord.uid,
      name: userRecord.displayName,
      email: userRecord.email,
      location: cityDoc.data().Location, // Include location in session
    };

    res.redirect("/home2");
  } catch (error) {
    console.error("Error signing in:", error);

    // Handle specific Firebase Authentication errors
    if (error.code === 'auth/user-not-found') {
      return res.status(400).send("Either your location is incorrect, or you are not a registered user.");
    }

    res.status(401).send("Unauthorized");
  }
});

// Compose route
app.get("/compose", isAuthenticated, (req, res) => {
  res.render("compose", { user: req.session.user.name });
});

app.post("/compose", isAuthenticated, upload.single("image"), async (req, res) => {
  const title = req.body.blogtitle;
  const content = req.body.blogpost;
  const category = req.body.category || 'Uncategorized'; // Provide a default value if category is undefined
  const location = req.session.user.location; // Get location from session
  const authorId = req.session.user.uid;
  const authorName = req.session.user.name;
  const image = req.file;

  let imageURL = null;

  if (image) {
    const storageRef = bucket.file(`images/${Date.now()}_${image.originalname}`);

    try {
      await storageRef.save(image.buffer);
      imageURL = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storageRef.name)}?alt=media`;
    } catch (error) {
      console.error("Error uploading image:", error);
      return res.status(500).send("Error uploading image. Please try again later.");
    }
  }

  try {
    await db.collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .add({
        Title: title,
        Content: content,
        Category: category,
        Image: imageURL,
        AuthorId: authorId,
        Time: new Date(),
        AuthorName: authorName,
      });

    res.redirect("/post");
  } catch (error) {
    console.error("Error posting:", error);
    res.status(500).send("Error posting. Please try again later.");
  }
});

// Posts route
app.get("/post", isAuthenticated, async (req, res) => {
  const location = req.session.user.location; // Get location from session

  try {
    // Query the posts from the user's location
    const postsSnapshot = await db.collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .get();

    // Map the posts to include their ID
    const posts = postsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Render the posts with the user's information
    res.render("post", { posts, user: req.session.user });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).send("Error fetching posts. Please try again later.");
  }
});

// Single post route
app.get("/post/:id", isAuthenticated, async (req, res) => {
  const postId = req.params.id;
  const location = req.session.user.location; // Get location from session

  try {
    // Retrieve the post from the user's location
    const postDoc = await db.collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .doc(postId)
      .get();

    if (!postDoc.exists) {
      return res.status(404).send("Post not found");
    }

    const post = postDoc.data();
    console.log("Post data:", post); 
    res.render("singlePost", { post, user: req.session.user }); // Use a new template 'singlePost.ejs'
  } catch (error) {
    console.error("Error fetching post:", error);
    res.status(500).send("Error fetching post. Please try again later.");
  }
});

// Fetch messages for a specific city

app.get("/chat",isAuthenticated, (req, res) => {
  res.render("chat", { user: req.session.user.name });
});
app.get("/chat/:city", isAuthenticated, async (req, res) => {
  const city = req.params.city;

  try {
    const messagesSnapshot = await db.collection("Cities").doc(city).collection("Chat")
      .orderBy("timestamp", "asc")
      .get();

    const messages = messagesSnapshot.docs.map(doc => doc.data());
    res.json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).send("Error fetching messages");
  }
});

// Send a message to the chat
app.post("/chat/:city", isAuthenticated, async (req, res) => {
  const city = req.params.city;
  const { text } = req.body;
  const sender = req.session.user.name;

  if (!text) {
    return res.status(400).send("Message text is required");
  }

  try {
    await db.collection("Cities").doc(city).collection("Chat").add({
      sender: sender,
      text: text,
      timestamp: new Date(),
    });

    res.status(200).send("Message sent");
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).send("Error sending message");
  }
});


// Sign out route
app.post("/signout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("Error signing out. Please try again later.");
    }
    res.redirect("/signin");
  });
});

// Start the server
app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
