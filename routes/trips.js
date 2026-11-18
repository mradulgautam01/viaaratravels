/**
 * routes/trips.js — CRUD for trips and trip instances
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getPrefixForTrip, templateId } = require('../lib/tripId');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────
const JSON_COLS = ['destinations','departureCities','itinerary','inclusions','exclusions','tags','images','dates'];
const JSON_OBJ_COLS = ['dateSeats']; // object (not array) JSON cols

function serialize(trip) {
  const t = { ...trip };
  JSON_COLS.forEach(col => {
    if (typeof t[col] === 'string') {
      try { t[col] = JSON.parse(t[col]); } catch { t[col] = []; }
    }
    if (!t[col]) t[col] = [];
  });
  JSON_OBJ_COLS.forEach(col => {
    if (typeof t[col] === 'string') {
      try { t[col] = JSON.parse(t[col]); } catch { t[col] = {}; }
    }
    if (!t[col]) t[col] = {};
  });
  // Rename inclusions → included so the frontend field name matches
  t.included = t.inclusions || [];
  delete t.inclusions;
  t.special = !!t.special;
  t.displayTripId = t.tripId || templateId(t.prefix || getPrefixForTrip(t));
  return t;
}

function deserialize(body) {
  const t = { ...body };
  // Rename included → inclusions for the DB column
  if (t.included !== undefined) { t.inclusions = t.included; delete t.included; }
  JSON_COLS.forEach(col => {
    if (Array.isArray(t[col])) t[col] = JSON.stringify(t[col]);
  });
  JSON_OBJ_COLS.forEach(col => {
    if (t[col] && typeof t[col] === 'object') t[col] = JSON.stringify(t[col]);
  });
  return t;
}

// Logs full details server-side; clients only get a generic message.
function sendServerError(res, action, err) {
  console.error(`[trips] Failed to ${action}:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// Compares two destinations values (array or JSON string) by content.
function sameDestinations(a, b) {
  const norm = v => {
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { return v; }
    }
    return JSON.stringify(v || []);
  };
  return norm(a) === norm(b);
}

// ── GET /api/trips — list all trips ──────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const trips = await db('trips').orderBy('created_at', 'desc');
    res.json(trips.map(serialize));
  } catch (err) {
    sendServerError(res, 'list trips', err);
  }
});

// ── GET /api/trips/public — only upcoming + special ──────────
router.get('/public', async (req, res) => {
  try {
    const trips = await db('trips').whereIn('status', ['upcoming', 'active']);
    res.json(trips.map(serialize));
  } catch (err) {
    sendServerError(res, 'list public trips', err);
  }
});

// ── GET /api/trips/instances — all completed instances ────────
router.get('/instances', requireAdmin, async (req, res) => {
  try {
    const instances = await db('trip_instances').orderBy('departureDate', 'desc');
    res.json(instances.map(inst => ({
      ...inst,
      snapshot: inst.snapshot ? JSON.parse(inst.snapshot) : {},
    })));
  } catch (err) {
    sendServerError(res, 'list trip instances', err);
  }
});

// ── GET /api/trips/:id ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const trip = await db('trips').where({ id: req.params.id }).first();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    // Non-admins may only read published trips (drafts/archived stay private).
    const isAdmin = req.session && req.session.isAdmin === true;
    if (!isAdmin && !['upcoming', 'active'].includes(trip.status)) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    res.json(serialize(trip));
  } catch (err) {
    sendServerError(res, 'get trip', err);
  }
});

// ── POST /api/trips — create new trip ─────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const id = uuidv4();
    const prefix = getPrefixForTrip(req.body);
    const body = deserialize(req.body);

    const trip = {
      id,
      prefix,
      tripId: null,          // placeholder until instance is resolved
      status: 'draft',
      special: false,
      ...body,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    await db('trips').insert(trip);
    const created = await db('trips').where({ id }).first();
    res.status(201).json(serialize(created));
  } catch (err) {
    sendServerError(res, 'create trip', err);
  }
});

// ── PUT /api/trips/:id — update trip ─────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await db('trips').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Trip not found' });

    const body = deserialize(req.body);
    // The prefix is server-derived; never accept a client-supplied value.
    delete body.prefix;

    // Recompute the prefix only when destinations are present and actually changed.
    const update = { ...body, updated_at: db.fn.now() };
    if (req.body.destinations !== undefined &&
        !sameDestinations(req.body.destinations, existing.destinations)) {
      update.prefix = getPrefixForTrip({ ...existing, ...req.body });
    }

    await db('trips').where({ id: req.params.id }).update(update);
    const updated = await db('trips').where({ id: req.params.id }).first();
    if (!updated) return res.status(404).json({ error: 'Trip not found' });
    res.json(serialize(updated));
  } catch (err) {
    sendServerError(res, 'update trip', err);
  }
});

// ── DELETE /api/trips/:id ──────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db('trips').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, 'delete trip', err);
  }
});

// ── GET /api/trips/instances/:instanceId — single instance ───
router.get('/instances/:instanceId', requireAdmin, async (req, res) => {
  try {
    const inst = await db('trip_instances').where({ id: req.params.instanceId }).first();
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    res.json({ ...inst, snapshot: inst.snapshot ? JSON.parse(inst.snapshot) : {} });
  } catch (err) {
    sendServerError(res, 'get trip instance', err);
  }
});

module.exports = router;
