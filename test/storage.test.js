const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('local storage upload and deletion security', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viaara-storage-'));
  const uploadDir = path.join(tempDir, 'uploads');
  const outsideFile = path.join(tempDir, 'important.txt');

  fs.writeFileSync(outsideFile, 'must remain untouched');

  process.env.STORAGE = 'local';
  process.env.LOCAL_UPLOAD_DIR = uploadDir;

  const storagePath = require.resolve('../lib/storage');
  delete require.cache[storagePath];
  const storage = require('../lib/storage');

  await t.test('uploads an image and returns its local URL', async () => {
    const buffer = Buffer.from('test-image-content');
    const filename = 'test-image.jpg';

    const url = await storage.uploadFile(buffer, filename, 'image/jpeg');

    assert.equal(url, '/uploads/test-image.jpg');
    assert.deepEqual(
      fs.readFileSync(path.join(uploadDir, filename)),
      buffer
    );
  });

  await t.test('deletes a valid uploaded image', async () => {
    const url = '/uploads/test-image.jpg';

    await storage.deleteFile(url);

    assert.equal(fs.existsSync(path.join(uploadDir, 'test-image.jpg')), false);
  });

  await t.test('rejects external URLs', async () => {
    await assert.rejects(
      storage.deleteFile('https://example.com/uploads/image.jpg'),
      /Invalid local image URL/
    );
  });

  await t.test('rejects path traversal attempts', async () => {
    const invalidUrls = [
      '/../important.txt',
      '/uploads/../important.txt',
      '/uploads/%2e%2e%2fimportant.txt',
      '/uploads/%2e%2e%5cimportant.txt',
      '/uploads/..',
      '/uploads/nested/image.jpg',
      '/uploads/image.jpg?delete=true',
      '/uploads/image.jpg#fragment',
      '\\uploads\\image.jpg',
    ];

    for (const url of invalidUrls) {
      await assert.rejects(
        storage.deleteFile(url),
        /Invalid local image URL/,
        `Expected rejection for ${url}`
      );
    }

    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'must remain untouched');
  });

  await t.test('rejects truthy non-string deletion targets', async () => {
    for (const value of [123, {}, []]) {
      await assert.rejects(
        storage.deleteFile(value),
        /Invalid local image URL/
      );
    }
  });

  await t.test('ignores missing deletion targets', async () => {
    await assert.doesNotReject(storage.deleteFile(null));
    await assert.doesNotReject(storage.deleteFile(undefined));
  });

  await t.test('does not fail when a valid image is already absent', async () => {
    await assert.doesNotReject(
      storage.deleteFile('/uploads/nonexistent.jpg')
    );
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('S3 storage rejects URLs outside the configured CloudFront domain', async () => {
  process.env.STORAGE = 's3';
  process.env.S3_BUCKET = 'viaara-test-bucket';
  process.env.CLOUDFRONT_URL = 'https://cdn.example.com';

  const storagePath = require.resolve('../lib/storage');
  delete require.cache[storagePath];
  const storage = require('../lib/storage');

  const invalidUrls = [
    'https://evil.example.com/trips/image.jpg',
    'http://cdn.example.com/trips/image.jpg',
    'https://cdn.example.com.evil.com/trips/image.jpg',
    'https://user@cdn.example.com/trips/image.jpg',
    'https://cdn.example.com/trips/../secret.jpg',
    'https://cdn.example.com/trips/image.jpg?delete=true',
  ];

  for (const url of invalidUrls) {
    await assert.rejects(
      storage.deleteFile(url),
      /Invalid Viaara|Invalid CloudFront/
    );
  }
});
