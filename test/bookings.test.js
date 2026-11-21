const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

test('publication, shared booking routing and full-group completion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-booking-test-'));
  const filename = path.join(dir, 'test.sqlite');
  process.env.DB_CLIENT =
    process.env.TEST_DB_CLIENT === 'postgres' ? 'postgres' : 'sqlite';

  process.env.SQLITE_PATH = filename;
  // lib/auth.js builds the rate limiter at import time, so this must be set
  // before the routes below are required or the production limit applies.
  process.env.RATE_LIMIT_MAX = '10000';
  const root = path.resolve(__dirname, '..');
  for (const script of ['db/migrate.js', 'db/migrate_trip_cols.js']) {
    const result = spawnSync(process.execPath, [script], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const db = require('../db/db');
  await require('../db/migrate_bookings')();
  await require('../db/migrate_indexes')();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { isAdmin: req.headers['x-test-admin'] === 'yes' };
    next();
  });
  app.use('/api/trips', require('../routes/trips'));
  app.use('/api/bookings', require('../routes/bookings'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.destroy();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = filename + suffix;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(dir);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, method = 'GET', body, admin = false) {
    const response = await fetch(base + url, {
      method,
      headers: { ...(admin ? { 'x-test-admin': 'yes' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  const trip = { title: 'Manali trip', location: 'Manali', duration: '6D / 5N', price: '6499', status: 'draft', dates: [] };
  const draft = await request('/api/trips', 'POST', trip, true);
  assert.equal(draft.status, 201);

  // Trip API validation safeguards.
  assert.equal(
    (await request('/api/trips', 'POST', {
      ...trip,
      unexpectedField: 'not-allowed'
    }, true)).status,
    400
  );

  assert.equal(
    (await request('/api/trips', 'POST', {
      ...trip,
      status: 'published'
    }, true)).status,
    400
  );

  assert.equal(
    (await request('/api/trips', 'POST', {
      ...trip,
      availType: 'invalid'
    }, true)).status,
    400
  );

  assert.equal(
    (await request('/api/trips', 'POST', {
      ...trip,
      dates: 'not-an-array'
    }, true)).status,
    400
  );

  // Numeric fields must reject empty or invalid values.
  for (const field of ['seats', 'completed']) {
    assert.equal(
      (await request('/api/trips', 'POST', {
        ...trip,
        [field]: ''
      }, true)).status,
      400
    );
  }

  assert.equal(
    (await request('/api/trips', 'POST', {
      ...trip,
      seats: 'not-a-number'
    }, true)).status,
    400
  );

  assert.equal(
    (await request(`/api/trips/${draft.body.id}`, 'PUT', {
      seats: '12',
      completed: '0'
    }, true)).status,
    200
  );

  assert.equal(
    (await request('/api/trips', 'POST', {
      ...trip,
      status: 'completed'
    }, true)).status,
    400
  );

  // Partial updates must remain supported.
  assert.equal(
    (await request(`/api/trips/${draft.body.id}`, 'PUT', {
      special: true
    }, true)).status,
    200
  );

  assert.equal(
    (await request(`/api/trips/${draft.body.id}`, 'PUT', {
      unknownField: 'not-allowed'
    }, true)).status,
    400
  );

  // Availability selection must persist through the API.
  assert.equal(
    (await request(`/api/trips/${draft.body.id}`, 'PUT', {
      availType: 'weekly'
    }, true)).status,
    200
  );

  const savedTrips = await request('/api/trips', 'GET', undefined, true);
  const savedDraft = savedTrips.body.find(x => x.id === draft.body.id);

  assert.equal(savedDraft.availType, 'weekly');
  assert.equal(savedDraft.special, true);

  assert.equal((await request('/api/trips/public')).body.some(x => x.id === draft.body.id), false);
  assert.equal((await request(`/api/trips/${draft.body.id}`, 'PUT', { status: 'upcoming' }, true)).status, 400);
  const date = '27 Nov, 2099';
  assert.equal((await request(`/api/trips/${draft.body.id}`, 'PUT', { status: 'upcoming', dates: [date] }, true)).status, 200);
  assert.equal((await request(`/api/trips/${draft.body.id}`, 'PUT', { status: 'completed' }, true)).status, 400);
  let list = await request('/api/trips', 'GET', undefined, true);
  assert.equal(list.body[0].displayTripId, 'MAN-271199-01');
  const second = await request('/api/trips', 'POST', { ...trip, title: 'Another Manali trip', status: 'upcoming', dates: [date] }, true);
  assert.equal(second.status, 201);
  list = await request('/api/trips', 'GET', undefined, true);
  assert.equal(list.body.find(x => x.id === second.body.id).displayTripId, 'MAN-271199-02');
  assert.equal((await request('/api/bookings')).status, 401);
  assert.deepEqual((await request('/api/bookings/groups', 'GET', undefined, true)).body, []);
  const details = {
    requestKey: randomUUID(),
    tripId: draft.body.id, date, name: 'Test Traveler', phone: '9999999999', travelers: 1,
    pax: [{ name: 'Test Traveler', gender: 'Other', dob: '1990-01-01', phone: '9999999999', email: '' }],
  };
  const first = await request('/api/bookings', 'POST', details);
  assert.equal(first.status, 201);
  assert.equal(first.body.id, 'VT-MAN-271199-01-01');
  const retry = await request('/api/bookings', 'POST', details);
  assert.equal(retry.body.id, first.body.id);

  // Simultaneous retries with the same request key must create one booking.
  const simultaneousKey = randomUUID();
  const simultaneousDetails = { ...details, requestKey: simultaneousKey };

  const simultaneousRetries = await Promise.all(
    Array.from({ length: 5 }, () => request('/api/bookings', 'POST', simultaneousDetails))
  );

  assert.ok(simultaneousRetries.every(r => r.status === 201));

  const simultaneousIds = new Set(simultaneousRetries.map(r => r.body.id));
  assert.equal(simultaneousIds.size, 1);

  const duplicateRows = await db('bookings').where({ requestKey: simultaneousKey });
  assert.equal(duplicateRows.length, 1);

  // The same request key must never create bookings for two different trips.
  const crossTripKey = randomUUID();

  const crossTripRequests = await Promise.all([
    request('/api/bookings', 'POST', { ...details, requestKey: crossTripKey }),
    request('/api/bookings', 'POST', { ...details, tripId: second.body.id, requestKey: crossTripKey }),
  ]);

  assert.equal(crossTripRequests.filter(r => r.status === 201).length, 1);
  assert.equal(crossTripRequests.filter(r => r.status === 409).length, 1);

  const crossTripRows = await db('bookings').where({ requestKey: crossTripKey });
  assert.equal(crossTripRows.length, 1);

  let groups = await request('/api/bookings/groups', 'GET', undefined, true);
  const groupA = groups.body.find(g => g.tripId === draft.body.id);
  assert.equal((await request(`/api/bookings/groups/${groupA.id}/full`, 'POST')).status, 401);
  assert.equal((await request(`/api/bookings/groups/${groupA.id}/full`, 'POST', undefined, true)).status, 200);
  const next = await request('/api/bookings', 'POST', { ...details, requestKey: randomUUID() });
  assert.equal(next.status, 201);
  assert.equal(next.body.id, 'VT-MAN-271199-01B-01');
  const bookings = await request('/api/bookings', 'GET', undefined, true);
  const tripBookings = bookings.body.filter(b => b.tripId === draft.body.id);

  const tripBookingIds = new Set(
    tripBookings.map(b => b.id)
  );

  // Original Group A IDs must never be rewritten.
  assert.ok(tripBookingIds.has('VT-MAN-271199-01-01'));
  assert.ok(tripBookingIds.has('VT-MAN-271199-01-02'));

  // The new Group B booking must carry the B suffix.
  assert.ok(tripBookingIds.has('VT-MAN-271199-01B-01'));
  assert.equal(next.body.id, 'VT-MAN-271199-01B-01');
  const retryAfterSplit = await request('/api/bookings', 'POST', details);
  assert.equal(retryAfterSplit.body.id, 'VT-MAN-271199-01-01');
  const concurrent = await Promise.all([1, 2, 3].map(() => request('/api/bookings', 'POST', { ...details, requestKey: randomUUID() })));
  assert.ok(concurrent.every(r => r.status === 201));
  assert.equal(new Set(concurrent.map(r => r.body.id)).size, 3);
  groups = await request('/api/bookings/groups', 'GET', undefined, true);
  assert.deepEqual(groups.body.filter(g => g.tripId === draft.body.id).map(g => g.code), ['MAN-271199-01A', 'MAN-271199-01B']);
  list = await request('/api/trips', 'GET', undefined, true);
  assert.equal(list.body.find(x => x.id === draft.body.id).displayTripId, 'MAN-271199-01B');
  assert.equal((await request(`/api/trips/${draft.body.id}`, 'PUT', { dates: ['28 Nov, 2099'] }, true)).status, 400);
  assert.equal((await request(`/api/trips/${draft.body.id}`, 'DELETE', undefined, true)).status, 400);

  const multi = await request('/api/trips', 'POST', {
    ...trip, title: 'Shimla trip', location: 'Shimla', status: 'upcoming',
    dates: ['01 Dec, 2099', '02 Dec, 2099'],
  }, true);
  assert.equal(multi.status, 201);
  list = await request('/api/trips', 'GET', undefined, true);
  assert.equal(list.body.find(x => x.id === multi.body.id).displayTripId, 'SHI-XXXXXXX');
  assert.equal((await request('/api/bookings/groups', 'GET', undefined, true)).body.filter(g => g.tripId === multi.body.id).length, 0);
  const multiBooking = await request('/api/bookings', 'POST', {
    ...details, requestKey: randomUUID(), tripId: multi.body.id, date: '02 Dec, 2099',
  });
  assert.equal(multiBooking.status, 201);
  assert.equal(multiBooking.body.id, 'VT-SHI-021299-01-01');
  groups = await request('/api/bookings/groups', 'GET', undefined, true);
  assert.deepEqual(groups.body.filter(g => g.tripId === multi.body.id).map(g => g.code), ['SHI-021299-01']);
  list = await request('/api/trips', 'GET', undefined, true);
  assert.equal(list.body.find(x => x.id === multi.body.id).displayTripId, 'SHI-XXXXXXX');
  assert.equal((await request(`/api/bookings/${multiBooking.body.id}`, 'DELETE', undefined, true)).status, 200);
  assert.equal((await request('/api/bookings/groups', 'GET', undefined, true)).body.filter(g => g.tripId === multi.body.id).length, 1);
  assert.equal((await request(`/api/trips/${multi.body.id}`, 'PUT', { dates: ['02 Dec, 2099'] }, true)).status, 200);
  list = await request('/api/trips', 'GET', undefined, true);
  assert.equal(list.body.find(x => x.id === multi.body.id).displayTripId, 'SHI-021299-01');

  await require('../db/migrate_bookings')();
  assert.equal((await request('/api/bookings/groups', 'GET', undefined, true)).body.filter(g => g.tripId === draft.body.id).length, 2);

  const past = await request('/api/trips', 'POST', { ...trip, title: 'Past Manali trip', status: 'upcoming', dates: ['01 Jan, 2000'] }, true);
  assert.equal(past.status, 201);
  await require('../lib/cron').processExpiredDates();
  assert.equal((await db('trips').where({ id: past.body.id }).first()).status, 'completed');
  const pastDeparture = await db('departures').where({ tripId: past.body.id }).first();

  // Completed trips cannot be reopened through the API.
  assert.equal(
    (await request(`/api/trips/${past.body.id}`, 'PUT', {
      status: 'upcoming'
    }, true)).status,
    400
  );

  assert.equal(
    (await request(`/api/trips/${past.body.id}`, 'PUT', {
      status: 'draft'
    }, true)).status,
    400
  );

  // Keep the trip editable to exercise the completed-group removal guard.
  await db('trips').where({ id: past.body.id }).update({ status: 'upcoming' });

  // A completed departure must not be removable through trip date edits.
  assert.equal(
    (await request(`/api/trips/${past.body.id}`, 'PUT', {
      dates: ['02 Jan, 2000'],
    }, true)).status,
    400
  );

  assert.ok(await db('departures').where({ id: pastDeparture.id }).first());
  await db('trips').where({ id: past.body.id }).update({ status: 'completed' });

  const pastGroup = await db('departure_groups').where({ departureId: pastDeparture.id }).first();

  assert.equal(pastGroup.status, 'completed');

  // A completed departure prevents changing the effective trip duration.
  assert.equal(
    (await request(`/api/trips/${past.body.id}`, 'PUT', {
      duration: '7D / 6N',
    }, true)).status,
    400
  );

  // Equivalent duration wording should remain allowed.
  assert.equal(
    (await request(`/api/trips/${past.body.id}`, 'PUT', {
      duration: '6 days',
    }, true)).status,
    200
  );

  assert.equal(
    (await request('/api/bookings/groups', 'GET', undefined, true)).body.some(g => g.id === pastGroup.id),
    false
  );

  let archivedInstances = await db('trip_instances').where({ tripId: past.body.id });
  assert.equal(archivedInstances.length, 1);
  assert.equal(archivedInstances[0].status, 'completed');

  // Archived trip history must prevent deletion.
  assert.equal(
    (await request(`/api/trips/${past.body.id}`, 'DELETE', undefined, true)).status,
    400
  );

  assert.ok(await db('trips').where({ id: past.body.id }).first());

  assert.equal(
    (await db('trip_instances').where({ tripId: past.body.id })).length,
    1
  );

  // Running the cron again must not create a duplicate archive.
  await require('../lib/cron').processExpiredDates();
  archivedInstances = await db('trip_instances').where({ tripId: past.body.id });
  assert.equal(archivedInstances.length, 1);

  assert.equal((await request(`/api/bookings/groups/${pastGroup.id}/full`, 'POST', undefined, true)).status, 200);
  assert.equal((await db('trips').where({ id: past.body.id }).first()).status, 'completed');
  // ── Seat capacity and reinstatement regression tests ──

  const capacityDate = '28 Nov, 2099';
  const capacityTrip = await request('/api/trips', 'POST', {
    ...trip,
    title: 'Capacity Spiti trip',
    location: 'Spiti Valley',
    status: 'upcoming',
    dates: [capacityDate],
    seats: null,
    dateSeats: { [capacityDate]: 20 },
  }, true);

  assert.equal(capacityTrip.status, 201);

  const capacityPax = Array.from({ length: 5 }, (_, i) => ({
    name: `Capacity Traveler ${i + 1}`,
    gender: 'Other',
    dob: '1990-01-01',
    phone: '9999999999',
    email: '',
  }));

  async function capacityBooking(travelers = 5, admin = false) {
    return request('/api/bookings', 'POST', {
      requestKey: randomUUID(),
      tripId: capacityTrip.body.id,
      date: capacityDate,
      name: 'Capacity Test',
      phone: '9999999999',
      travelers,
      pax: capacityPax.slice(0, travelers),
    }, admin);
  }

  async function capacityGroupList() {
    return db('departure_groups')
      .join('departures', 'departure_groups.departureId', 'departures.id')
      .where('departures.tripId', capacityTrip.body.id)
      .orderBy('departure_groups.number')
      .select('departure_groups.*');
  }

  async function occupiedSeats(groupId) {
    const row = await db('bookings')
      .where({ groupId })
      .whereIn('status', ['Pending', 'Hold', 'Confirmed'])
      .sum({ total: 'travelers' })
      .first();
    return Number(row.total) || 0;
  }

  // Four public bookings of five fill Group A.
  for (let i = 0; i < 4; i++) {
    assert.equal((await capacityBooking()).status, 201);
  }

  let capacityGroups = await capacityGroupList();
  assert.equal(capacityGroups.length, 1);
  assert.equal(await occupiedSeats(capacityGroups[0].id), 20);

  // The fifth booking rolls into Group B.
  const fifth = await capacityBooking();
  assert.equal(fifth.status, 201);

  capacityGroups = await capacityGroupList();
  assert.equal(capacityGroups.length, 2);

  const groupB = capacityGroups[1];
  const fifthRecord = await db('bookings').where({ id: fifth.body.id }).first();
  assert.equal(fifthRecord.groupId, groupB.id);

  // Cancelling frees the seats it held.
  assert.equal(
    (await request(`/api/bookings/${fifth.body.id}`, 'PUT', { status: 'Cancelled' }, true)).status,
    200
  );
  assert.equal(await occupiedSeats(groupB.id), 0);

  // Four new five-person bookings reuse Group B's freed capacity.
  for (let i = 0; i < 4; i++) {
    assert.equal((await capacityBooking()).status, 201);
  }
  assert.equal(await occupiedSeats(groupB.id), 20);

  // Reinstating the cancelled booking must be rejected — it would take
  // Group B to 25 of 20.
  const reinstatement = await request(
    `/api/bookings/${fifth.body.id}`,
    'PUT',
    { status: 'Confirmed' },
    true
  );
  assert.equal(reinstatement.status, 409);

  // A party larger than the whole group limit can never fit, even for admin.
  assert.equal((await capacityBooking(21, true)).status, 409);

  // An admin booking that fits is still accepted, and opens Group C.
  const adminBooking = await capacityBooking(5, true);
  assert.equal(adminBooking.status, 201);

  capacityGroups = await capacityGroupList();
  assert.equal(capacityGroups.length, 3);
  assert.equal(
    (await db('bookings').where({ id: adminBooking.body.id }).first()).groupId,
    capacityGroups[2].id
  );

  // ── Concurrent seat-capacity allocation ──
  // Three simultaneous 5-traveller bookings against a 10-seat group must not
  // all read "0 taken" and land together. Two fill Group A, the third rolls.

  const parallelDate = '29 Nov, 2099';

  const parallelTrip = await request('/api/trips', 'POST', {
    ...trip,
    title: 'Parallel capacity trip',
    location: 'Spiti Valley',
    status: 'upcoming',
    dates: [parallelDate],
    seats: null,
    dateSeats: { [parallelDate]: 10 },
  }, true);

  assert.equal(parallelTrip.status, 201);

  const parallelPax = Array.from({ length: 5 }, (_, i) => ({
    name: `Parallel Traveler ${i + 1}`,
    gender: 'Other',
    dob: '1990-01-01',
    phone: '9999999999',
    email: '',
  }));

  const parallelBookings = await Promise.all(
    Array.from({ length: 3 }, () =>
      request('/api/bookings', 'POST', {
        requestKey: randomUUID(),
        tripId: parallelTrip.body.id,
        date: parallelDate,
        name: 'Parallel Capacity Test',
        phone: '9999999999',
        travelers: 5,
        pax: parallelPax,
      })
    )
  );

  assert.ok(parallelBookings.every(r => r.status === 201));

  const parallelGroups = await db('departure_groups')
    .join('departures', 'departure_groups.departureId', 'departures.id')
    .where('departures.tripId', parallelTrip.body.id)
    .orderBy('departure_groups.number')
    .select('departure_groups.*');

  assert.equal(parallelGroups.length, 2);

  const parallelOccupancy = await Promise.all(parallelGroups.map(g => occupiedSeats(g.id)));

  assert.deepEqual(parallelOccupancy.sort((a, b) => a - b), [5, 10]);
  assert.ok(parallelOccupancy.every(count => count <= 10));

  // ── Concurrent cancellation and reinstatement ──
  // Two cancelled bookings compete for the same remaining seats: each fits
  // alone, but together they would exceed the limit.

  const raceDate = '30 Nov, 2099';

  const raceTrip = await request('/api/trips', 'POST', {
    ...trip,
    title: 'Concurrent reinstatement trip',
    location: 'Spiti Valley',
    status: 'upcoming',
    dates: [raceDate],
    seats: null,
    dateSeats: { [raceDate]: 10 },
  }, true);

  assert.equal(raceTrip.status, 201);

  async function raceBooking(travelers) {
    return request('/api/bookings', 'POST', {
      requestKey: randomUUID(),
      tripId: raceTrip.body.id,
      date: raceDate,
      name: 'Reinstatement Race Test',
      phone: '9999999999',
      travelers,
      pax: parallelPax.slice(0, travelers),
    });
  }

  const raceBase = await raceBooking(2);
  const raceFirst = await raceBooking(4);
  const raceSecond = await raceBooking(4);

  assert.ok([raceBase, raceFirst, raceSecond].every(r => r.status === 201));

  const raceGroupId = (await db('bookings').where({ id: raceBase.body.id }).first()).groupId;

  assert.equal((await db('bookings').where({ id: raceFirst.body.id }).first()).groupId, raceGroupId);
  assert.equal((await db('bookings').where({ id: raceSecond.body.id }).first()).groupId, raceGroupId);

  // Cancel both four-person bookings.
  for (const booking of [raceFirst, raceSecond]) {
    assert.equal(
      (await request(`/api/bookings/${booking.body.id}`, 'PUT', { status: 'Cancelled' }, true)).status,
      200
    );
  }

  // Fill four of the freed seats.
  const raceReplacement = await raceBooking(4);
  assert.equal(raceReplacement.status, 201);
  assert.equal(await occupiedSeats(raceGroupId), 6);

  // Both reinstatements individually fit, but together would exceed capacity.
  const reinstatementRace = await Promise.all(
    [raceFirst, raceSecond].map(booking =>
      request(`/api/bookings/${booking.body.id}`, 'PUT', { status: 'Confirmed' }, true)
    )
  );

  assert.equal(reinstatementRace.filter(r => r.status === 200).length, 1);
  assert.equal(reinstatementRace.filter(r => r.status === 409).length, 1);

  assert.equal(await occupiedSeats(raceGroupId), 10);

});
