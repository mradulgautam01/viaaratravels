/**
 * migrate_trip_cols.js — Adds missing columns to the trips table.
 * Safe to re-run (checks hasColumn before adding).
 * Run: node db/migrate_trip_cols.js
 */
require('dotenv').config();
const db = require('./db');

async function migrate() {
  console.log('▶ Adding missing trip columns...');

  const adds = [
    { col: 'subLocation',  add: t => t.string('subLocation').defaultTo('') },
    { col: 'dateSeats',    add: t => t.text('dateSeats') },        // JSON {"date":seats}
    { col: 'completed',    add: t => t.integer('completed').defaultTo(0) },
    { col: 'intensity',    add: t => t.string('intensity').defaultTo('Balanced') },
  ];

  for (const { col, add } of adds) {
    const exists = await db.schema.hasColumn('trips', col);
    if (!exists) {
      await db.schema.table('trips', add);
      console.log(`  ✓ Added column: ${col}`);
    } else {
      console.log(`  — Already exists: ${col}`);
    }
  }

  console.log('✓ Done.');
  process.exit(0);
}

migrate().catch(err => { console.error('✗ Failed:', err); process.exit(1); });
