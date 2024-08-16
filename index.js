const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const multer = require("multer");
const { initializeApp, cert } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
} = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");
const key = require("./firebase.json");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database"); // Import for Realtime Database


initializeApp({
  credential: cert(key),
  storageBucket: "node401app.appspot.com",
  databaseURL: "https://node401app-default-rtdb.firebaseio.com",
});

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const bucket = getStorage().bucket();
const auth = getAuth();

const app = express();
const port = 3020;
const rtdb = getDatabase(); // Realtime Database

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
    const postsSnapshot = await db
      .collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .get();

    const posts = postsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

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
app.get("/about", (req, res) => {
  res.render("about", { user: req.session.user });
});

app.post("/signupsubmit", async (req, res) => {
  const uname = req.body.uname;
  const email = req.body.email;
  const password = req.body.password;
  const locationInput = req.body.location;
  const cpass = req.body.cpass;

  // Sanitize and normalize the location input
  const location = locationInput.trim();  // Remove any leading/trailing whitespace
  const cleanedLocation = location.normalize('NFKC');  // Normalize to avoid special characters

  if (password !== cpass) {
    return res.status(400).send("Passwords do not match");
  }

  try {
    const userRecord = await auth.createUser({
      email: email,
      password: password,
      displayName: uname,
    });

    await db
      .collection("Cities")
      .doc(cleanedLocation)  // Use the cleaned location
      .collection("Residents")
      .doc(userRecord.uid)
      .set({
        UserName: uname,
        Email: email,
        Location: cleanedLocation,  // Store the cleaned location
        Image: null,
        initialized: true, 
      });

    // Redirect to signin page after successful signup
    res.redirect("/signin");
  } catch (error) {
    console.error("Error signing up:", error.message);
    res.status(500).send(`Error signing up: ${error.message}`);
  }
});

app.get("/signin", (req, res) => {
  res.render("signin");
});

app.post("/signinsubmit", async (req, res) => {
  const email = req.body.email;

  try {
    // Authenticate the user via Firebase Authentication
    const userRecord = await auth.getUserByEmail(email);
    const uid = userRecord.uid;

    // Fetch all city documents
    const citiesSnapshot = await db.collection("Cities").get();
    
    if (citiesSnapshot.empty) {
      console.log("No cities found in the database.");
      return res.status(400).send("No cities found.");
    }

    let location = null;

    for (const cityDoc of citiesSnapshot.docs) {
      try {
        let cityName = cityDoc.id.trim(); // Trim any whitespace

        console.log(`Checking city: ${cityName}`); // Log the city being checked

        const residentDocRef = cityDoc.ref.collection("Residents").doc(uid);
        const residentDoc = await residentDocRef.get();

        if (residentDoc.exists) {
          const residentData = residentDoc.data();
          
          if (residentData.initialized) { // Check if the user data is initialized
            location = cityName;
            console.log(`Found user in city: ${location}`); // Log when the user is found
            break;
          } else {
            console.log(`User data not initialized in city: ${cityName}`);
          }
        } else {
          console.log(`User not found in city: ${cityName}`); // Log if not found
        }
      } catch (err) {
        console.error(`Error checking city ${cityDoc.id}:`, err.message);
      }
    }

    if (!location) {
      console.log("User not found in any city or data not initialized.");
      return res.status(400).send("You are not a registered user in any city or your data is not initialized.");
    }

    // Create a session and redirect to home2
    req.session.user = {
      uid: userRecord.uid,
      name: userRecord.displayName,
      email: userRecord.email,
      location: location,
    };

    res.redirect("/home2");
  } catch (error) {
    console.error("Error signing in:", error);

    // Handle Firebase Authentication errors
    if (error.code === "auth/user-not-found") {
      return res.status(400).send("User not found.");
    }

    res.status(401).send("Unauthorized");
  }
});




app.get("/compose", isAuthenticated, (req, res) => {
  res.render("compose", { user: req.session.user.name });
});

app.post(
  "/compose",
  isAuthenticated,
  upload.single("image"),
  async (req, res) => {
    const title = req.body.blogtitle || "Untitled"; // Provide default title if not present
    const content = req.body.blogpost; // Ensure this field is properly populated
    const category = req.body.category || "Uncategorized"; // Provide a default value if category is undefined
    const location = req.session.user.location; // Get location from session
    const authorId = req.session.user.uid;
    const authorName = req.session.user.name;
    const image = req.file;

    if (!content) {
      return res
        .status(400)
        .send("Content cannot be empty. Please provide a valid blog post.");
    }

    let imageURL = null;

    if (image) {
      const storageRef = bucket.file(
        `images/${Date.now()}_${image.originalname}`
      );

      try {
        await storageRef.save(image.buffer);
        imageURL = `https://firebasestorage.googleapis.com/v0/b/${
          bucket.name
        }/o/${encodeURIComponent(storageRef.name)}?alt=media`;
      } catch (error) {
        console.error("Error uploading image:", error.message);
        return res
          .status(500)
          .send("Error uploading image. Please try again later.");
      }
    }

    try {
      await db
        .collection("Cities")
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
      console.error("Error posting:", error.message);
      res.status(500).send("Error posting. Please try again later.");
    }
  }
);

