/**
 * cron.js — Automatic trip instance creator
 *
 * Runs every day at midnight (and once on server start to catch missed days).
 *
 * Logic:
 *  For every published (upcoming) trip:
 *    For every departure date in that trip:
 *      If the date is in the past AND no instance exists yet:
 *        → Generate instance ID (e.g. DEH061126A)
 *        → Create a trip_instance row (full snapshot of the trip at that moment)
 *        → Remove that date from the parent trip's dates array
 *        → If parent trip has no dates left, set status = 'completed'
 */

require('dotenv').config();
const cron   = require('node-cron');
const db     = require('../db/db');
const { getPrefixForTrip, nextInstanceId } = require('./tripId');

/**
 * Parse a human-readable date chip string like "Fri, 06 Nov, 2026" or "06 Nov 2026"
 * into a Date object. Falls back to new Date() parsing if the pattern doesn't match
 * (handles ISO strings too). Returns Invalid Date on failure — caller should check isNaN.
 */
function parseChipDate(str) {
  if (!str) return new Date(NaN);
  // Strip leading day-of-week (e.g. "Fri, ") — optional
  const cleaned = String(str).replace(/^[A-Za-z]{2,3},?\s*/, '').trim();
  // Match: "06 Nov, 2026" or "06 Nov 2026" or "6 Nov 2026"
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const m = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3})[,\s]+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon !== undefined) {
      return new Date(parseInt(m[3]), mon, parseInt(m[1]));
    }
  }
  // Fallback for ISO / other formats
  return new Date(str);
}

async function processExpiredDates() {
  console.log('[cron] Checking for expired trip dates…');

  const trips = await db('trips').whereIn('status', ['upcoming', 'active']);

  for (const trip of trips) {
    let dates;
    try { dates = JSON.parse(trip.dates || '[]'); } catch { dates = []; }
    if (!dates.length) continue;

    const prefix      = trip.prefix || getPrefixForTrip(trip);
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const expiredDates = dates.filter(d => { const p = parseChipDate(d); return !isNaN(p) && p < today; });
    const futureDates  = dates.filter(d => { const p = parseChipDate(d); return !isNaN(p) && p >= today; });

    for (const dateStr of expiredDates) {
      // Check if an instance already exists for this trip + date
      const existing = await db('trip_instances')
        .where({ tripId: trip.id, departureDate: dateStr })
        .first();
      if (existing) continue; // already created

      // Generate unique instance ID
      let instanceId;
      try {
        instanceId = await nextInstanceId(prefix, dateStr);
      } catch (err) {
        console.error(`[cron] Could not generate ID for ${trip.title} / ${dateStr}:`, err.message);
        continue;
      }

      // Build snapshot — full trip object frozen at this moment
      const snapshot = {
        id:              trip.id,
        title:           trip.title,
        location:        trip.location,
        summary:         trip.summary,
        price:           trip.price,
        duration:        trip.duration,
        days:            trip.days,
        nights:          trip.nights,
        scope:           trip.scope,
        destinations:    safeJson(trip.destinations),
        departureCities: safeJson(trip.departureCities),
        itinerary:       safeJson(trip.itinerary),
        inclusions:      safeJson(trip.inclusions),
        exclusions:      safeJson(trip.exclusions),
        tags:            safeJson(trip.tags),
        images:          safeJson(trip.images),
        departureDate:   dateStr,
        instanceId,
      };

      await db('trip_instances').insert({
        id:            instanceId,
        tripId:        trip.id,
        prefix,
        departureDate: dateStr,
        title:         trip.title,
        price:         trip.price,
        snapshot:      JSON.stringify(snapshot),
        bookedSeats:   0,
        status:        'completed',
      });

      console.log(`[cron] ✓ Created instance ${instanceId} for "${trip.title}" / ${dateStr}`);
    }

    // Update the parent trip: remove expired dates, update status if needed
    const updatedDates = JSON.stringify(futureDates);
    const updatedStatus = futureDates.length === 0 ? 'completed' : trip.status;

    await db('trips').where({ id: trip.id }).update({
      dates:      updatedDates,
      status:     updatedStatus,
      updated_at: db.fn.now(),
    });
  }

  console.log('[cron] Done.');
}

function safeJson(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
}

/**
 * Start the cron job.
 * Schedule: every day at 00:05 (5 past midnight, avoids exact boundary edge cases).
 * Also runs immediately on startup to catch any dates missed while server was down.
 */
function startCron() {
  // Run immediately on startup (retroactive catch-up)
  processExpiredDates().catch(err => console.error('[cron] Startup run failed:', err));

  // Schedule daily at 00:05
  cron.schedule('5 0 * * *', () => {
    processExpiredDates().catch(err => console.error('[cron] Scheduled run failed:', err));
  });

  console.log('[cron] Scheduled — runs daily at 00:05 and on startup.');
}

module.exports = { startCron, processExpiredDates };
