/**
 * routes/trips.js — CRUD for trips and trip instances
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getPrefixForTrip, templateId } = require('../lib/tripId');
const { syncDepartures, groupCode } = require('../lib/departures');
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
    const departures = await db('departures').orderBy('date', 'asc');
    const groups = await db('departure_groups').orderBy('number', 'asc');
    res.json(trips.map(trip => {
      const result = serialize(trip);
      if (['upcoming', 'active'].includes(trip.status)) {
        const items = departures.filter(d => d.tripId === trip.id);
        const departure = items.length === 1 ? items[0] : null;
        if (items.length > 1) {
          result.displayTripId = templateId(trip.prefix || getPrefixForTrip(result));
        } else if (departure) {
          const departureGroups = groups.filter(g => g.departureId === departure.id);
          const current = departureGroups[departureGroups.length - 1];
          result.displayTripId = current ? groupCode(departure.code, current.number, departureGroups.length > 1) : departure.code;
        }
      }
      return result;
    }));
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

// ── GET /api/trips/suggestions ────────────────────
// Most-used inclusions/exclusions across saved trips, so the admin form's
// "Quick add" chips reflect what this operator actually writes rather than a
// hardcoded list. Must stay above GET /:id or the param route swallows it.
router.get('/suggestions', requireAdmin, async (req, res) => {
  try {
    const trips = await db('trips');
    const LIMIT = 12;

    const tally = (col) => {
      const counts = new Map();
      for (const trip of trips) {
        let list = trip[col];
        if (typeof list === 'string') {
          try { list = JSON.parse(list || '[]'); } catch { continue; }
        }
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
          const value = String(raw == null ? '' : raw).trim();
          // Skip blanks and anything too long to sit on a chip.
          if (!value || value.length > 60) continue;
          const key = value.toLowerCase();
          const entry = counts.get(key) || { value, count: 0 };
          entry.count += 1;
          counts.set(key, entry);
        }
      }
      return [...counts.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, LIMIT)
        .map((e) => e.value);
    };

    res.json({ inclusions: tally('inclusions'), exclusions: tally('exclusions') });
  } catch (err) {
    sendServerError(res, 'trip suggestions', err);
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
    delete body.id;
    delete body.tripId;
    delete body.displayTripId;
    if (body.status === 'completed') {
      return res.status(400).json({ error: 'A trip can be completed only after its full departure groups have finished' });
    }

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

    await db.transaction(async trx => {
      await trx('trips').insert(trip);
      if (['upcoming', 'active'].includes(trip.status)) await syncDepartures(trx, trip);
    });
    const created = await db('trips').where({ id }).first();
    res.status(201).json(serialize(created));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
    delete body.id;
    delete body.tripId;
    delete body.displayTripId;

    // Recompute the prefix only when destinations are present and actually changed.
    const update = { ...body, updated_at: db.fn.now() };
    if (req.body.destinations !== undefined &&
        !sameDestinations(req.body.destinations, existing.destinations)) {
      update.prefix = getPrefixForTrip({ ...existing, ...req.body });
    }

    await db.transaction(async trx => {
      if (update.status === 'completed' && existing.status !== 'completed') {
        const departures = await trx('departures').where({ tripId: req.params.id }).pluck('id');
        const groups = departures.length ? await trx('departure_groups').whereIn('departureId', departures) : [];
        if (!groups.length || groups.some(group => group.status !== 'completed')) {
          const err = new Error('A trip can be completed only after its full departure groups have finished');
          err.status = 400;
          throw err;
        }
      }
      await trx('trips').where({ id: req.params.id }).update(update);
      const trip = await trx('trips').where({ id: req.params.id }).first();
      if (['upcoming', 'active'].includes(trip.status)) await syncDepartures(trx, trip);
    });
    const updated = await db('trips').where({ id: req.params.id }).first();
    if (!updated) return res.status(404).json({ error: 'Trip not found' });
    res.json(serialize(updated));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    sendServerError(res, 'update trip', err);
  }
});

// ── DELETE /api/trips/:id ──────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.transaction(async trx => {
      const departures = await trx('departures').where({ tripId: req.params.id }).pluck('id');
      if (departures.length) {
        const groups = await trx('departure_groups').whereIn('departureId', departures).pluck('id');
        if (groups.length && await trx('bookings').whereIn('groupId', groups).first('id')) {
          const err = new Error('Trips with bookings cannot be deleted; archive the trip instead');
          err.status = 400;
          throw err;
        }
        await trx('departure_groups').whereIn('departureId', departures).del();
        await trx('departures').whereIn('id', departures).del();
      }
      await trx('trips').where({ id: req.params.id }).delete();
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
