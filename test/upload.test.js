const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');

test('image upload route validates and optimizes uploads', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-upload-'));
  const uploadDir = path.join(tempDir, 'uploads');
  const previousStorage = process.env.STORAGE;
  const previousUploadDir = process.env.LOCAL_UPLOAD_DIR;

  process.env.STORAGE = 'local';
  process.env.LOCAL_UPLOAD_DIR = uploadDir;

  const storagePath = require.resolve('../lib/storage');
  const routePath = require.resolve('../routes/upload');

  delete require.cache[routePath];
  delete require.cache[storagePath];

  const uploadRouter = require('../routes/upload');

  const app = express();
  let authorized = true;

  app.use((req, res, next) => {
    req.session = { isAdmin: authorized };
    next();
  });

  app.use('/api/upload', (req, res, next) => {
    if (!req.session.isAdmin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }, uploadRouter);

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
    delete require.cache[routePath];
    delete require.cache[storagePath];
    if (previousStorage === undefined) {
      delete process.env.STORAGE;
    } else {
      process.env.STORAGE = previousStorage;
    }

    if (previousUploadDir === undefined) {
      delete process.env.LOCAL_UPLOAD_DIR;
    } else {
      process.env.LOCAL_UPLOAD_DIR = previousUploadDir;
    }
  });

  async function upload(buffer, mime, filename = 'test-image') {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime }), filename);

    return fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: form
    });
  }

  async function makeImage(format) {
    const image = sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 30, g: 120, b: 80 }
      }
    });

    return image.toFormat(format).toBuffer();
  }

  await t.test('JPEG converts to WebP', async () => {
    const response = await upload(await makeImage('jpeg'), 'image/jpeg');
    assert.equal(response.status, 200);

    const result = await response.json();
    assert.match(result.url, /^\/uploads\/.+\.webp$/);

    const filename = path.basename(result.url);
    const outputPath = path.join(uploadDir, filename);
    assert.equal(fs.existsSync(outputPath), true);

    const metadata = await sharp(fs.readFileSync(outputPath)).metadata();
    assert.equal(metadata.format, 'webp');
  });

  await t.test('PNG converts to WebP', async () => {
    const response = await upload(await makeImage('png'), 'image/png');
    assert.equal(response.status, 200);

    const result = await response.json();
    assert.match(result.url, /\.webp$/);

    const outputPath = path.join(uploadDir, path.basename(result.url));
    const metadata = await sharp(fs.readFileSync(outputPath)).metadata();

    assert.equal(metadata.format, 'webp');
  });

  await t.test('WebP is accepted and stored as WebP', async () => {
    const response = await upload(await makeImage('webp'), 'image/webp');
    assert.equal(response.status, 200);

    const result = await response.json();
    assert.match(result.url, /\.webp$/);
  });

  await t.test('GIF is preserved without conversion', async () => {
    const gif = Buffer.from(
      'R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      'base64'
    );

    const response = await upload(gif, 'image/gif');
    assert.equal(response.status, 200);

    const result = await response.json();
    assert.match(result.url, /\.gif$/);

    const saved = fs.readFileSync(
      path.join(uploadDir, path.basename(result.url))
    );

    assert.deepEqual(saved, gif);
  });

  await t.test('rejects invalid image content', async () => {
    const response = await upload(
      Buffer.from('not an actual image'),
      'image/jpeg'
    );

    assert.equal(response.status, 415);
  });

  await t.test('rejects MIME and signature mismatch', async () => {
    const response = await upload(
      await makeImage('png'),
      'image/jpeg'
    );

    assert.equal(response.status, 415);
  });

  await t.test('rejects unauthenticated upload requests', async () => {
    authorized = false;

    const response = await upload(
      await makeImage('jpeg'),
      'image/jpeg'
    );

    assert.equal(response.status, 401);
    authorized = true;
  });
});
