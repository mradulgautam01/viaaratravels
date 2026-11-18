/**
 * routes/leads.js — Leads / enquiry management
 */

const express = require('express');
const db = require('../db/db');

const { requireAdmin, publicWriteLimiter } = require('../lib/auth');

const router = express.Router();

const LIMITS = { name: 100, phone: 20, email: 254, trip: 200, tripId: 64, instanceId: 64, message: 2000 };
const LEAD_STATUSES = ['New', 'Contacted', 'Converted', 'Closed'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-()\s.]{6,20}$/;

function sendServerError(res, action, err) {
  console.error(`[leads] Failed to ${action}:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// Optional text field: absent/empty -> '', otherwise must be a string within maxLen.
// Returns { value } or { error }.
function optionalText(raw, field) {
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string') return { error: `${field} must be text` };
  const value = raw.trim();
  if (value.length > LIMITS[field]) return { error: `${field} is too long` };
  return { value };
}

// ── GET /api/leads ─────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const leads = await db('leads').orderBy('created_at', 'desc');
    res.json(leads);
  } catch (err) {
    sendServerError(res, 'list leads', err);
  }
});

// ── GET /api/leads/count/new — badge count ───────────────────
router.get('/count/new', requireAdmin, async (req, res) => {
  try {
    const [{ count }] = await db('leads').where({ status: 'New' }).count('id as count');
    res.json({ count: parseInt(count) });
  } catch (err) {
    sendServerError(res, 'count new leads', err);
  }
});

// ── POST /api/leads — submit enquiry (from public site) ───────
router.post('/', publicWriteLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    if (typeof body.name !== 'string' || typeof body.phone !== 'string') {
      return res.status(400).json({ error: 'Name and phone required' });
    }
    const name  = body.name.trim();
    const phone = body.phone.trim();
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    if (name.length > LIMITS.name) return res.status(400).json({ error: 'Name is too long' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Invalid phone number' });

    const fields = {};
    for (const f of ['email', 'trip', 'tripId', 'instanceId', 'message']) {
      const r = optionalText(body[f], f);
      if (r.error) return res.status(400).json({ error: r.error });
      fields[f] = r.value;
    }
    if (fields.email && !EMAIL_RE.test(fields.email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    await db('leads').insert({
      name,
      phone,
      email:      fields.email,
      trip:       fields.trip,
      tripId:     fields.tripId || null,
      instanceId: fields.instanceId || null,
      message:    fields.message || 'Requested quote via website',
      status:     'New',
      date:       new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    sendServerError(res, 'create lead', err);
  }
});

// ── PUT /api/leads/:id — update status ────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'status') {
    return res.status(400).json({ error: 'Only status can be updated' });
  }
  if (typeof body.status !== 'string' || !LEAD_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const updated = await db('leads').where({ id: req.params.id }).update({
      status: body.status,
      updated_at: db.fn.now(),
    });
    if (!updated) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, 'update lead', err);
  }
});

// ── DELETE /api/leads/:id ─────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db('leads').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, 'delete lead', err);
  }
});

module.exports = router;
