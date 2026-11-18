/**
 * lib/auth.js — session-based admin authentication
 */

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const isProd = () => process.env.NODE_ENV === 'production';

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Compare via fixed-length digests so length differences don't leak timing.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again later.' },
});

// Limits unauthenticated public write endpoints (lead form, analytics beacons).
const publicWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

const router = express.Router();

router.post('/login', loginLimiter, (req, res, next) => {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) {
    return res.status(500).json({ error: 'Admin credentials are not configured' });
  }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username.length > 256 || password.length > 1024) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const ok = safeEqual(username, expectedUser) && safeEqual(password, expectedPass);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  // Regenerate to prevent session fixation.
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.save(err2 => {
      if (err2) return next(err2);
      res.json({ ok: true });
    });
  });
});

router.get('/me', (req, res) => {
  if (req.session && req.session.isAdmin === true) {
    return res.json({ authenticated: true, username: process.env.ADMIN_USERNAME });
  }
  res.status(401).json({ authenticated: false });
});

router.post('/logout', (req, res, next) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('viaara.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd(),
    });
    res.json({ ok: true });
  });
});

module.exports = { requireAdmin, publicWriteLimiter, authRouter: router };
