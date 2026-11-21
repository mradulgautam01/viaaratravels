const express = require('express');
const { v4: uuidv4, validate: validateUuid } = require('uuid');
const db = require('../db/db');
const { requireAdmin, publicWriteLimiter } = require('../lib/auth');
const { parseDate, todayIndia, groupCode } = require('../lib/departures');

const router = express.Router();
const statuses = ['Pending', 'Hold', 'Confirmed', 'Cancelled'];

// A cancelled booking frees its seats; everything else occupies them.
const OCCUPYING_STATUSES = statuses.filter(s => s !== 'Cancelled');

// Seats are a per-GROUP limit: group A holds N, group B holds another N.
// Returns null when no limit is configured, meaning unlimited.
function resolveSeatLimit(trip, departure) {
  let map = trip && trip.dateSeats;
  if (typeof map === 'string') {
    try { map = JSON.parse(map || '{}'); } catch { map = null; }
  }
  if (map && typeof map === 'object') {
    // dateSeats is written by the admin keyed on the display label;
    // fall back to the ISO date in case that ever changes.
    for (const key of [departure && departure.dateLabel, departure && departure.date]) {
      if (!key) continue;
      const value = Number(map[key]);
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  const fallback = Number(trip && trip.seats);
  return Number.isInteger(fallback) && fallback > 0 ? fallback : null;
}

// Travellers already holding seats in a group.
async function seatsTaken(trx, groupId) {
  const row = await trx('bookings')
    .where({ groupId })
    .whereIn('status', OCCUPYING_STATUSES)
    .sum({ total: 'travelers' })
    .first();
  return Number(row && row.total) || 0;
}
const payments = ['Unpaid', 'Partial', 'Paid'];
const phoneRe = /^[0-9+\-()\s.]{6,20}$/;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function text(value, max, label, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') bad(`${label} must be text`);
  const result = value.trim();
  if ((required && !result) || result.length > max) bad(`Invalid ${label}`);
  return result;
}

function serialize(row) {
  const result = { ...row };
  result.pax = row.pax ? JSON.parse(row.pax) : [];
  return result;
}

function error(res, action, err) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`[bookings] Failed to ${action}:`, err.code || err.name);
  return res.status(500).json({ error: 'Unable to process booking. Please try again.' });
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const bookings = await db('bookings').orderBy('created_at', 'desc');
    res.json(bookings.map(serialize));
  } catch (err) { error(res, 'list bookings', err); }
});

router.get('/groups', requireAdmin, async (req, res) => {
  try {
    const departures = await db('departures as d')
      .join('trips as t', 'd.tripId', 't.id')
      .select('d.id', 'd.tripId', 'd.date', 'd.dateLabel', 'd.code', 't.title', 't.status as tripStatus');
    const groups = await db('departure_groups').orderBy('number');
    const bookedGroups = new Set((await db('bookings').whereNotNull('groupId').distinct('groupId')).map(b => b.groupId));
    res.json(departures.flatMap(d => {
      const items = groups.filter(g => g.departureId === d.id);
      // The sequence also preserves visibility if a previously received booking is deleted.
      return items.filter(g => Number(g.nextSequence) > 1 || bookedGroups.has(g.id)).map(g => ({
        id: g.id, tripId: d.tripId, tripTitle: d.title, date: d.dateLabel,
        tripStatus: d.tripStatus, status: g.status, isFull: !!g.isFull,
        code: groupCode(d.code, g.number, items.length > 1),
      }));
    }));
  } catch (err) { error(res, 'list departure groups', err); }
});

router.post('/groups/:id/full', requireAdmin, async (req, res) => {
  try {
    await db.transaction(async trx => {
      const group = await trx('departure_groups').where({ id: req.params.id }).first();
      if (!group) bad('Departure group not found', 404);
      await trx('departures').where({ id: group.departureId }).update({ updated_at: trx.fn.now() });
      const current = await trx('departure_groups').where({ id: group.id }).first();
      if (current.isFull) bad('This group is already marked full', 409);
      await trx('departure_groups').where({ id: group.id }).update({ isFull: true, updated_at: trx.fn.now() });
    });
    await require('../lib/cron').processExpiredDates();
    res.json({ ok: true });
  } catch (err) { error(res, 'mark group full', err); }
});

