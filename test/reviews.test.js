const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('reviews API validation, authorization and lifecycle', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-reviews-test-'));
  const filename = path.join(dir, 'test.sqlite');
  process.env.DB_CLIENT = 'sqlite';
  process.env.SQLITE_PATH = filename;
  process.env.RATE_LIMIT_MAX = '10000';

  const migration = spawnSync(process.execPath, ['db/migrate.js'], {
    cwd: path.resolve(__dirname, '..'),
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
  app.use('/api/reviews', require('../routes/reviews'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}/api/reviews`;
  async function request(url, method = 'GET', body, admin = false) {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(admin ? { 'x-test-admin': 'yes' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  }

  const submission = await request('', 'POST', {
    name: 'Test Traveller',
    email: 'traveller@example.com',
    quote: 'A great trip',
    instanceId: 'x'.repeat(64),
    status: 'published'
  });
  assert.equal(submission.status, 201);
  const rows = await db('testimonials').select('*');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].email, 'traveller@example.com');
  assert.equal(rows[0].instanceId, 'x'.repeat(64));

  assert.equal((await request('', 'POST', { quote: 'Missing name' })).status, 400);
  assert.equal((await request('', 'POST', {
    name: 'Test Traveller', quote: 'Invalid rating', stars: 8
  })).status, 400);
  assert.equal((await request('', 'POST', {
    name: 'Test Traveller', email: 'invalid-email', quote: 'Invalid email'
  })).status, 400);
  const tooLongInstanceId = await request('', 'POST', {
    name: 'Test Traveller', quote: 'A great trip', instanceId: 'x'.repeat(65)
  });
  assert.equal(tooLongInstanceId.status, 400);
  assert.equal(tooLongInstanceId.body.error, 'instanceId is too long');

  assert.deepEqual((await request('/public')).body, []);
  assert.equal((await request('')).status, 401);

  const adminReviews = await request('', 'GET', undefined, true);
  assert.equal(adminReviews.status, 200);
  assert.equal(adminReviews.body.length, 1);
  assert.equal(adminReviews.body[0].email, 'traveller@example.com');
  assert.equal(adminReviews.body[0].status, 'pending');

  const id = adminReviews.body[0].id;
  assert.equal((await request(`/${id}`, 'PUT', { instanceId: 'y'.repeat(64) }, true)).status, 200);
  const invalidInstanceUpdate = await request(`/${id}`, 'PUT', { instanceId: 'y'.repeat(65) }, true);
  assert.equal(invalidInstanceUpdate.status, 400);
  assert.equal(invalidInstanceUpdate.body.error, 'instanceId is too long');
  assert.equal((await db('testimonials').where({ id }).first()).instanceId, 'y'.repeat(64));
  assert.equal((await request(`/${id}`, 'PUT', { status: 'published' })).status, 401);
  assert.equal((await request(`/${id}`, 'DELETE')).status, 401);
  assert.equal((await request(`/${id}`, 'PUT', { status: 'published' }, true)).status, 200);
  const publicReviews = await request('/public');
  assert.equal(publicReviews.status, 200);
  assert.equal(publicReviews.body.length, 1);
  assert.equal(publicReviews.body[0].quote, 'A great trip');
  assert.equal(publicReviews.body[0].status, 'published');
  assert.equal(Object.hasOwn(publicReviews.body[0], 'email'), false);

  assert.equal((await request(`/${id}`, 'PUT', {
    name: 'Updated Traveller', quote: 'Updated review text.', stars: 4
  }, true)).status, 200);
  const updated = await request('/public');
  assert.equal(updated.body[0].name, 'Updated Traveller');
  assert.equal(updated.body[0].quote, 'Updated review text.');
  assert.equal(updated.body[0].stars, 4);

  assert.equal((await request(`/${id}`, 'PUT', { status: 'invalid' }, true)).status, 400);
  assert.equal((await request(`/${id}`, 'PUT', { status: 'rejected' }, true)).status, 200);
  assert.deepEqual((await request('/public')).body, []);
  assert.equal((await request(`/${id}`, 'DELETE', undefined, true)).status, 200);
  assert.deepEqual((await request('', 'GET', undefined, true)).body, []);
  assert.equal((await request('/invalid', 'DELETE', undefined, true)).status, 400);

  const adminReview = {
    name: 'Admin Traveller', email: 'admin-review@example.com',
    quote: 'Created by an admin', stars: 1, status: 'published'
  };
  assert.equal((await request('/admin', 'POST', adminReview)).status, 401);
  assert.equal((await request('/admin', 'POST', adminReview, true)).status, 201);
  const publishedAdminReview = await request('/public');
  assert.equal(publishedAdminReview.body.length, 1);
  assert.equal(publishedAdminReview.body[0].stars, 1);
  assert.equal(publishedAdminReview.body[0].status, 'published');
  assert.equal(Object.hasOwn(publishedAdminReview.body[0], 'email'), false);
});
