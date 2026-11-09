/**
 * routes/upload.js — Image upload endpoint
 *
 * POST /api/upload
 * Accepts: multipart/form-data with field "image"
 * Returns: { url: "..." }
 *
 * Local:  saved to ./uploads/,  URL = /uploads/<filename>
 * S3:     uploaded to S3,       URL = https://bucket.s3.region.amazonaws.com/trips/<filename>
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const storage  = require('../lib/storage');

const router = express.Router();

// Use memory storage so we can pass the buffer directly to our storage abstraction
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
  },
});

// ── POST /api/upload ──────────────────────────────────────────
router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const filename = `${uuidv4()}${ext}`;

    const url = await storage.uploadFile(req.file.buffer, filename, req.file.mimetype);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/upload — remove an image by URL ──────────────
router.delete('/', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    await storage.deleteFile(url);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