router.post('/', publicWriteLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const isAdmin = req.session && req.session.isAdmin === true;
    if (typeof body.requestKey !== 'string' || !validateUuid(body.requestKey)) bad('Invalid booking request key');
    const tripId = text(body.tripId, 100, 'trip ID', true);
    const date = parseDate(body.date);
    if (!date) bad('Select a valid departure date');
    const name = text(body.name, 100, 'name', true);
    const phone = text(body.phone, 20, 'phone', true);
    const email = text(body.email, 254, 'email');
    const message = text(body.message, 2000, 'message');
    if (!phoneRe.test(phone)) bad('Invalid phone number');
    if (email && !emailRe.test(email)) bad('Invalid email address');
    const travelers = Number(body.travelers);
    if (!Number.isInteger(travelers) || travelers < 1 || travelers > (isAdmin ? 2147483647 : 5)) bad('Invalid number of travelers');
    const pax = body.pax === undefined ? [] : body.pax;
    if (!Array.isArray(pax) || pax.length > travelers) bad('Invalid traveler details');
    const cleanPax = pax.map(p => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) bad('Invalid traveler details');
      const entry = {
        name: text(p.name, 100, 'traveler name', true),
        gender: text(p.gender, 20, 'gender', true),
        dob: text(p.dob, 10, 'date of birth', true),
        phone: text(p.phone, 20, 'traveler phone', true),
        email: text(p.email, 254, 'traveler email'),
      };
      if (!['Male', 'Female', 'Other'].includes(entry.gender) || !parseDate(entry.dob) ||
          entry.dob > todayIndia() || !phoneRe.test(entry.phone) || (entry.email && !emailRe.test(entry.email))) {
        bad('Invalid traveler details');
      }
      return entry;
    });
    if (!isAdmin && cleanPax.length !== travelers) bad('Traveler details are required for every traveler');
    const status = isAdmin ? (body.status || 'Pending') : 'Pending';
    const paymentStatus = isAdmin ? (body.paymentStatus || 'Unpaid') : 'Unpaid';
    if (!statuses.includes(status) || !payments.includes(paymentStatus)) bad('Invalid booking status');

    const created = await db.transaction(async trx => {
      const departure = await trx('departures').where({ tripId, date }).first();
      if (!departure) bad('This departure is unavailable', 404);
      await trx('departures').where({ id: departure.id }).update({ updated_at: trx.fn.now() });
      const previousRequest = await trx('bookings').where({ requestKey: body.requestKey }).first();
      if (previousRequest) {
        if (previousRequest.tripId !== tripId || parseDate(previousRequest.date) !== date) bad('Booking request key is already in use', 409);
        return { id: previousRequest.id, tripId: previousRequest.instanceId };
      }
      const trip = await trx('trips').where({ id: tripId }).first();
      if (!trip || !['active', 'upcoming'].includes(trip.status)) bad('This trip is not available for booking', 409);
      if (date < todayIndia()) bad('This departure has already passed', 409);
      let groups = await trx('departure_groups').where({ departureId: departure.id }).orderBy('number');
      let group = groups[groups.length - 1];
      if (!group) bad('Departure group is missing', 409);

      // Seat capacity (Option B: the limit applies to each group, so a full
      // group rolls into a new one rather than refusing the booking).
      const seatLimit = resolveSeatLimit(trip, departure);
      if (seatLimit && travelers > seatLimit) {
        bad(`This departure takes ${seatLimit} travellers per group. Please book ${seatLimit} or fewer at a time.`, 409);
      }
      const taken = seatLimit ? await seatsTaken(trx, group.id) : 0;
      const wouldOverfill = Boolean(seatLimit) && taken + travelers > seatLimit;

      if (group.isFull || wouldOverfill) {
        if (group.number >= 26) bad('No further groups are available for this departure', 409);
        const newGroup = { id: uuidv4(), departureId: departure.id, number: group.number + 1, isFull: false, status: 'upcoming' };
        // Booking IDs are immutable. Opening Group B must not rewrite the
        // references already issued to Group A customers, so bookings made
        // before the split keep the unsuffixed code they were given.
        await trx('departure_groups').insert(newGroup);
        groups = [...groups, newGroup];
        group = newGroup;
      }
      const code = groupCode(departure.code, group.number, groups.length > 1);
      const stem = `VT-${code}-`;
      const seq = group.nextSequence || 1;
      const id = stem + String(seq).padStart(2, '0');
      await trx('departure_groups').where({ id: group.id }).update({ nextSequence: seq + 1, updated_at: trx.fn.now() });
      await trx('bookings').insert({
        id, tripId, groupId: group.id, instanceId: code, requestKey: body.requestKey, tripTitle: trip.title, tripPrice: trip.price,
        date: departure.dateLabel, name, phone, email, travelers, message, status, paymentStatus,
        addedBy: isAdmin ? 'admin' : 'customer', pax: JSON.stringify(cleanPax),
        bookedOn: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      });
      return { id, tripId: code };
    });
    res.status(201).json(created);
  } catch (err) { error(res, 'create booking', err); }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const keys = Object.keys(body);
    if (!keys.length || keys.some(k => !['status', 'paymentStatus', 'transactionId'].includes(k))) bad('Invalid booking update');
    const update = {};
    if (body.status !== undefined) {
      if (!statuses.includes(body.status)) bad('Invalid booking status');
      update.status = body.status;
    }
    if (body.paymentStatus !== undefined) {
      if (!payments.includes(body.paymentStatus)) bad('Invalid payment status');
      update.paymentStatus = body.paymentStatus;
      if (body.paymentStatus !== 'Paid') update.transactionId = '';
    }
    if (body.transactionId !== undefined) update.transactionId = text(body.transactionId, 100, 'transaction ID');
    update.updated_at = db.fn.now();

    await db.transaction(async trx => {
      const existing = await trx('bookings').where({ id: req.params.id }).first();
      if (!existing) bad('Booking not found', 404);

      // Cancelling frees seats, so bringing a cancelled booking back takes
      // them again. Without this check an admin could reinstate past the
      // group's limit and bypass the capacity rule entirely.
      if (update.status && update.status !== 'Cancelled' && existing.status === 'Cancelled') {
        const group = await trx('departure_groups').where({ id: existing.groupId }).first();
        if (group) {
          const departure = await trx('departures').where({ id: group.departureId }).first();
          const trip = await trx('trips').where({ id: existing.tripId }).first();
          const seatLimit = resolveSeatLimit(trip, departure);
          if (seatLimit) {
            const taken = await seatsTaken(trx, group.id);
            const needed = Number(existing.travelers) || 1;
            if (taken + needed > seatLimit) {
              bad(`This group is at capacity (${taken} of ${seatLimit} seats taken). Cancel another booking or move this one to a new group.`, 409);
            }
          }
        }
      }

      const count = await trx('bookings').where({ id: req.params.id }).update(update);
      if (!count) bad('Booking not found', 404);
    });
    res.json({ ok: true });
  } catch (err) { error(res, 'update booking', err); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const count = await db('bookings').where({ id: req.params.id }).del();
    if (!count) bad('Booking not found', 404);
    res.json({ ok: true });
  } catch (err) { error(res, 'delete booking', err); }
});

module.exports = router;
