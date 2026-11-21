/**
 * Adds shared departure groups and booking passenger details.
 * Run after the base migrations: node db/migrate_bookings.js
 */
require('dotenv').config();
const db = require('./db');

async function migrate() {
  if (!(await db.schema.hasTable('departure_sequences'))) {
    await db.schema.createTable('departure_sequences', t => {
      t.string('stem').primary();
      t.integer('lastNumber').notNullable();
    });
  }
  if (!(await db.schema.hasTable('departures'))) {
    await db.schema.createTable('departures', t => {
      t.string('id').primary();
      t.string('tripId').notNullable().references('id').inTable('trips');
      t.string('date').notNullable();
      t.string('dateLabel').notNullable();
      t.string('code').notNullable().unique();
      t.timestamps(true, true);
      t.unique(['tripId', 'date']);
    });
  }
  if (!(await db.schema.hasTable('departure_groups'))) {
    await db.schema.createTable('departure_groups', t => {
      t.string('id').primary();
      t.string('departureId').notNullable().references('id').inTable('departures');
      t.integer('number').notNullable();
      t.integer('nextSequence').notNullable().defaultTo(1);
      t.boolean('isFull').notNullable().defaultTo(false);
      t.string('status').notNullable().defaultTo('upcoming');
      t.timestamps(true, true);
      t.unique(['departureId', 'number']);
    });
  }
  if (!(await db.schema.hasColumn('departure_groups', 'nextSequence'))) {
    await db.schema.table('departure_groups', t => t.integer('nextSequence').notNullable().defaultTo(1));
  }
  if (!(await db.schema.hasColumn('bookings', 'groupId'))) {
    await db.schema.table('bookings', t => t.string('groupId').nullable().references('id').inTable('departure_groups'));
  }
  if (!(await db.schema.hasColumn('bookings', 'pax'))) {
    await db.schema.table('bookings', t => t.text('pax').nullable());
  }
  if (!(await db.schema.hasColumn('bookings', 'requestKey'))) {
    await db.schema.table('bookings', t => t.string('requestKey').nullable());
  }
  await db.raw('CREATE UNIQUE INDEX IF NOT EXISTS bookings_request_key_unique ON bookings ("requestKey")');
  const { syncDepartures } = require('../lib/departures');
  await db.transaction(async trx => {
    const existing = await trx('departures').select('code');
    for (const { code } of existing) {
      const match = /^(.*-)(\d{2})$/.exec(code);
      if (!match) throw new Error(`Invalid existing departure code: ${code}`);
      const row = await trx('departure_sequences').where({ stem: match[1] }).first();
      if (!row) await trx('departure_sequences').insert({ stem: match[1], lastNumber: Number(match[2]) });
      else if (row.lastNumber < Number(match[2])) await trx('departure_sequences').where({ stem: match[1] }).update({ lastNumber: Number(match[2]) });
    }
    const trips = await trx('trips').whereIn('status', ['upcoming', 'active']);
    for (const trip of trips) await syncDepartures(trx, trip);
  });
  console.log('Shared booking migration complete.');
}

if (require.main === module) {
  migrate().then(() => db.destroy()).catch(async err => {
    console.error('Shared booking migration failed:', err);
    await db.destroy();
    process.exitCode = 1;
  });
}

module.exports = migrate;
