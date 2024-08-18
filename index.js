require("dotenv").config(); // Add this line to load .env variables
const express = require("express");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

// Initialize Firebase
const firebaseConfig = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

initializeApp({
  credential: cert(firebaseConfig),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = getFirestore();
const bucket = getStorage().bucket();
const auth = getAuth();
const rtdb = getDatabase();

const app = express();
const port = 3020; // Realtime Database

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser()); // Middleware for handling cookies

const SECRET_KEY = process.env.JWT_SECRET || "your_jwt_secret_key1234"; // Replace with a strong secret key

function authenticateToken(req, res, next) {
  const token = req.cookies["auth-token"];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

app.set("views", __dirname + "/views");
app.set("view engine", "ejs");
app.use(express.static(__dirname + "/public"));

// Initialize multer for file upload handling
const storage = multer.memoryStorage(); // Use memory storage for file uploads
const upload = multer({ storage: storage });

// Routes

// Home route
app.get("/", (req, res) => {
  res.render("home");
});

// Authenticated home route
app.get("/home2", authenticateToken, async (req, res) => {
  const location = req.user.location;

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

    res.render("home2", { user: req.user, posts });
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
  res.render("about", { user: req.user });
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

    await db
      .collection("Cities")
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

app.get("/signin", (req, res) => {
  res.render("signin");
});

app.post("/signinsubmit", async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  try {
    const userRecord = await auth.getUserByEmail(email);
    const uid = userRecord.uid;

    const citiesSnapshot = await db.collection("Cities").get();

    let location = null;
    for (const cityDoc of citiesSnapshot.docs) {
      const residentDoc = await cityDoc.ref
        .collection("Residents")
        .doc(uid)
        .get();
      if (residentDoc.exists) {
        location = cityDoc.id; // The city name is the document ID
        break;
      }
    }

    if (!location) {
      return res.status(400).send("You are not a registered user in any city.");
    }

    // Generate JWT token
    const accessToken = jwt.sign(
      { uid, name: userRecord.displayName, email: userRecord.email, location },
      SECRET_KEY,
      { expiresIn: "1d" }
    );
    res.cookie("auth-token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24, // Token expiration time (e.g., 1 day)
    });

    res.redirect("/home2");
  } catch (error) {
    console.error("Error signing in:", error);

    if (error.code === "auth/user-not-found") {
      return res
        .status(400)
        .send(
          "Either your location is incorrect, or you are not a registered user."
        );
    }

    res.status(401).send("Unauthorized");
  }
});

app.get("/compose", authenticateToken, (req, res) => {
  res.render("compose", { user: req.user.name });
});

app.post(
  "/compose",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    const title = req.body.blogtitle || "Untitled"; // Provide default title if not present
    const content = req.body.blogpost; // Ensure this field is properly populated
    const category = req.body.category || "Uncategorized"; // Provide a default value if category is undefined
    const location = req.user.location; // Get location from session
    const authorId = req.user.uid;
    const authorName = req.user.name;
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

app.get("/post", authenticateToken, async (req, res) => {
  const location = req.user.location; // Get location from session

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
    res.render("post", { posts, user: req.user });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).send("Error fetching posts. Please try again later.");
  }
});

// Route to render a specific post
app.get("/post/:id", authenticateToken, async (req, res) => {
  const postId = req.params.id;
  try {
    const postDoc = await db
      .collection("Cities")
      .doc(req.user.location)
      .collection("UnityThread")
      .doc(postId)
      .get();

    if (!postDoc.exists) {
      return res.status(404).send("Post not found");
    }

    const post = postDoc.data();
    const voicesSnapshot = await db
      .collection("Cities")
      .doc(req.user.location)
      .collection("UnityThread")
      .doc(postId)
      .collection("NeighbourVoices")
      .get();
    const formattedTime = post.Time.toDate().toLocaleString();

    const voices = voicesSnapshot.docs.map((doc) => doc.data());

    res.render("postpage", {
      post: { id: postId, ...post, Time: formattedTime },
      voices,
      user: req.user,
    });
  } catch (error) {
    console.error("Error fetching post:", error);
    res.status(500).send("Error fetching post. Please try again later.");
  }
});

// Route to handle adding a new comment (voice) to a post
app.post("/post/:id/NeighbourVoices", authenticateToken, async (req, res) => {
  const postId = req.params.id;
  const location = req.user.location;
  const userId = req.user.uid;
  const userName = req.user.name;
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

app.get("/chat", authenticateToken, (req, res) => {
  res.render("chat", { user: req.user });
});

app.post("/chat", authenticateToken, async (req, res) => {
  const location = req.user.location;
  const userName = req.user.name;
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
  req.destroy((err) => {
    if (err) {
      return res.status(500).send("Error signing out. Please try again later.");
    }
    res.redirect("/signin");
  });
});

app.get("/delete/:id", authenticateToken, async (req, res) => {
  const postId = req.params.id;
  if (!postId) {
    return res.status(400).send("Invalid post ID");
  }

  const location = req.user.location;

  try {
    const postRef = db
      .collection("Cities")
      .doc(location)
      .collection("UnityThread")
      .doc(postId);

    const postDoc = await postRef.get();
    if (!postDoc.exists) {
      return res.status(404).send("Thread not Found");
    }

    await postRef.delete();

    res.redirect("/post");
  } catch (error) {
    console.log("Error deleting post:", error);
    res.status(500).send("Error deleting post. Please try again later.");
  }
});
app.get("/share/:id", (req, res) => {
  const postId = req.params.id;
  res.redirect("/post/" + postId);
});

app.get("/clubs", authenticateToken, async (req, res) => {
  const location = req.user.location; // Get location from session

  try {
    // Query the clubs from the user's location
    const clubsSnapshot = await db
      .collection("Cities")
      .doc(location)
      .collection("Clubs")
      .get();

    // Map the clubs to include their ID
    const clubs = clubsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Render the clubs with the user's information
    res.render("clubs", { clubs, user: req.user });
  } catch (error) {
    console.error("Error fetching clubs:", error);
    res.status(500).send("Error fetching clubs. Please try again later.");
  }
});

// Route to display details of a specific club
app.get("/clubs/:id", authenticateToken, async (req, res) => {
  const clubId = req.params.id; // Club document ID
  const userId = req.user.uid; // User ID
  const location = req.user.location; // Location from session

  try {
    // Query the specific club by its ID
    const clubDoc = await db
      .collection("Cities")
      .doc(location)
      .collection("Clubs")
      .doc(clubId)
      .get();

    if (!clubDoc.exists) {
      return res.status(404).send("Club not found");
    }

    // Check if the user has already joined this club
    const joinedClubDoc = await db
      .collection("Cities")
      .doc(location)
      .collection("Residents")
      .doc(userId)
      .collection("JoinedClubs")
      .doc(clubId)
      .get();

    const hasJoined = joinedClubDoc.exists;

    const club = { id: clubDoc.id, ...clubDoc.data() };

    // Pass the `hasJoined` status to the template
    res.render("clubDetails", { club, user: req.user, hasJoined });
  } catch (error) {
    console.error("Error fetching club details:", error);
    res
      .status(500)
      .send("Error fetching club details. Please try again later.");
  }
});

app.post("/clubs/join/:id", authenticateToken, async (req, res) => {
  const clubId = req.params.id;
  const userId = req.user.uid;
  const location = req.user.location; // Get location from session

  try {
    // Reference to the user's JoinedClubs collection
    const joinedClubsRef = db
      .collection("Cities")
      .doc(location)
      .collection("Residents")
      .doc(userId)
      .collection("JoinedClubs");

    // Check if the user is already a member of the club
    const clubSnapshot = await joinedClubsRef.doc(clubId).get();
    if (clubSnapshot.exists) {
      return res.status(400).send("You are already a member of this club.");
    }

    // Add the club ID to the user's JoinedClubs subcollection
    await joinedClubsRef.doc(clubId).set({
      joinedAt: new Date(),
    });

    // Increment the MembersCount in the club document
    const clubRef = db
      .collection("Cities")
      .doc(location)
      .collection("Clubs")
      .doc(clubId);

    await clubRef.update({
      MembersCount: admin.firestore.FieldValue.increment(1),
    });

    res.redirect(`/clubs/${clubId}`); // Redirect back to the club details page
  } catch (error) {
    console.error("Error joining club:", error);
    res.status(500).send("Error joining club. Please try again later.");
  }
});

// Route to display the form for creating a new club
app.get("/createClub", authenticateToken, (req, res) => {
  res.render("createClub", { user: req.user });
});

// Route to handle the form submission for creating a new club
app.post(
  "/createClub",
  authenticateToken,
  upload.fields([
    { name: "clubBanner" },
    { name: "clubProfileImage", maxCount: 1 },
  ]),
  async (req, res) => {
    const { clubName, clubDescription, clubLocation, clubTimings } = req.body;
    const location = req.user.location; // Use user's city

    // Check that the club profile image is provided
    if (!req.files || !req.files.clubProfileImage) {
      return res.status(400).send("Club Profile Image is required.");
    }

    try {
      const clubProfileImage = req.files.clubProfileImage[0];
      const clubBanner = req.files.clubBanner ? req.files.clubBanner[0] : null;

      // Upload club profile image
      const profileImageRef = bucket.file(
        `images/${Date.now()}_${clubProfileImage.originalname}`
      );
      await profileImageRef.save(clubProfileImage.buffer);
      const clubProfileImageURL = `https://firebasestorage.googleapis.com/v0/b/${
        bucket.name
      }/o/${encodeURIComponent(profileImageRef.name)}?alt=media`;

      // Upload club banner image if provided
      let clubBannerURL = null;
      if (clubBanner) {
        const bannerRef = bucket.file(
          `images/${Date.now()}_${clubBanner.originalname}`
        );
        await bannerRef.save(clubBanner.buffer);
        clubBannerURL = `https://firebasestorage.googleapis.com/v0/b/${
          bucket.name
        }/o/${encodeURIComponent(bannerRef.name)}?alt=media`;
      }

      // Save club details to Firestore
      await db.collection("Cities").doc(location).collection("Clubs").add({
        ClubName: clubName,
        ClubDescription: clubDescription,
        ClubLocation: clubLocation,
        ClubTimings: clubTimings,
        ClubBanner: clubBannerURL,
        ClubProfileImage: clubProfileImageURL,
      });

      res.redirect("/clubs");
    } catch (error) {
      console.error("Error creating club:", error);
      res.status(500).send("Error creating club. Please try again later.");
    }
  }
);

// Route to render club chat page
app.get("/clubs/:id/chat", authenticateToken, async (req, res) => {
  const clubId = req.params.id;
  const location = req.user.location;

  try {
    // Fetch club details
    const clubDoc = await db
      .collection("Cities")
      .doc(location)
      .collection("Clubs")
      .doc(clubId)
      .get();

    if (!clubDoc.exists) {
      return res.status(404).send("Club not found");
    }

    const club = { id: clubDoc.id, ...clubDoc.data() };
    // Fetch chat messages
    const messagesSnapshot = await rtdb
      .ref(`Cities/${location}/Clubs/${clubId}/Chat`)
      .once("value");
    const messages = messagesSnapshot.val() || {};

    // Convert messages object to array and sort by timestamp
    const sortedMessages = Object.entries(messages)
      .map(([id, message]) => ({
        id,
        ...message,
      }))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Render the club chat page with messages
    res.render("clubChat", {
      club,
      user: req.user,
      messages: sortedMessages,
    });
  } catch (error) {
    console.error("Error fetching club details:", error);
    res
      .status(500)
      .send("Error fetching club details. Please try again later.");
  }
});

// Route to handle sending a message in the club chat
app.post("/clubs/:id/chat", authenticateToken, async (req, res) => {
  const clubId = req.params.id;
  const location = req.user.location;
  const userName = req.user.name;
  const message = req.body.message;

  if (!message || message.trim() === "") {
    return res.status(400).send("Message cannot be empty");
  }

  try {
    const chatRef = rtdb.ref(`Cities/${location}/Clubs/${clubId}/Chat`);
    await chatRef.push({
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

app.listen(port, () => {
  console.log(`App listening on port http://localhost:${port}/`);
});
