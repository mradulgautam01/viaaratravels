const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('lead API validation, authorization and lifecycle', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-leads-test-'));
  const filename = path.join(dir, 'test.sqlite');

  process.env.DB_CLIENT = 'sqlite';
  process.env.SQLITE_PATH = filename;
  process.env.RATE_LIMIT_MAX = '10000';

  const root = path.resolve(__dirname, '..');
  const migration = spawnSync(process.execPath, ['db/migrate.js'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8'
  });
  assert.equal(migration.status, 0, migration.stderr);

  const db = require('../db/db');
  const express = require('express');
  const app = express();

  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { isAdmin: req.headers['x-test-admin'] === 'yes' };
    next();
  });
  app.use('/api/leads', require('../routes/leads'));

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
      headers: {
        ...(admin ? { 'x-test-admin': 'yes' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    return {
      status: response.status,
      body: await response.json()
    };
  }

  // Public submission should work without an admin session.
  const submission = await request('/api/leads', 'POST', {
    name: 'Test Traveler',
    phone: '9999999999',
    email: 'traveler@example.com',
    trip: 'Manali',
    message: 'Interested in the next departure'
  });

  assert.equal(submission.status, 201);

  // Public submissions must validate required fields and formats.
  assert.equal(
    (await request('/api/leads', 'POST', {
      phone: '9999999999'
    })).status,
    400
  );

  assert.equal(
    (await request('/api/leads', 'POST', {
      name: 'Test Traveler',
      phone: 'invalid'
    })).status,
    400
  );

  assert.equal(
    (await request('/api/leads', 'POST', {
      name: 'Test Traveler',
      phone: '9999999999',
      email: 'not-an-email'
    })).status,
    400
  );

  // Lead management and count endpoints require admin authorization.
  assert.equal((await request('/api/leads')).status, 401);
  assert.equal((await request('/api/leads/count/new')).status, 401);
  assert.equal((await request('/api/leads/1', 'PUT', { status: 'Contacted' })).status, 401);
  assert.equal((await request('/api/leads/1', 'DELETE')).status, 401);

  // Admin can list leads and retrieve the New count.
  const listing = await request('/api/leads', 'GET', undefined, true);
  assert.equal(listing.status, 200);
  assert.ok(Array.isArray(listing.body));

  const lead = listing.body.find(item => item.name === 'Test Traveler');
  assert.ok(lead, 'submitted lead should appear in admin list');

  const count = await request('/api/leads/count/new', 'GET', undefined, true);
  assert.equal(count.status, 200);
  assert.ok(Number(count.body.count) >= 1);

  // Valid status changes should work; invalid status values should fail.
  assert.equal(
    (await request(`/api/leads/${lead.id}`, 'PUT', { status: 'Contacted' }, true)).status,
    200
  );

  assert.equal(
    (await request(`/api/leads/${lead.id}`, 'PUT', { status: 'Booked' }, true)).status,
    400
  );

  assert.equal(
    (await request(`/api/leads/${lead.id}`, 'PUT', { status: 'Closed', name: 'Changed' }, true)).status,
    400
  );

  // Deletion should be idempotent, including repeated deletion.
  assert.equal(
    (await request(`/api/leads/${lead.id}`, 'DELETE', undefined, true)).status,
    200
  );

  assert.equal(
    (await request(`/api/leads/${lead.id}`, 'DELETE', undefined, true)).status,
    200
  );

  const remaining = await request('/api/leads', 'GET', undefined, true);
  assert.equal(remaining.body.some(item => Number(item.id) === Number(lead.id)), false);
});
