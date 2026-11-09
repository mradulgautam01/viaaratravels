/**
 * migrate.js — Creates all tables if they don't exist.
 * Run once: node db/migrate.js
 * Safe to re-run (uses createTableIfNotExists).
 */

require('dotenv').config();
const db = require('./db');

async function migrate() {
  console.log('▶ Running migrations...');

  // ── trips ────────────────────────────────────────────────────
  // Parent trip templates. Each trip can have many departure dates.
  // tripId is the TEMPLATE placeholder (e.g. DEH-XXXXXXX).
  // Instances are stored in trip_instances.
  await db.schema.createTableIfNotExists('trips', t => {
    t.string('id').primary();             // internal UUID
    t.string('tripId').nullable();        // e.g. DEH-XXXXXXX (prefix locked at creation)
    t.string('prefix', 3).nullable();     // e.g. DEH — computed once and stored
    t.string('title').notNullable();
    t.string('location').defaultTo('');
    t.string('summary').defaultTo('');
    t.string('price').defaultTo('');
    t.string('duration').defaultTo('');
    t.string('days').defaultTo('');
    t.string('nights').defaultTo('');
    t.string('scope').defaultTo('local');
    t.text('destinations');               // JSON array of strings
    t.text('departureCities');            // JSON array of strings
    t.text('itinerary');                  // JSON array
    t.text('inclusions');                 // JSON array
    t.text('exclusions');                 // JSON array
    t.text('tags');                       // JSON array
    t.text('images');                     // JSON array of URLs
    t.text('dates');                      // JSON array of date strings
    t.string('availType').defaultTo('fixed');
    t.integer('seats').nullable();
    t.string('status').defaultTo('draft'); // draft | upcoming | completed | archived
    t.boolean('special').defaultTo(false);
    t.timestamps(true, true);             // created_at, updated_at
  });

  // ── trip_instances ───────────────────────────────────────────
  // One row per (trip × departure date) once the date has passed.
  // instanceId format: DEH061126A
  await db.schema.createTableIfNotExists('trip_instances', t => {
    t.string('id').primary();             // instanceId e.g. DEH061126A
    t.string('tripId').references('id').inTable('trips').onDelete('CASCADE');
    t.string('prefix', 3).notNullable();  // DEH
    t.string('departureDate').notNullable(); // YYYY-MM-DD
    t.string('title').notNullable();
    t.string('price').defaultTo('');
    t.text('snapshot');                   // full JSON snapshot of trip at that date
    t.integer('bookedSeats').defaultTo(0);
    t.string('status').defaultTo('completed');
    t.timestamps(true, true);
  });

  // ── bookings ─────────────────────────────────────────────────
  // One row per customer booking. id = VT-{PREFIX}{DDMMYY}A-{SEQ}
  await db.schema.createTableIfNotExists('bookings', t => {
    t.string('id').primary();               // e.g. VT-MEG061126A-01
    t.string('tripId').references('id').inTable('trips').onDelete('SET NULL').nullable();
    t.string('instanceId').nullable();      // resolved trip instance ID if available
    t.string('tripTitle').defaultTo('');
    t.string('tripPrice').defaultTo('');
    t.string('date').defaultTo('');         // departure date string (human-readable)
    t.string('name').notNullable();
    t.string('phone').defaultTo('');
    t.string('email').defaultTo('');
    t.integer('travelers').defaultTo(1);
    t.text('message').defaultTo('');
    t.string('status').defaultTo('Pending');        // Pending | Confirmed | Hold | Cancelled
    t.string('paymentStatus').defaultTo('Unpaid');  // Unpaid | Partial | Paid
    t.string('transactionId').defaultTo('');
    t.string('addedBy').defaultTo('customer');      // customer | admin
    t.string('bookedOn').defaultTo('');             // human-readable timestamp
    t.timestamps(true, true);
  });

  // ── leads ────────────────────────────────────────────────────
  await db.schema.createTableIfNotExists('leads', t => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('phone').defaultTo('');
    t.string('email').defaultTo('');
    t.string('trip').defaultTo('');       // trip title at time of inquiry
    t.string('instanceId').nullable();    // resolved instance ID if available
    t.string('tripId').nullable();        // parent trip UUID
    t.text('message').defaultTo('');
    t.string('status').defaultTo('New'); // New | Contacted | Booked | Lost
    t.string('date').defaultTo('');       // human-readable creation time
    t.timestamps(true, true);
  });

  // ── analytics ────────────────────────────────────────────────
  await db.schema.createTableIfNotExists('analytics', t => {
    t.increments('id').primary();
    t.string('tripId').notNullable();
    t.string('type').notNullable();       // view | click
    t.bigInteger('ts').notNullable();     // epoch ms
    t.timestamps(true, true);
  });

  // ── testimonials ─────────────────────────────────────────────
  await db.schema.createTableIfNotExists('testimonials', t => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('trip').defaultTo('');
    t.string('instanceId').nullable();
    t.integer('rating').defaultTo(5);
    t.text('body').defaultTo('');
    t.string('status').defaultTo('pending'); // pending | approved | rejected
    t.timestamps(true, true);
  });

  console.log('✓ Migrations complete.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('✗ Migration failed:', err);
  process.exit(1);
});
