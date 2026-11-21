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
  process.env.DB_CLIENT = 'sqlite';
  process.env.SQLITE_PATH = filename;
  const root = path.resolve(__dirname, '..');
  for (const script of ['db/migrate.js', 'db/migrate_trip_cols.js']) {
    const result = spawnSync(process.execPath, [script], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const db = require('../db/db');
  await require('../db/migrate_bookings')();
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
  let groups = await request('/api/bookings/groups', 'GET', undefined, true);
  const groupA = groups.body.find(g => g.tripId === draft.body.id);
  assert.equal((await request(`/api/bookings/groups/${groupA.id}/full`, 'POST')).status, 401);
  assert.equal((await request(`/api/bookings/groups/${groupA.id}/full`, 'POST', undefined, true)).status, 200);
  const next = await request('/api/bookings', 'POST', { ...details, requestKey: randomUUID() });
  assert.equal(next.status, 201);
  assert.equal(next.body.id, 'VT-MAN-271199-01B-01');
  const bookings = await request('/api/bookings', 'GET', undefined, true);
  // Existing booking IDs must remain unchanged after Group B is created.
  assert.deepEqual(
    bookings.body.map(b => b.id).sort(),
    ['VT-MAN-271199-01-01', 'VT-MAN-271199-01B-01']
  );
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
  assert.equal((await db('trips').where({ id: past.body.id }).first()).status, 'upcoming');
  const pastDeparture = await db('departures').where({ tripId: past.body.id }).first();
  const pastGroup = await db('departure_groups').where({ departureId: pastDeparture.id }).first();
  assert.equal((await request('/api/bookings/groups', 'GET', undefined, true)).body.some(g => g.id === pastGroup.id), false);
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

});
