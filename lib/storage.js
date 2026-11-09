/**
 * storage.js — File storage abstraction
 *
 * Local (dev):   saves to ./uploads/ on disk, serves via Express static
 * S3 (prod):     uploads to AWS S3, returns a public CDN URL
 *
 * Both modes expose the same interface:
 *   uploadFile(buffer, filename, mimetype) → Promise<string>  (URL)
 *   deleteFile(url)                        → Promise<void>
 *
 * Switch by setting STORAGE=local or STORAGE=s3 in .env
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const mode = process.env.STORAGE || 'local';

// ── Local storage ─────────────────────────────────────────────
const LOCAL_DIR = path.resolve(process.env.LOCAL_UPLOAD_DIR || './uploads');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function uploadLocal(buffer, filename) {
  ensureDir(LOCAL_DIR);
  const dest = path.join(LOCAL_DIR, filename);
  fs.writeFileSync(dest, buffer);
  // Return a URL path that Express serves as /uploads/<filename>
  return `/uploads/${filename}`;
}

async function deleteLocal(url) {
  const filename = path.basename(url);
  const dest = path.join(LOCAL_DIR, filename);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
}

// ── S3 storage ────────────────────────────────────────────────
let s3;
function getS3() {
  if (!s3) {
    const AWS = require('aws-sdk');
    AWS.config.update({
      region:          process.env.AWS_REGION          || 'ap-south-1',
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    });
    s3 = new AWS.S3();
  }
  return s3;
}

async function uploadS3(buffer, filename, mimetype) {
  const bucket = process.env.S3_BUCKET;
  const key    = `trips/${filename}`;
  await getS3().putObject({
    Bucket:      bucket,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype || 'application/octet-stream',
    ACL:         'public-read',
  }).promise();
  return `https://${bucket}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
}

async function deleteS3(url) {
  const bucket = process.env.S3_BUCKET;
  // Extract key from URL: everything after the bucket domain
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const key   = parts.join('/');
  await getS3().deleteObject({ Bucket: bucket, Key: key }).promise();
}

// ── Public interface ──────────────────────────────────────────
async function uploadFile(buffer, filename, mimetype) {
  if (mode === 's3') return uploadS3(buffer, filename, mimetype);
  return uploadLocal(buffer, filename);
}

async function deleteFile(url) {
  if (!url) return;
  if (mode === 's3') return deleteS3(url);
  return deleteLocal(url);
}

module.exports = { uploadFile, deleteFile, mode };
