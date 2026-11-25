
/**
 * Viaara image storage
 * Local development: ./uploads
 * Production: Private Amazon S3 + CloudFront
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } =
  require('@aws-sdk/client-s3');
const { fromIni } = require('@aws-sdk/credential-providers');

const mode = process.env.STORAGE || 'local';
const LOCAL_DIR = path.resolve(
  process.env.LOCAL_UPLOAD_DIR || './uploads'
);

const REGION = process.env.AWS_REGION || 'ap-south-1';
const BUCKET = process.env.S3_BUCKET;
const CLOUDFRONT_URL = (process.env.CLOUDFRONT_URL || '').replace(/\/+$/, '');

let s3;

function getS3() {
  if (!s3) {
    const clientConfig = { region: REGION };

    // Use AWS_PROFILE if set (local development with named credentials)
    if (process.env.AWS_PROFILE) {
      clientConfig.credentials = fromIni({
        profile: process.env.AWS_PROFILE
      });
    }
    // Otherwise, AWS SDK will use:
    // - EC2 IAM role (in production)
    // - Default credential chain (env vars, ~/.aws/credentials, etc.)

    s3 = new S3Client(clientConfig);
  }
  return s3;
}

async function uploadLocal(buffer, filename) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

// Extracts <filename> from "<prefix><filename>" after safe percent-decoding.
// Returns null unless the result is a single plain path component.
function extractFilename(encodedPath, prefix) {
  let decoded;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch (e) {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (!decoded.startsWith(prefix)) return null;

  const filename = decoded.slice(prefix.length);
  if (!filename || filename === '.' || filename === '..') return null;
  if (filename.includes('/')) return null;
  return filename;
}

// Raw URL strings must not contain backslashes or control characters (including
// null bytes); the WHATWG URL parser would otherwise silently rewrite them.
const UNSAFE_URL_CHARS = /[\\\u0000-\u001f\u007f]/;

async function deleteLocal(url) {
  if (typeof url !== 'string' || UNSAFE_URL_CHARS.test(url) || /[?#]/.test(url)) {
    throw new Error('Invalid local image URL');
  }

  const filename = extractFilename(url, '/uploads/');
  if (!filename) throw new Error('Invalid local image URL');

  const filePath = path.resolve(LOCAL_DIR, filename);
  if (path.dirname(filePath) !== LOCAL_DIR) {
    throw new Error('Invalid local image URL');
  }

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function uploadS3(buffer, filename, mimetype) {
  if (!BUCKET) throw new Error('S3_BUCKET is not configured');
  if (!CLOUDFRONT_URL) throw new Error('CLOUDFRONT_URL is not configured');

  const key = `trips/${filename}`;

  await getS3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream'
    // No public ACL: bucket remains private.
  }));

  return `${CLOUDFRONT_URL}/${key}`;
}

async function deleteS3(url) {
  if (!BUCKET) throw new Error('S3_BUCKET is not configured');
  if (!CLOUDFRONT_URL) throw new Error('CLOUDFRONT_URL is not configured');

  if (typeof url !== 'string' || UNSAFE_URL_CHARS.test(url) || /[?#]/.test(url)) {
    throw new Error('Invalid Viaara S3 image URL');
  }

  let parsed;
  let expected;
  try {
    parsed = new URL(url);
    expected = new URL(CLOUDFRONT_URL);
  } catch (e) {
    throw new Error('Invalid Viaara S3 image URL');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== expected.hostname ||
    parsed.port !== expected.port ||
    parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw new Error('Invalid Viaara CloudFront image URL');
  }

  const filename = extractFilename(parsed.pathname, '/trips/');
  if (!filename) throw new Error('Invalid Viaara S3 image URL');

  await getS3().send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: `trips/${filename}`
  }));
}

async function uploadFile(buffer, filename, mimetype) {
  if (mode === 's3') {
    return uploadS3(buffer, filename, mimetype);
  }
  return uploadLocal(buffer, filename);
}

async function deleteFile(url) {
  if (!url) return;

  if (mode === 's3') {
    return deleteS3(url);
  }
  return deleteLocal(url);
}

// Homepage media uses separate folders/prefixes.
// This deliberately does not change the existing trip media functions.
const HOMEPAGE_MEDIA_TYPES = ['hero', 'posters'];

function validateHomepageMediaType(type) {
  if (!HOMEPAGE_MEDIA_TYPES.includes(type)) {
    throw new Error('Invalid homepage media type');
  }
}

function validateHomepageFilename(filename) {
  if (
    typeof filename !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(filename) ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new Error('Invalid homepage media filename');
  }
}

async function uploadHomepageFile(buffer, filename, mimetype, type) {
  validateHomepageMediaType(type);
  validateHomepageFilename(filename);

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid homepage media buffer');
  }

  if (mode === 's3') {
    if (!BUCKET) throw new Error('S3_BUCKET is not configured');
    if (!CLOUDFRONT_URL) throw new Error('CLOUDFRONT_URL is not configured');

    const key = `homepage/${type}/${filename}`;

    await getS3().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable'
      // No public ACL: bucket remains private.
    }));

    return `${CLOUDFRONT_URL}/${key}`;
  }

  const folder = path.join(LOCAL_DIR, 'homepage', type);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, filename), buffer);

  return `/uploads/homepage/${type}/${filename}`;
}

async function deleteHomepageFile(url, type) {
  validateHomepageMediaType(type);

  if (!url) return;

  const prefix = `/homepage/${type}/`;

  if (mode === 's3') {
    if (!BUCKET) throw new Error('S3_BUCKET is not configured');
    if (!CLOUDFRONT_URL) throw new Error('CLOUDFRONT_URL is not configured');

    if (
      typeof url !== 'string' ||
      UNSAFE_URL_CHARS.test(url) ||
      /[?#]/.test(url)
    ) {
      throw new Error('Invalid homepage media URL');
    }

    let parsed;
    let expected;

    try {
      parsed = new URL(url);
      expected = new URL(CLOUDFRONT_URL);
    } catch (e) {
      throw new Error('Invalid homepage media URL');
    }

    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== expected.hostname ||
      parsed.port !== expected.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('Invalid homepage CloudFront URL');
    }

    const filename = extractFilename(parsed.pathname, prefix);

    if (!filename) {
      throw new Error('Invalid homepage media URL');
    }

    await getS3().send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: `homepage/${type}/${filename}`
    }));

    return;
  }

  if (
    typeof url !== 'string' ||
    UNSAFE_URL_CHARS.test(url) ||
    /[?#]/.test(url)
  ) {
    throw new Error('Invalid local homepage media URL');
  }

  const filename = extractFilename(
    url,
    `/uploads/homepage/${type}/`
  );

  if (!filename) {
    throw new Error('Invalid local homepage media URL');
  }

  const folder = path.resolve(LOCAL_DIR, 'homepage', type);
  const filePath = path.resolve(folder, filename);

  if (path.dirname(filePath) !== folder) {
    throw new Error('Invalid local homepage media path');
  }

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

module.exports = {
  uploadFile,
  deleteFile,
  uploadHomepageFile,
  deleteHomepageFile,
  mode
};