app.get("/post", isAuthenticated, async (req, res) => {
  const location = req.session.user.location; // Get location from session

  try {
    // Query the posts from the user's location
    const postsSnapshot = await db
      .collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .get();

    // Map the posts to include their ID
    const posts = postsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Render the posts with the user's information
    res.render("post", { posts, user: req.session.user });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).send("Error fetching posts. Please try again later.");
  }
});

// Route to render a specific post
app.get("/post/:id", isAuthenticated, async (req, res) => {
  const postId = req.params.id;
  console.log("Fetching post with ID:", postId); // Debugging line
  try {
    const postDoc = await db
      .collection("Cities")
      .doc(req.session.user.location)
      .collection("UnityThread")
      .doc(postId)
      .get();

    if (!postDoc.exists) {
      return res.status(404).send("Post not found");
    }

    const post = postDoc.data();
    const voicesSnapshot = await db
      .collection("Cities")
      .doc(req.session.user.location)
      .collection("UnityThread")
      .doc(postId)
      .collection("NeighbourVoices")
      .get();
    const formattedTime = post.Time.toDate().toLocaleString();


    const voices = voicesSnapshot.docs.map((doc) => doc.data());

    res.render("postpage", { post: { id: postId, ...post ,Time: formattedTime}, voices, user: req.session.user });
  } catch (error) {
    console.error("Error fetching post:", error);
    res.status(500).send("Error fetching post. Please try again later.");
  }
});

// Route to handle adding a new comment (voice) to a post
app.post("/post/:id/NeighbourVoices", isAuthenticated, async (req, res) => {
  const postId = req.params.id;
  const location = req.session.user.location;
  const userId = req.session.user.uid;
  const userName = req.session.user.name;
  const voice = req.body.voice;

  if (!voice || voice.trim() === "") {
    return res.status(400).send("Voice cannot be empty");
  }

  try {
    // Reference to the specific post's NeighbourVoices collection
    const voicesRef = db
      .collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .doc(postId)
      .collection("NeighbourVoices");

    // Add the new comment (voice) to the collection
    await voicesRef.add({
      AuthorId: userId,
      AuthorName: userName,
      Voice: voice,
      Timestamp: new Date(),
    });

    // Redirect back to the post page
    res.redirect(`/post/${postId}`);
  } catch (error) {
    console.error("Error adding comment:", error.message);
    res.status(500).send("Error adding comment. Please try again later.");
  }
});



app.get("/chat", isAuthenticated, (req, res) => {
  res.render("chat", { user: req.session.user });
});

app.post("/chat", isAuthenticated, async (req, res) => {
  const location = req.session.user.location;
  const userName = req.session.user.name;
  const message = req.body.message;

  if (!message || message.trim() === "") {
    return res.status(400).send("Message cannot be empty");
  }

  try {
    const newMessageRef = rtdb.ref(`Cities/${location}/Chats`).push(); // Use rtdb here
    await newMessageRef.set({
      userName: userName,
      message: message,
      timestamp: new Date().toISOString(),
    });

    res.status(200).send("Message sent successfully");
  } catch (error) {
    console.error("Error sending message:", error.message);
    res.status(500).send("Error sending message. Please try again later.");
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


app.get("/delete/:id",isAuthenticated,async(req,res)=>{
  const postId=req.params.id;
  if (!postId) {
    return res.status(400).send("Invalid post ID");
  }

  const location = req.session.user.location;

  try{
    const postRef= db.collection("Cities")
                  .doc(location)
                  .collection("UnityThread")
                  .doc(postId);
    
    const postDoc = await postRef.get();
    if(!postDoc.exists){
      return res.status(404).send("Thread not Found");
    }

    await postRef.delete();

    res.redirect("/post");
  }catch(error){
    console.log("Error deleting post:", error);
    res.status(500).send("Error deleting post. Please try again later.");
  }
});
app.get('/share/:id', (req, res) => {
  const postId = req.params.id;
  res.redirect('/post/' + postId);
});


app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
