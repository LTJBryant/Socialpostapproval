const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Setup OpenAI
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// DB setup
const dbFile = './data.sqlite';
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, password TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY, caption TEXT, mediaPath TEXT, approved INTEGER DEFAULT 0, comments TEXT DEFAULT ''
  )`);
  // Insert demo user (username: admin, password: admin)
  db.get("SELECT * FROM users WHERE username = ?", ['admin'], (err, row) => {
    if (!row) db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['admin', 'admin']);
  });
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'secretkey123', resave: false, saveUninitialized: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

function sendNotification(subject, text) {
  transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject,
    text
  });
}

// Auth middleware
function checkAuth(req, res, next) {
  if (req.session.user) next();
  else res.redirect('/login');
}

// Routes

// Login
app.get('/login', (req, res) => {
  res.send(`
  <h2>Login</h2>
  <form method="POST" action="/login">
    <input name="username" placeholder="Username" required/><br/>
    <input type="password" name="password" placeholder="Password" required/><br/>
    <button type="submit">Login</button>
  </form>
  `);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
    if (user) {
      req.session.user = user;
      res.redirect('/approval');
    } else {
      res.send('Invalid credentials. <a href="/login">Try again</a>');
    }
  });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Page 1: Post approval list
app.get('/approval', checkAuth, (req, res) => {
  db.all("SELECT * FROM posts WHERE approved = 0", (err, rows) => {
    let html = `<h2>Post Approval</h2><a href="/logout">Logout</a><br><a href="/caption-generator">Go to Caption Generator</a><br><br>`;
    if (rows.length === 0) html += 'No posts awaiting approval.';
    else {
      rows.forEach(post => {
        html += `
          <div style="border:1px solid #ccc; padding:10px; margin-bottom:10px;">
            <video src="/${post.mediaPath}" controls style="max-width:300px;"></video><br/>
            <b>Caption:</b> ${post.caption}<br/>
            <form method="POST" action="/approve" style="display:inline;">
              <input type="hidden" name="postId" value="${post.id}"/>
              <button type="submit">Approve</button>
            </form>
            <button onclick="document.getElementById('commentForm${post.id}').style.display='block'">Comment</button>
            <div id="commentForm${post.id}" style="display:none;">
              <form method="POST" action="/comment">
                <input type="hidden" name="postId" value="${post.id}"/>
                <textarea name="comment" placeholder="Write your comment here" required></textarea><br/>
                <button type="submit">Submit Comment</button>
              </form>
            </div>
          </div>
        `;
      });
    }
    res.send(html);
  });
});

// Approve post
app.post('/approve', checkAuth, (req, res) => {
  const postId = req.body.postId;
  db.run("UPDATE posts SET approved = 1 WHERE id = ?", [postId], err => {
    if (!err) {
      sendNotification('Post Approved', `Post ID ${postId} was approved by user.`);
      res.redirect('/approval');
    } else {
      res.send('Error approving post.');
    }
  });
});

// Comment on post
app.post('/comment', checkAuth, (req, res) => {
  const { postId, comment } = req.body;
  db.get("SELECT comments FROM posts WHERE id = ?", [postId], (err, row) => {
    let updatedComments = row.comments ? row.comments + '\n' + comment : comment;
    db.run("UPDATE posts SET comments = ? WHERE id = ?", [updatedComments, postId], err2 => {
      if (!err2) {
        sendNotification('New Comment on Post', `Post ID ${postId} received comment:\n${comment}`);
        res.redirect('/approval');
      } else {
        res.send('Error saving comment.');
      }
    });
  });
});

// Page 2: Caption generator
app.get('/caption-generator', checkAuth, (req, res) => {
  res.send(`
    <h2>Caption Generator</h2><a href="/approval">Back to Post Approval</a><br><a href="/logout">Logout</a>
    <form id="genForm" method="POST" action="/generate-caption" enctype="multipart/form-data">
      <label>Upload Video/Photo: <input type="file" name="media" accept="image/*,video/*" required></label><br><br>
      <label>Enter text prompt (optional):<br><textarea name="prompt" rows="4" cols="40" placeholder="Describe the video/photo or add details..."></textarea></label><br><br>
      <button type="submit">Generate Caption</button>
    </form>
    <div id="result"></div>
    <script>
      const form = document.getElementById('genForm');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const formData = new FormData(form);
        const res = await fetch('/generate-caption', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        document.getElementById('result').innerText = data.caption || 'Error generating caption';
      };
    </script>
  `);
});

app.post('/generate-caption', checkAuth, upload.single('media'), async (req, res) => {
  try {
    const promptText = req.body.prompt || '';
    const mediaPath = req.file ? req.file.path : null;

    // Create a prompt for OpenAI - you can customize this to fit your niche
    const openAiPrompt = `Create a clear, concise social media caption optimized for engagement in the electrical services niche. Context: ${promptText}`;

    // Call OpenAI API
    const completion = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: openAiPrompt,
      max_tokens: 50,
      temperature: 0.7,
    });

    const caption = completion.data.choices[0].text.trim();

    // Save the post to DB for approval later
    if (mediaPath) {
      db.run("INSERT INTO posts (caption, mediaPath) VALUES (?, ?)", [caption, mediaPath]);
    }

    res.json({ caption });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate caption' });
  }
});

app.listen(port, () => {
  if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
  console.log(`Server running on http://localhost:${port}`);
});
