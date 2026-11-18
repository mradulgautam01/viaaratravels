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
const path    = require('path');
const fs      = require('fs');
const session = require('express-session');
const { requireAdmin, authRouter } = require('./lib/auth');
const db = require('./db/db');
const KnexSessionStore = require('./lib/sessionStore');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// ── Required secrets ──────────────────────────────────────────
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set in .env (min 32 chars). Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error('ADMIN_USERNAME and ADMIN_PASSWORD must be set in .env');
  process.exit(1);
}

// ── App setup ─────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Behind a reverse proxy (nginx/ALB) in production, so Secure cookies and client IPs work.
if (isProd) app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────
// Serve the public HTML files
app.use(express.static(path.join(__dirname, 'public')));

// Serve local uploads (only used when STORAGE=local)
const uploadDir = path.resolve(process.env.LOCAL_UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// ── Sessions ──────────────────────────────────────────────────
// Persistent store on the existing Knex database (table: app_sessions).
const sessionStore = new KnexSessionStore(db, { ttlMs: SESSION_TTL_MS });
app.use(session({
  store: sessionStore,
  name: 'viaara.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd, // requires HTTPS in production
    maxAge: SESSION_TTL_MS,
  },
}));

// ── API routes ────────────────────────────────────────────────
// Per-route authorization is applied inside each router.
app.use('/api/auth',      authRouter);
app.use('/api/trips',     require('./routes/trips'));
app.use('/api/leads',     require('./routes/leads'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/upload',    requireAdmin, require('./routes/upload'));

// ── Cron — instance auto-creation ────────────────────────────
// Runs on startup (retroactive) + daily at 00:05; started after the session store is ready.
const { startCron } = require('./lib/cron');

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
sessionStore.init().then(() => {
  startCron();
  app.listen(PORT, () => {
    console.log(`\n🚀 Viaara server running at http://localhost:${PORT}`);
    console.log(`   DB:      ${process.env.DB_CLIENT || 'sqlite'}`);
    console.log(`   Storage: ${process.env.STORAGE || 'local'}`);
    console.log(`   Env:     ${process.env.NODE_ENV || 'development'}\n`);
  });
}).catch(err => {
  console.error('Failed to initialise session store:', err);
  process.exit(1);
});
