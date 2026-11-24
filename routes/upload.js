/**
 * Viaara image upload endpoint
 * Static images: optimized WebP
 * GIF images: preserved as GIF to retain animation
 */

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const storage = require('../lib/storage');

const router = express.Router();

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 82;

const ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
];

class InvalidImageError extends Error {}

function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { format: 'jpeg', mime: 'image/jpeg' };
  }

  if (buf.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  )) {
    return { format: 'png', mime: 'image/png' };
  }

  const gifHeader = buf.toString('latin1', 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { format: 'gif', mime: 'image/gif' };
  }

  if (
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { format: 'webp', mime: 'image/webp' };
  }

  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new InvalidImageError('Unsupported image type'));
    }
  }
});

function handleUpload(req, res, next) {
  upload.single('image')(req, res, err => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'Image is too large (max 8 MB)'
        });
      }

      console.warn('[upload] Multer error:', err.code);
      return res.status(400).json({
        error: 'Invalid upload request'
      });
    }

    if (err instanceof InvalidImageError) {
      return res.status(415).json({
        error: 'Only JPEG, PNG, WebP, and GIF images are allowed'
      });
    }

    console.error('[upload] Upload parsing failed:', err);
    return res.status(400).json({
      error: 'Invalid upload request'
    });
  });
}

async function optimizeImage(buffer, detectedType) {
  let image;

  try {
    image = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS
    });

    const metadata = await image.metadata();

    if (
      metadata.format !== detectedType.format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS
    ) {
      throw new InvalidImageError('Invalid image content or dimensions');
    }

    // Preserve GIF files to avoid destroying animation.
    if (detectedType.format === 'gif') {
      return {
        buffer,
        extension: '.gif',
        mime: 'image/gif',
        originalSize: buffer.length,
        optimizedSize: buffer.length,
        preserved: true
      };
    }

    const optimizedBuffer = await image
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({
        quality: WEBP_QUALITY,
        effort: 5
      })
      .toBuffer();

    return {
      buffer: optimizedBuffer,
      extension: '.webp',
      mime: 'image/webp',
      originalSize: buffer.length,
      optimizedSize: optimizedBuffer.length,
      preserved: false
    };
  } catch (err) {
    if (err instanceof InvalidImageError) throw err;

    throw new InvalidImageError('Image could not be decoded');
  }
}

// POST /api/upload
router.post('/', handleUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No image file provided'
      });
    }

    const detectedType = detectImageType(req.file.buffer);

    if (
      !detectedType ||
      detectedType.mime !== req.file.mimetype
    ) {
      return res.status(415).json({
        error: 'Image content does not match its declared type'
      });
    }

    const optimized = await optimizeImage(
      req.file.buffer,
      detectedType
    );

    const filename = `${uuidv4()}${optimized.extension}`;

    const url = await storage.uploadFile(
      optimized.buffer,
      filename,
      optimized.mime
    );

    const savings = optimized.preserved
      ? 0
      : Math.round(
          (1 - optimized.optimizedSize / optimized.originalSize) * 100
        );

    console.info('[upload] Image processed:', {
      format: optimized.mime,
      originalKB: Math.round(optimized.originalSize / 1024),
      outputKB: Math.round(optimized.optimizedSize / 1024),
      savings: `${savings}%`,
      animatedPreserved: optimized.preserved
    });

    res.json({ url });

  } catch (err) {
    if (err instanceof InvalidImageError) {
      return res.status(415).json({
        error: 'Invalid or unsupported image content'
      });
    }

    console.error('[upload] Upload failed:', err);

    res.status(500).json({
      error: 'Upload failed'
    });
  }
});

// DELETE /api/upload
router.delete('/', async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'url required'
      });
    }

    await storage.deleteFile(url);

    res.json({ ok: true });

  } catch (err) {
    console.error('[upload] Delete failed:', err);

    res.status(500).json({
      error: 'Delete failed'
    });
  }
});

module.exports = router;
