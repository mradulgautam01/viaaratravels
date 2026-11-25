const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('reviews API validation, authorization, migration and lifecycle', async t => {
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
  const migrate = require('../db/migrate');
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

  // The one-time migration imports the five original homepage reviews.
  const initialReviews = await db('testimonials').select('*');
  assert.equal(initialReviews.length, 5);
  assert.deepEqual(
    initialReviews.map(review => review.name).sort(),
    ['Ananya K.', 'Nisha T.', 'Priya S.', 'Rahul M.', 'Siddharth V.'].sort()
  );
  assert.ok(initialReviews.every(review => review.status === 'approved'));
  assert.ok(initialReviews.every(review => review.rating === 5));
  assert.ok(initialReviews.every(review => review.email === ''));

  const migrationMarker = await db('app_migrations')
    .where({ id: '20261125_seed_initial_homepage_reviews_v1' })
    .first();

  assert.ok(migrationMarker);

  // A public submission must remain pending, regardless of supplied status.
  const submission = await request('', 'POST', {
    name: 'Test Traveller',
    email: 'traveller@example.com',
    quote: 'A great trip',
    instanceId: 'x'.repeat(64),
    status: 'published'
  });

  assert.equal(submission.status, 201);

  const submittedReview = await db('testimonials')
    .where({ name: 'Test Traveller' })
    .first();

  assert.ok(submittedReview);
  assert.equal(submittedReview.status, 'pending');
  assert.equal(submittedReview.email, 'traveller@example.com');
  assert.equal(submittedReview.instanceId, 'x'.repeat(64));

  assert.equal((await db('testimonials').count('* as count').first()).count, 6);

  assert.equal((await request('', 'POST', { quote: 'Missing name' })).status, 400);
  assert.equal((await request('', 'POST', {
    name: 'Test Traveller',
    quote: 'Invalid rating',
    stars: 8
  })).status, 400);
  assert.equal((await request('', 'POST', {
    name: 'Test Traveller',
    email: 'invalid-email',
    quote: 'Invalid email'
  })).status, 400);

  const tooLongInstanceId = await request('', 'POST', {
    name: 'Test Traveller',
    quote: 'A great trip',
    instanceId: 'x'.repeat(65)
  });

  assert.equal(tooLongInstanceId.status, 400);
  assert.equal(tooLongInstanceId.body.error, 'instanceId is too long');

  // Public API returns only the five approved imported reviews.
  const initialPublic = await request('/public');
  assert.equal(initialPublic.status, 200);
  assert.equal(initialPublic.body.length, 5);
  assert.ok(initialPublic.body.every(review => review.status === 'published'));
  assert.ok(initialPublic.body.every(review => !Object.hasOwn(review, 'email')));

  assert.equal((await request('')).status, 401);

  const adminReviews = await request('', 'GET', undefined, true);
  assert.equal(adminReviews.status, 200);
  assert.equal(adminReviews.body.length, 6);

  const adminSubmission = adminReviews.body.find(
    review => review.name === 'Test Traveller'
  );

  assert.ok(adminSubmission);
  assert.equal(adminSubmission.email, 'traveller@example.com');
  assert.equal(adminSubmission.status, 'pending');

  const id = adminSubmission.id;

  assert.equal(
    (await request(`/${id}`, 'PUT', { instanceId: 'y'.repeat(64) }, true)).status,
    200
  );

  const invalidInstanceUpdate = await request(
    `/${id}`,
    'PUT',
    { instanceId: 'y'.repeat(65) },
    true
  );

  assert.equal(invalidInstanceUpdate.status, 400);
  assert.equal(invalidInstanceUpdate.body.error, 'instanceId is too long');
  assert.equal((await db('testimonials').where({ id }).first()).instanceId, 'y'.repeat(64));

  assert.equal((await request(`/${id}`, 'PUT', { status: 'published' })).status, 401);
  assert.equal((await request(`/${id}`, 'DELETE')).status, 401);

  assert.equal(
    (await request(`/${id}`, 'PUT', { status: 'published' }, true)).status,
    200
  );

  const publicReviews = await request('/public');
  assert.equal(publicReviews.status, 200);
  assert.equal(publicReviews.body.length, 6);
  assert.equal(publicReviews.body.find(review => review.id === id).quote, 'A great trip');
  assert.equal(publicReviews.body.find(review => review.id === id).status, 'published');
  assert.equal(Object.hasOwn(publicReviews.body[0], 'email'), false);

  assert.equal(
    (await request(`/${id}`, 'PUT', {
      name: 'Updated Traveller',
      quote: 'Updated review text.',
      stars: 4
    }, true)).status,
    200
  );

  const updated = await request('/public');
  const updatedReview = updated.body.find(review => review.id === id);

  assert.equal(updatedReview.name, 'Updated Traveller');
  assert.equal(updatedReview.quote, 'Updated review text.');
  assert.equal(updatedReview.stars, 4);

  assert.equal((await request(`/${id}`, 'PUT', { status: 'invalid' }, true)).status, 400);
  assert.equal((await request(`/${id}`, 'PUT', { status: 'rejected' }, true)).status, 200);

  assert.equal((await request('/public')).body.length, 5);
  assert.equal((await request(`/${id}`, 'DELETE', undefined, true)).status, 200);

  const remainingAdminReviews = await request('', 'GET', undefined, true);
  assert.equal(remainingAdminReviews.body.length, 5);
  assert.equal((await request('/invalid', 'DELETE', undefined, true)).status, 400);

  // Deleting an imported review must not cause a later migration to restore it.
  const priya = await db('testimonials').where({ name: 'Priya S.' }).first();
  assert.ok(priya);

  assert.equal(
    (await request(`/${priya.id}`, 'DELETE', undefined, true)).status,
    200
  );

  await migrate();

  const afterRerun = await db('testimonials').select('*');
  assert.equal(afterRerun.length, 4);
  assert.equal(afterRerun.some(review => review.name === 'Priya S.'), false);

  const markerAfterRerun = await db('app_migrations')
    .where({ id: '20261125_seed_initial_homepage_reviews_v1' })
    .first();

  assert.ok(markerAfterRerun);

  // Admin-created reviews continue to support the existing workflow.
  const adminReview = {
    name: 'Admin Traveller',
    email: 'admin-review@example.com',
    quote: 'Created by an admin',
    stars: 1,
    status: 'published'
  };

  assert.equal((await request('/admin', 'POST', adminReview)).status, 401);
  assert.equal((await request('/admin', 'POST', adminReview, true)).status, 201);

  const publishedAdminReview = await request('/public');
  assert.equal(publishedAdminReview.body.length, 5);

  const createdReview = publishedAdminReview.body.find(
    review => review.name === 'Admin Traveller'
  );

  assert.ok(createdReview);
  assert.equal(createdReview.stars, 1);
  assert.equal(createdReview.status, 'published');
  assert.equal(Object.hasOwn(createdReview, 'email'), false);
});
