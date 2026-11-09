/**
 * server.js — Viaara backend
 *
 * Local dev:   node server.js  (or: npm run dev with nodemon)
 * Production:  node server.js  (same command — env vars control DB and storage)
 *
 * Environment:
 *   Copy .env.example → .env and fill in values before first run.
 *   Run migrations first: node db/migrate.js
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

// ── App setup ─────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────
// Serve the public HTML files
app.use(express.static(path.join(__dirname, 'public')));

// Serve local uploads (only used when STORAGE=local)
const uploadDir = path.resolve(process.env.LOCAL_UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// ── API routes ────────────────────────────────────────────────
app.use('/api/trips',     require('./routes/trips'));
app.use('/api/leads',     require('./routes/leads'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/upload',    require('./routes/upload'));

// ── Admin auth ────────────────────────────────────────────────
// Simple credential check — matches what the HTML already uses.
// In production, harden this with JWT and HTTPS.
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === (process.env.ADMIN_USERNAME || 'admin') &&
    password === (process.env.ADMIN_PASSWORD || 'viaara2024')
  ) {
    res.json({ ok: true, token: 'viaara_admin_session' });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ── Cron — instance auto-creation ────────────────────────────
// Runs on startup (retroactive) + daily at 00:05
const { startCron } = require('./lib/cron');
startCron();

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env:    process.env.NODE_ENV || 'development',
    db:     process.env.DB_CLIENT || 'sqlite',
    storage: process.env.STORAGE || 'local',
    ts:     new Date().toISOString(),
  });
});

// ── Fallback: serve index.html for any non-API route ─────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Viaara server running at http://localhost:${PORT}`);
  console.log(`   DB:      ${process.env.DB_CLIENT || 'sqlite'}`);
  console.log(`   Storage: ${process.env.STORAGE || 'local'}`);
  console.log(`   Env:     ${process.env.NODE_ENV || 'development'}\n`);
});
