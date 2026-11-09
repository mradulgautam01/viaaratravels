/**
 * routes/trips.js — CRUD for trips and trip instances
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getPrefixForTrip, templateId } = require('../lib/tripId');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────
const JSON_COLS = ['destinations','departureCities','itinerary','inclusions','exclusions','tags','images','dates'];

function serialize(trip) {
  const t = { ...trip };
  JSON_COLS.forEach(col => {
    if (typeof t[col] === 'string') {
      try { t[col] = JSON.parse(t[col]); } catch { t[col] = []; }
    }
    if (!t[col]) t[col] = [];
  });
  t.special = !!t.special;
  t.displayTripId = t.tripId || templateId(t.prefix || getPrefixForTrip(t));
  return t;
}

function deserialize(body) {
  const t = { ...body };
  JSON_COLS.forEach(col => {
    if (Array.isArray(t[col])) t[col] = JSON.stringify(t[col]);
  });
  return t;
}

// ── GET /api/trips — list all trips ──────────────────────────
router.get('/', async (req, res) => {
  try {
    const trips = await db('trips').orderBy('created_at', 'desc');
    res.json(trips.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/trips/public — only upcoming + special ──────────
router.get('/public', async (req, res) => {
  try {
    const trips = await db('trips').whereIn('status', ['upcoming', 'active']);
    res.json(trips.map(serialize));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/trips/instances — all completed instances ────────
router.get('/instances', async (req, res) => {
  try {
    const instances = await db('trip_instances').orderBy('departureDate', 'desc');
    res.json(instances.map(inst => ({
      ...inst,
      snapshot: inst.snapshot ? JSON.parse(inst.snapshot) : {},
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/trips/:id ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const trip = await db('trips').where({ id: req.params.id }).first();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    res.json(serialize(trip));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/trips — create new trip ─────────────────────────
router.post('/', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/trips/:id — update trip ─────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const body = deserialize(req.body);
    // Recompute prefix if destinations changed
    const prefix = getPrefixForTrip(req.body);
    await db('trips').where({ id: req.params.id }).update({
      ...body,
      prefix,
      updated_at: db.fn.now(),
    });
    const updated = await db('trips').where({ id: req.params.id }).first();
    if (!updated) return res.status(404).json({ error: 'Trip not found' });
    res.json(serialize(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/trips/:id ──────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await db('trips').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/trips/instances/:instanceId — single instance ───
router.get('/instances/:instanceId', async (req, res) => {
  try {
    const inst = await db('trip_instances').where({ id: req.params.instanceId }).first();
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    res.json({ ...inst, snapshot: inst.snapshot ? JSON.parse(inst.snapshot) : {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
