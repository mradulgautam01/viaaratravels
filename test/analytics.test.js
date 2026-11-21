const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('analytics API validates events and protects reporting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-analytics-test-'));
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
  app.use('/api/analytics', require('../routes/analytics'));

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

  const tripId = 'analytics-test-trip';

  // Valid public view and click events.
  for (const type of ['view', 'view', 'view', 'click']) {
    const result = await request('/api/analytics', 'POST', { tripId, type });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  }

  // Invalid event submissions.
  for (const body of [
    {},
    { tripId: '', type: 'view' },
    { tripId: '   ', type: 'view' },
    { tripId: 123, type: 'view' },
    { tripId, type: 'invalid' },
    { tripId: 'x'.repeat(65), type: 'view' },
    { tripId, type: 123 }
  ]) {
    assert.equal(
      (await request('/api/analytics', 'POST', body)).status,
      400
    );
  }

  // Reporting endpoints require admin authorization.
  assert.equal(
    (await request(`/api/analytics/trip/${tripId}`)).status,
    401
  );
  assert.equal(
    (await request('/api/analytics/summary')).status,
    401
  );

  // Add two previous-week views to verify trend calculations.
  const now = Date.now();
  const previousWeek = now - 8 * 24 * 60 * 60 * 1000;

  await db('analytics').insert([
    {
      tripId,
      type: 'view',
      ts: previousWeek,
      created_at: db.fn.now(),
      updated_at: db.fn.now()
    },
    {
      tripId,
      type: 'view',
      ts: previousWeek + 1000,
      created_at: db.fn.now(),
      updated_at: db.fn.now()
    }
  ]);

  // Per-trip reporting: 3 current views, 1 click, previous views = 2.
  const tripReport = await request(
    `/api/analytics/trip/${tripId}`,
    'GET',
    undefined,
    true
  );

  assert.equal(tripReport.status, 200);
  assert.deepEqual(tripReport.body, {
    views: 3,
    clicks: 1,
    trend: '+50%'
  });

  // Summary should report the same figures.
  const summary = await request(
    '/api/analytics/summary',
    'GET',
    undefined,
    true
  );

  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body[tripId], {
    views: 3,
    clicks: 1,
    trend: '+50%'
  });

  // Unknown trip IDs are currently accepted by the event API.
  const unknown = await request('/api/analytics', 'POST', {
    tripId: 'future-trip-reference',
    type: 'view'
  });
  assert.equal(unknown.status, 200);
});
