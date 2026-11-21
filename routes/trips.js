/**
 * routes/trips.js — CRUD for trips and trip instances
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { getPrefixForTrip, templateId } = require('../lib/tripId');
const {
  syncDepartures,
  groupCode,
  durationDays,
  lockTrip,
  lockDeparture
} = require('../lib/departures');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────
const JSON_COLS = ['destinations','departureCities','itinerary','inclusions','exclusions','tags','images','dates'];
const JSON_OBJ_COLS = ['dateSeats']; // object (not array) JSON cols

const TRIP_FIELDS = new Set([
  'title', 'summary', 'location', 'subLocation', 'price',
  'duration', 'days', 'nights', 'scope', 'destinations',
  'departureCities', 'itinerary', 'included', 'inclusions',
  'exclusions', 'tags', 'images', 'dates', 'availType',
  'seats', 'dateSeats', 'completed', 'intensity',
  'special', 'status'
]);

const TRIP_STATUSES = new Set([
  'draft', 'upcoming', 'active', 'archived', 'completed'
]);

const AVAIL_TYPES = new Set([
  'fixed', 'weekly', 'everyday', 'request'
]);

const SCOPES = new Set(['local', 'global']);

const INTENSITIES = new Set([
  'Relaxed', 'Balanced', 'Active', 'Breathtaking'
]);

function validateTripBody(body, { isUpdate = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }

  for (const key of Object.keys(body)) {
    if (key === 'id' || key === 'tripId' || key === 'prefix' ||
        key === 'displayTripId' || key === 'created_at' ||
        key === 'updated_at') {
      continue;
    }

    if (!TRIP_FIELDS.has(key)) {
      return `Unsupported trip field: ${key}`;
    }
  }

  if (!isUpdate && (!body.title || typeof body.title !== 'string' || !body.title.trim())) {
    return 'Trip title is required';
  }

  const stringLimits = {
    title: 200,
    summary: 5000,
    location: 200,
    subLocation: 500,
    price: 100,
    duration: 100,
    days: 20,
    nights: 20
  };

  for (const [field, max] of Object.entries(stringLimits)) {
    if (body[field] !== undefined &&
        (typeof body[field] !== 'string' || body[field].length > max)) {
      return `${field} must be a string of at most ${max} characters`;
    }
  }

  if (body.status !== undefined && !TRIP_STATUSES.has(body.status)) {
    return 'Invalid trip status';
  }

  if (body.scope !== undefined && !SCOPES.has(body.scope)) {
    return 'Invalid trip scope';
  }

  if (body.intensity !== undefined && !INTENSITIES.has(body.intensity)) {
    return 'Invalid trip intensity';
  }

  if (body.availType !== undefined && !AVAIL_TYPES.has(body.availType)) {
    return 'Invalid availability type';
  }

  for (const field of [
    'destinations', 'departureCities', 'itinerary', 'included',
    'inclusions', 'exclusions', 'tags', 'images', 'dates'
  ]) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      return `${field} must be an array`;
    }
  }

  if (body.dateSeats !== undefined &&
      (!body.dateSeats || typeof body.dateSeats !== 'object' ||
       Array.isArray(body.dateSeats))) {
    return 'dateSeats must be an object';
  }

  for (const field of ['seats', 'completed']) {
    if (body[field] !== undefined && body[field] !== null) {
      const value = body[field];

      // Accept numbers and non-empty numeric strings, but reject empty strings.
      if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim()) ||
        !Number.isInteger(Number(value)) ||
        Number(value) < (field === 'seats' ? 1 : 0)
      ) {
        return `${field} must be a valid ${field === 'seats' ? 'positive' : 'non-negative'} integer`;
      }
    }
  }

  if (body.special !== undefined && typeof body.special !== 'boolean') {
    return 'special must be a boolean';
  }

  if (body.status === 'completed' && !isUpdate) {
    return 'A trip can be completed only after its full departure groups have finished';
  }

  return null;
}

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
  const validationError = validateTripBody(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

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
  const validationError = validateTripBody(req.body, { isUpdate: true });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const existing = await db('trips').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Trip not found' });

    const body = deserialize(req.body);
    // The prefix is server-derived; never accept a client-supplied value.
    delete body.prefix;
    delete body.id;
    delete body.tripId;
    delete body.displayTripId;

    const update = { ...body, updated_at: db.fn.now() };

    await db.transaction(async trx => {
      // Lock and reread the latest trip before making lifecycle decisions.
      const currentTrip = await lockTrip(trx, req.params.id);

      if (!currentTrip) {
        const err = new Error('Trip not found');
        err.status = 404;
        throw err;
      }

      // Recompute the prefix using the latest locked trip data.
      if (
        req.body.destinations !== undefined &&
        !sameDestinations(req.body.destinations, currentTrip.destinations)
      ) {
        update.prefix = getPrefixForTrip({
          ...currentTrip,
          ...req.body
        });
      }

      // Completed trips cannot be reopened or moved to another status.
      if (
        currentTrip.status === 'completed' &&
        update.status !== undefined &&
        update.status !== 'completed'
      ) {
        const err = new Error('Completed trips cannot be reopened');
        err.status = 400;
        throw err;
      }

      // Prevent changing trip duration after bookings or completed history exist.
      const oldDurationDays = durationDays(currentTrip);
      const newDurationDays = durationDays({ ...currentTrip, ...update });

      if (oldDurationDays !== newDurationDays) {
        const departureIds = await trx('departures')
          .where({ tripId: req.params.id })
          .pluck('id');

        for (const departureId of departureIds.sort()) {
          const lockedDeparture = await lockDeparture(trx, departureId);

          if (!lockedDeparture) {
            const err = new Error(
              'Departure changed while updating trip duration; please retry'
            );
            err.status = 409;
            throw err;
          }
        }

        if (departureIds.length) {
          const groups = await trx('departure_groups')
            .whereIn('departureId', departureIds);

          const groupIds = groups.map(group => group.id);

          const hasBookings = groupIds.length
            ? await trx('bookings').whereIn('groupId', groupIds).first('id')
            : null;

          const hasCompletedGroups = groups.some(
            group => group.status === 'completed'
          );

          if (hasBookings || hasCompletedGroups) {
            const err = new Error(
              'Trip duration cannot be changed after bookings or completed departure history exist'
            );
            err.status = 400;
            throw err;
          }
        }
      }

      if (update.status === 'completed' && currentTrip.status !== 'completed') {
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
    if ([400, 404, 409].includes(err.status)) {
      return res.status(err.status).json({ error: err.message });
    }
    sendServerError(res, 'update trip', err);
  }
});

// ── DELETE /api/trips/:id ──────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.transaction(async trx => {
      // Lock the trip before checking or deleting its related records.
      const trip = await lockTrip(trx, req.params.id);

      if (!trip) {
        const err = new Error('Trip not found');
        err.status = 404;
        throw err;
      }

      const archivedInstance = await trx('trip_instances')
        .where({ tripId: req.params.id })
        .first('id');

      if (archivedInstance) {
        const err = new Error('Trips with archived instances cannot be deleted; historical records must be preserved');
        err.status = 400;
        throw err;
      }

      const departureRows = await trx('departures')
        .where({ tripId: req.params.id })
        .orderBy('id');

      const departures = departureRows.map(d => d.id);

      for (const departureId of departures) {
        const locked = await lockDeparture(trx, departureId);

        if (!locked) {
          const err = new Error('Departure changed while deleting trip; please retry');
          err.status = 409;
          throw err;
        }
      }

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
    if (err.status === 400 || err.status === 404 || err.status === 409) {
      return res.status(err.status).json({ error: err.message });
    }
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
