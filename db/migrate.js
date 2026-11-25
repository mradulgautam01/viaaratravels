/**
 * migrate.js — Creates all tables if they don't exist.
 * Run once: node db/migrate.js
 * Safe to re-run (checks table existence before creation).
 */

require('dotenv').config();
const db = require('./db');

async function migrate() {
  console.log('▶ Running migrations...');

  // ── trips ────────────────────────────────────────────────────
  // Parent trip templates. Each trip can have many departure dates.
  // tripId is the TEMPLATE placeholder (e.g. DEH-XXXXXXX).
  // Instances are stored in trip_instances.
  if (!(await db.schema.hasTable('trips'))) {
    await db.schema.createTable('trips', t => {
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
  }

  // ── trip_instances ───────────────────────────────────────────
  // One row per (trip × departure date) once the date has passed.
  // instanceId format: DEH061126A
  if (!(await db.schema.hasTable('trip_instances'))) {
    await db.schema.createTable('trip_instances', t => {
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
  }

  // ── bookings ─────────────────────────────────────────────────
  // One row per customer booking. id = VT-{PREFIX}{DDMMYY}A-{SEQ}
  if (!(await db.schema.hasTable('bookings'))) {
    await db.schema.createTable('bookings', t => {
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
  }

  // ── leads ────────────────────────────────────────────────────
  if (!(await db.schema.hasTable('leads'))) {
    await db.schema.createTable('leads', t => {
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
  }

  // ── analytics ────────────────────────────────────────────────
  if (!(await db.schema.hasTable('analytics'))) {
    await db.schema.createTable('analytics', t => {
      t.increments('id').primary();
      t.string('tripId').notNullable();
      t.string('type').notNullable();       // view | click
      t.bigInteger('ts').notNullable();     // epoch ms
      t.timestamps(true, true);
    });
  }

  // ── testimonials ─────────────────────────────────────────────
  if (!(await db.schema.hasTable('testimonials'))) {
    await db.schema.createTable('testimonials', t => {
      t.increments('id').primary();
      t.string('name').notNullable();
      t.string('trip').defaultTo('');
      t.string('instanceId').nullable();
      t.integer('rating').defaultTo(5);
      t.text('body').defaultTo('');
      t.string('status').defaultTo('pending'); // pending | approved | rejected
      t.timestamps(true, true);
    });
  }

  // Add email to existing testimonials tables safely.
  if (!(await db.schema.hasColumn('testimonials', 'email'))) {
    await db.schema.alterTable('testimonials', t => {
      t.string('email').defaultTo('');
    });
  }

  // Import the original homepage testimonials exactly once.
  // The marker and review inserts share one transaction so a partial
  // import can never be recorded as complete.
  const initialReviewsMigration = '20261125_seed_initial_homepage_reviews_v1';

  if (!(await db.schema.hasTable('app_migrations'))) {
    await db.schema.createTable('app_migrations', t => {
      t.string('id').primary();
      t.timestamp('applied_at').notNullable().defaultTo(db.fn.now());
    });
  }

  await db.transaction(async trx => {
    const alreadyApplied = await trx('app_migrations')
      .where({ id: initialReviewsMigration })
      .first();

    if (alreadyApplied) return;

    const initialReviews = [
      {
        name: 'Priya S.',
        trip: 'Meghalaya trip',
        body: 'The Meghalaya trip was life-changing \u2014 the root bridges, the people, the food. Viaara made every detail seamless. Didn\u2019t have to think about a thing.',
        rating: 5,
        status: 'approved',
        email: ''
      },
      {
        name: 'Rahul M.',
        trip: 'Goa \u2013 Gokarna trip',
        body: 'First group trip I ever did and I was honestly nervous. The Viaara team made it so easy \u2014 Goa to Gokarna was just incredible. Can\u2019t wait for the next one.',
        rating: 5,
        status: 'approved',
        email: ''
      },
      {
        name: 'Ananya K.',
        trip: 'Udaipur trip',
        body: 'Udaipur in 3 days felt surprisingly complete. Great curation, zero stress, and the rooftop dinner on Day 2 was something else. Already booked my next trip with Viaara.',
        rating: 5,
        status: 'approved',
        email: ''
      },
      {
        name: 'Siddharth V.',
        trip: 'Meghalaya trip',
        body: 'Never travelled in a group before \u2014 Viaara changed that. Everything was sorted, the vibe was great, and Meghalaya blew my mind. 10/10 would do it again.',
        rating: 5,
        status: 'approved',
        email: ''
      },
      {
        name: 'Nisha T.',
        trip: 'Goa \u2013 Gokarna trip',
        body: 'The sunset yacht cruise in Goa was worth the trip alone. Viaara handled everything \u2014 we just showed up and enjoyed. Already planning the next one.',
        rating: 5,
        status: 'approved',
        email: ''
      }
    ];

    await trx('testimonials').insert(initialReviews);

    await trx('app_migrations').insert({
      id: initialReviewsMigration
    });

    console.log('Imported five original homepage testimonials.');
  });

  // Homepage media assets: two video slots and two poster slots.
  if (!(await db.schema.hasTable('homepage_media_assets'))) {
    await db.schema.createTable('homepage_media_assets', t => {
      t.string('id').primary();
      t.string('type').notNullable(); // hero | posters
      t.integer('slot').notNullable(); // 1 | 2
      t.string('filename').notNullable();
      t.text('url').notNullable();
      t.string('mime_type').notNullable();
      t.bigInteger('file_size').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now());

      t.unique(['type', 'slot']);
    });

    console.log('Created homepage_media_assets table.');
  }

  // Stores the currently published video/poster pair.
  if (!(await db.schema.hasTable('homepage_media_state'))) {
    await db.schema.createTable('homepage_media_state', t => {
      t.integer('id').primary();
      t.string('video_asset_id').nullable();
      t.string('poster_asset_id').nullable();
      t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
    });

    console.log('Created homepage_media_state table.');
  }

  // Ensure the singleton publishing state exists.
  const homepageMediaState = await db('homepage_media_state')
    .where({ id: 1 })
    .first();

  if (!homepageMediaState) {
    await db('homepage_media_state').insert({
      id: 1,
      video_asset_id: null,
      poster_asset_id: null
    });
  }

  console.log('✓ Migrations complete.');
}

if (require.main === module) {
  migrate()
    .catch(err => {
      console.error('✗ Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = migrate;
