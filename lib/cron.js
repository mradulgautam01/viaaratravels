/**
 * Complete full departure groups after their final trip day.
 */
const cron = require('node-cron');
const db = require('../db/db');
const {
  todayIndia,
  durationDays,
  endDate,
  groupCode,
  lockTrip,
  lockDeparture
} = require('./departures');
const { getPrefixForTrip } = require('./tripId');

function jsonArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : JSON.parse(value);
}

async function processExpiredDates() {
  // Read IDs only; trip details are reread after acquiring the lock.
  const tripIds = await db('trips')
    .whereIn('status', ['upcoming', 'active'])
    .pluck('id');

  const today = todayIndia();

  for (const tripId of tripIds) {
    await db.transaction(async trx => {
      const trip = await lockTrip(trx, tripId);

      if (!trip || !['upcoming', 'active'].includes(trip.status)) {
        return;
      }

      const days = durationDays(trip);
      if (!days) {
        console.error(`[cron] Trip ${trip.id} has no valid duration; completion was skipped.`);
        return;
      }

      const departures = await trx('departures')
        .where({ tripId: trip.id })
        .orderBy('id');

      // Lock departures in a consistent order after locking the trip.
      for (const departure of departures) {
        await lockDeparture(trx, departure.id);
      }

      for (const departure of departures) {
        const groups = await trx('departure_groups')
          .where({ departureId: departure.id })
          .orderBy('number');

        if (endDate(departure.date, days) >= today) continue;

        for (const group of groups) {
          if (group.status === 'completed') continue;

          const instanceId = groupCode(
            departure.code,
            group.number,
            groups.length > 1
          );

          const bookings = await trx('bookings')
            .where({ groupId: group.id, status: 'Confirmed' });

          const snapshot = JSON.stringify({
            ...trip,
            destinations: jsonArray(trip.destinations),
            departureCities: jsonArray(trip.departureCities),
            itinerary: jsonArray(trip.itinerary),
            inclusions: jsonArray(trip.inclusions),
            exclusions: jsonArray(trip.exclusions),
            tags: jsonArray(trip.tags),
            images: jsonArray(trip.images),
            departureDate: departure.dateLabel,
            instanceId,
          });

          await trx('trip_instances').insert({
            id: instanceId,
            tripId: trip.id,
            prefix: trip.prefix || getPrefixForTrip(trip),
            departureDate: departure.dateLabel,
            title: trip.title,
            price: trip.price,
            snapshot,
            bookedSeats: bookings.reduce(
              (n, b) => n + (Number(b.travelers) || 0),
              0
            ),
            status: 'completed',
          });

          await trx('departure_groups')
            .where({ id: group.id })
            .update({
              status: 'completed',
              updated_at: trx.fn.now()
            });
        }
      }

      if (departures.length) {
        const groups = await trx('departure_groups')
          .whereIn('departureId', departures.map(d => d.id));

        if (groups.length && groups.every(g => g.status === 'completed')) {
          await trx('trips')
            .where({ id: trip.id })
            .update({
              status: 'completed',
              updated_at: trx.fn.now()
            });
        }
      }
    });
  }
}

function startCron() {
  processExpiredDates().catch(err => console.error('[cron] Startup run failed:', err));
  cron.schedule('5 0 * * *', () => {
    processExpiredDates().catch(err => console.error('[cron] Scheduled run failed:', err));
  }, { timezone: 'Asia/Kolkata' });
}

module.exports = { startCron, processExpiredDates };
