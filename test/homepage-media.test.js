const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const sharp = require('sharp');

test('homepage media uploads, publishing, and deletion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-homepage-media-'));
  process.env.DB_CLIENT = 'sqlite';
  process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
  process.env.STORAGE = 'local';
  process.env.LOCAL_UPLOAD_DIR = path.join(dir, 'uploads');

  const db = require('../db/db');
  const migrate = require('../db/migrate');
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const modulePath of ['../routes/homepage-media', '../lib/storage', '../db/migrate', '../db/db']) {
      delete require.cache[require.resolve(modulePath)];
    }
  });

  await migrate();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { isAdmin: req.headers['x-test-admin'] === 'yes' };
    next();
  });
  app.use('/api/homepage-media', require('../routes/homepage-media'));
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/homepage-media`;

  async function request(url, options = {}, admin = true) {
    const response = await fetch(base + url, {
      ...options,
      headers: { ...(admin ? { 'x-test-admin': 'yes' } : {}), ...options.headers }
    });
    return { status: response.status, body: await response.json() };
  }

  async function upload(type, slot, buffer, mime, admin = true) {
    const form = new FormData();
    form.append(type, new Blob([buffer], { type: mime }), 'upload');
    return request(`/${type}?slot=${slot}`, { method: 'POST', body: form }, admin);
  }

  const initial = await request('/public', {}, false);
  assert.deepEqual(initial.body, {
    videoUrl: '/media/hero-varanasi.mp4',
    posterUrl: '/media/optimized/hero-poster.webp'
  });
  assert.equal((await request('/', {}, false)).status, 401);
  assert.equal((await request('/publish', { method: 'POST' }, false)).status, 401);
  assert.equal((await request('/video/1', { method: 'DELETE' }, false)).status, 401);
  assert.equal((await request('/constructor/1', { method: 'DELETE' })).status, 400);

  const image = sharp({
    create: { width: 120, height: 80, channels: 3, background: '#1f7a4a' }
  });
  for (const [format, mime] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const result = await upload('poster', 1, await image.clone().toFormat(format).toBuffer(), mime);
    assert.equal(result.status, 201);
    assert.equal(result.body.asset.mime_type, 'image/webp');
    const file = path.join(dir, 'uploads', 'homepage', 'posters', result.body.asset.filename);
    assert.equal((await sharp(fs.readFileSync(file)).metadata()).format, 'webp');
    assert.equal((await request('/poster/1', { method: 'DELETE' })).status, 200);
    assert.equal(fs.existsSync(file), false);
  }

  const png = await image.clone().png().toBuffer();
  assert.equal((await upload('poster', 1, png, 'image/png', false)).status, 401);
  assert.equal((await upload('poster', 3, png, 'image/png')).status, 400);
  assert.equal((await upload('poster', 1, png, 'image/jpeg')).status, 415);
  assert.equal((await upload('poster', 1, Buffer.from('not an image'), 'image/png')).status, 415);
  assert.equal((await upload('video', 1, Buffer.from('not a video'), 'video/mp4')).status, 415);

  const poster = await upload('poster', 1, png, 'image/png');
  assert.equal(poster.status, 201);
  assert.equal((await upload('poster', 1, png, 'image/png')).status, 409);

  const videoBuffer = fs.readFileSync(path.join(__dirname, '..', 'public', 'media', 'hero-varanasi.mp4'));
  const video = await upload('video', 1, videoBuffer, 'video/mp4');
  assert.equal(video.status, 201);
  const videoId = video.body.asset.id;
  const posterId = poster.body.asset.id;
  const publish = body => request('/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal((await publish({ videoId, posterId: videoId })).status, 400);
  assert.equal((await publish({ videoId, posterId })).status, 200);

  const published = await request('/public', {}, false);
  assert.equal(published.body.videoUrl, video.body.asset.url);
  assert.equal(published.body.posterUrl, poster.body.asset.url);
  const listing = await request('/');
  assert.equal(listing.body.assets.filter(asset => asset.active).length, 2);
  assert.equal((await request('/video/1', { method: 'DELETE' })).status, 409);
  assert.equal((await request('/poster/1', { method: 'DELETE' })).status, 409);

  const replacement = await upload('poster', 2, png, 'image/png');
  assert.equal(replacement.status, 201);
  assert.equal((await publish({ videoId, posterId: replacement.body.asset.id })).status, 200);
  assert.equal((await request('/poster/1', { method: 'DELETE' })).status, 200);
  assert.equal((await request('/poster/1', { method: 'DELETE' })).status, 404);
  assert.equal((await request('/public', {}, false)).body.posterUrl, replacement.body.asset.url);
});

test('homepage media upload, publishing, authorization and deletion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-homepage-media-'));

  process.env.DB_CLIENT = 'sqlite';
  process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
  process.env.STORAGE = 'local';
  process.env.LOCAL_UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.RATE_LIMIT_MAX = '10000';

  const migration = spawnSync(process.execPath, ['db/migrate.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    encoding: 'utf8'
  });

  assert.equal(migration.status, 0, migration.stderr);

  const db = require('../db/db');
  const app = express();

  app.use(express.json());

  app.use((req, res, next) => {
    req.session = {
      isAdmin: req.headers['x-test-admin'] === 'yes'
    };
    next();
  });

  app.use('/api/homepage-media', require('../routes/homepage-media'));

  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}/api/homepage-media`;

  async function request(url, method = 'GET', options = {}) {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(options.admin ? { 'x-test-admin': 'yes' } : {}),
        ...(options.headers || {})
      },
      body: options.body
    });

    const body = await response.json();
    return { status: response.status, body };
  }

  function formFile(field, buffer, filename, mime) {
    const form = new FormData();
    form.append(field, new Blob([buffer], { type: mime }), filename);
    return form;
  }

  // Public endpoint must work without admin authentication.
  const initialPublic = await request('/public');
  assert.equal(initialPublic.status, 200);
  assert.equal(initialPublic.body.videoUrl, '/media/hero-varanasi.mp4');
  assert.equal(initialPublic.body.posterUrl, '/media/optimized/hero-poster.webp');

  // Admin listing must require authentication.
  assert.equal((await request('/')).status, 401);

  // Invalid slot must be rejected.
  assert.equal(
    (await request('/video?slot=3', 'POST', {
      admin: true,
      body: formFile('video', Buffer.from('invalid'), 'bad.mp4', 'video/mp4')
    })).status,
    400
  );

  // Upload a minimal ISO BMFF/MP4-signature test fixture.
  const mp4Fixture = Buffer.alloc(24);
  mp4Fixture.writeUInt32BE(24, 0);
  mp4Fixture.write('ftyp', 4, 'ascii');
  mp4Fixture.write('isom', 8, 'ascii');

  const videoUpload = await request('/video?slot=1', 'POST', {
    admin: true,
    body: formFile('video', mp4Fixture, 'test.mp4', 'video/mp4')
  });

  assert.equal(videoUpload.status, 201);
  assert.equal(videoUpload.body.asset.type, 'hero');
  assert.equal(videoUpload.body.asset.slot, 1);
  assert.equal(videoUpload.body.asset.mime_type, 'video/mp4');

  const videoId = videoUpload.body.asset.id;

  // A second upload cannot overwrite an occupied slot.
  assert.equal(
    (await request('/video?slot=1', 'POST', {
      admin: true,
      body: formFile('video', mp4Fixture, 'second.mp4', 'video/mp4')
    })).status,
    409
  );

  // Create a real JPEG using Sharp, then upload it as a poster.
  const jpeg = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 30, g: 120, b: 180 }
    }
  }).jpeg().toBuffer();

  const posterUpload = await request('/poster?slot=1', 'POST', {
    admin: true,
    body: formFile('poster', jpeg, 'poster.jpg', 'image/jpeg')
  });

  assert.equal(posterUpload.status, 201);
  assert.equal(posterUpload.body.asset.type, 'posters');
  assert.equal(posterUpload.body.asset.mime_type, 'image/webp');
  assert.ok(posterUpload.body.asset.filename.endsWith('.webp'));

  const posterId = posterUpload.body.asset.id;

  // Both selected assets must exist before publishing.
  assert.equal(
    (await request('/publish', 'POST', {
      admin: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, posterId: 'invalid' })
    })).status,
    400
  );

  const publish = await request('/publish', 'POST', {
    admin: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoId, posterId })
  });

  assert.equal(publish.status, 200);

  // Public endpoint exposes the published pair.
  const published = await request('/public');
  assert.equal(published.status, 200);
  assert.equal(published.body.videoUrl, videoUpload.body.asset.url);
  assert.equal(published.body.posterUrl, posterUpload.body.asset.url);

  // Published assets cannot be deleted.
  assert.equal(
    (await request('/video/1', 'DELETE', { admin: true })).status,
    409
  );

  assert.equal(
    (await request('/poster/1', 'DELETE', { admin: true })).status,
    409
  );

  // Admin listing identifies the active assets.
  const listing = await request('/', 'GET', { admin: true });
  assert.equal(listing.status, 200);
  assert.equal(listing.body.assets.length, 2);
  assert.ok(listing.body.assets.every(asset => asset.active));

  // Upload a second video and poster into the other slots.
  const secondVideo = await request('/video?slot=2', 'POST', {
    admin: true,
    body: formFile('video', mp4Fixture, 'second.mp4', 'video/mp4')
  });

  const secondPoster = await request('/poster?slot=2', 'POST', {
    admin: true,
    body: formFile('poster', jpeg, 'second.jpg', 'image/jpeg')
  });

  assert.equal(secondVideo.status, 201);
  assert.equal(secondPoster.status, 201);

  // Unpublished assets can be deleted.
  assert.equal(
    (await request('/video/2', 'DELETE', { admin: true })).status,
    200
  );

  assert.equal(
    (await request('/poster/2', 'DELETE', { admin: true })).status,
    200
  );

  // Existing published pair remains unchanged.
  const stillPublished = await request('/public');
  assert.equal(stillPublished.body.videoUrl, videoUpload.body.asset.url);
  assert.equal(stillPublished.body.posterUrl, posterUpload.body.asset.url);
});
