const { v4: uuidv4 } = require('uuid');
const { getPrefixForTrip } = require('./tripId');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let year, month, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const named = /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})$/.exec(text);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else if (named) {
    year = Number(named[3]); month = MONTHS[named[2].toLowerCase()]; day = Number(named[1]);
  } else return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (!month || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function durationDays(trip) {
  const match = /^(\d+)\s*d/i.exec(trip.duration || '');
  const days = Number(trip.days) || (match && Number(match[1]));
  return Number.isInteger(days) && days > 0 ? days : null;
}

function endDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days - 1);
  return d.toISOString().slice(0, 10);
}

function groupCode(code, number, hasMultiple) {
  return code + (hasMultiple ? String.fromCharCode(64 + number) : '');
}

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

async function syncDepartures(trx, trip) {
  let dates = trip.dates;
  if (typeof dates === 'string') {
    try { dates = JSON.parse(dates); } catch { fail('Invalid departure dates'); }
  }
  if (!Array.isArray(dates) || !dates.length) fail('Add at least one departure date before publishing');
  if (!durationDays(trip)) fail('Add a valid trip duration before publishing');

  const normalized = dates.map(label => ({ label, date: parseDate(label) }));
  if (normalized.some(d => !d.date)) fail('Departure dates must include a valid day, month and year');
  if (new Set(normalized.map(d => d.date)).size !== normalized.length) fail('Duplicate departure dates are not allowed');

  const existing = await trx('departures').where({ tripId: trip.id });
  for (const old of existing) {
    if (normalized.some(d => d.date === old.date)) continue;
    const groups = await trx('departure_groups').where({ departureId: old.id });
    const groupIds = groups.map(g => g.id);
    const booked = groupIds.length && await trx('bookings').whereIn('groupId', groupIds).first('id');
    if (booked || groups.some(g => g.isFull)) fail('Cannot remove a departure with bookings or a full group');
    await trx('departure_groups').where({ departureId: old.id }).del();
    await trx('departures').where({ id: old.id }).del();
  }

  for (const item of normalized) {
    const old = existing.find(d => d.date === item.date);
    if (old) {
      if (old.dateLabel !== item.label) await trx('departures').where({ id: old.id }).update({ dateLabel: item.label });
      continue;
    }
    const prefix = trip.prefix || getPrefixForTrip(trip);
    const datePart = item.date.slice(8, 10) + item.date.slice(5, 7) + item.date.slice(2, 4);
    const stem = `${prefix}-${datePart}-`;
    await trx('departure_sequences').insert({ stem, lastNumber: 1 })
      .onConflict('stem').merge({ lastNumber: trx.raw('?? + 1', ['departure_sequences.lastNumber']) });
    const sequence = await trx('departure_sequences').where({ stem }).first();
    const next = Number(sequence.lastNumber);
    if (next > 99) fail('No more itinerary IDs are available for this destination and date');
    const id = uuidv4();
    await trx('departures').insert({ id, tripId: trip.id, date: item.date, dateLabel: item.label, code: stem + String(next).padStart(2, '0') });
    await trx('departure_groups').insert({ id: uuidv4(), departureId: id, number: 1 });
  }
}

module.exports = { parseDate, todayIndia, durationDays, endDate, groupCode, syncDepartures };
