/**
 * migrate_indexes.js
 * Adds indexes for frequently used booking, departure,
 * analytics, lead and historical-trip queries.
 *
 * Safe to rerun on SQLite and PostgreSQL.
 * Run: node db/migrate_indexes.js
 */

require('dotenv').config();
const db = require('./db');

const indexes = [
  // Booking lookups and seat occupancy
  'CREATE INDEX IF NOT EXISTS idx_bookings_group_status ON bookings ("groupId", status)',

  // Admin booking list
  'CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings (created_at)',

  // Historical trip lookup
  'CREATE INDEX IF NOT EXISTS idx_trip_instances_trip_id ON trip_instances ("tripId")',

  // Trip-specific analytics over time
  'CREATE INDEX IF NOT EXISTS idx_analytics_trip_ts ON analytics ("tripId", ts)',

  // Overall analytics time-window queries
  'CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics (ts)',

  // New lead count
  'CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status)',

  // Admin lead list ordering
  'CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at)',
];

async function migrate() {
  console.log('Running database index migration...');

  for (const sql of indexes) {
    await db.raw(sql);
    console.log(`Created or verified: ${sql}`);
  }

  console.log('Database index migration complete.');
}

if (require.main === module) {
  migrate()
    .catch(err => {
      console.error('Index migration failed:', err);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = migrate;
