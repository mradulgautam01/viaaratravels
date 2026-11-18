/**
 * routes/upload.js — Image upload endpoint
 *
 * POST /api/upload
 * Accepts: multipart/form-data with field "image"
 * Returns: { url: "..." }
 *
 * Local:  saved to ./uploads/,       URL = /uploads/<filename>
 * S3:     uploaded to private S3,    URL = CloudFront/trips/<filename>
 *
 * Authorization (admin only) is enforced in server.js.
 */

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const storage  = require('../lib/storage');

const router = express.Router();

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB max
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

class InvalidImageError extends Error {}

const WEBP_CHUNK_IDS = new Set(['VP8 ', 'VP8L', 'VP8X']);

// Structural WebP check (caller has already matched the RIFF/WEBP signature):
// the RIFF size must match the buffer, and the first chunk must be a known
// WebP image chunk whose declared length fits inside the file.
function isValidWebp(buf) {
  // 12-byte RIFF header + 8-byte chunk header
  if (buf.length < 20) return false;

  // RIFF size counts everything after the first 8 bytes
  if (buf.readUInt32LE(4) + 8 !== buf.length) return false;

  const chunkId = buf.toString('latin1', 12, 16);
  if (!WEBP_CHUNK_IDS.has(chunkId)) return false;

  const chunkLen = buf.readUInt32LE(16);
  if (chunkLen === 0) return false;
  if (chunkId === 'VP8X' && chunkLen !== 10) return false;

  // Chunk data is padded to an even length; the padding must also fit
  const chunkEnd = 20 + chunkLen + (chunkLen & 1);
  return chunkEnd <= buf.length;
}

// Detect the real image type from the file's leading bytes.
// Returns { ext, mime } or null when the buffer is not a supported image.
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  const gifHeader = buf.toString('latin1', 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { ext: '.gif', mime: 'image/gif' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return isValidWebp(buf) ? { ext: '.webp', mime: 'image/webp' } : null;
  }
  return null;
}

// Use memory storage so we can pass the buffer directly to our storage abstraction
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    // Cheap early rejection; the real check is the signature test in the handler.
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new InvalidImageError('Unsupported mimetype'));
  },
});

// Runs multer and maps its errors to appropriate, generic HTTP responses.
function handleUpload(req, res, next) {
  upload.single('image')(req, res, err => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Image is too large (max 8 MB)' });
      }
      console.warn('[upload] Multer error:', err.code, err.message);
      return res.status(400).json({ error: 'Invalid upload request' });
    }
    if (err instanceof InvalidImageError) {
      console.warn('[upload] Rejected file:', err.message);
      return res.status(415).json({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed' });
    }

    // Malformed multipart bodies etc.
    console.error('[upload] Upload parsing failed:', err);
    res.status(400).json({ error: 'Invalid upload request' });
  });
}

// ── POST /api/upload ──────────────────────────────────────────
router.post('/', handleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const type = detectImageType(req.file.buffer);
    if (!type) {
      console.warn('[upload] Rejected file: signature mismatch (declared %s)', req.file.mimetype);
      return res.status(415).json({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed' });
    }

    const filename = `${uuidv4()}${type.ext}`;

    const url = await storage.uploadFile(req.file.buffer, filename, type.mime);
    res.json({ url });
  } catch (err) {
    console.error('[upload] Upload failed:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── DELETE /api/upload — remove an image by URL ──────────────
router.delete('/', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
    await storage.deleteFile(url);
    res.json({ ok: true });
  } catch (err) {
    console.error('[upload] Delete failed:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
