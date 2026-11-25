
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

const db = require('../db/db');
const { requireAdmin } = require('../lib/auth');
const storage = require('../lib/storage');

const router = express.Router();

const MAX_VIDEO_SIZE = 150 * 1024 * 1024;
const MAX_POSTER_SIZE = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 82;

const TYPES = {
  video: 'hero',
  poster: 'posters'
};

const FALLBACK_VIDEO = '/media/hero-varanasi.mp4';
const FALLBACK_POSTER = '/media/optimized/hero-poster.webp';

class InvalidMediaError extends Error {}

function sendError(res, action, err) {
  console.error(`[homepage-media] Failed to ${action}:`, err);
  return res.status(500).json({ error: 'Internal server error' });
}

function validSlot(value) {
  return value === '1' || value === '2';
}

function uploadMiddleware(field, maxSize, acceptedMime) {
  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSize, files: 1 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== acceptedMime) {
        return cb(new InvalidMediaError('Unsupported media type'));
      }
      cb(null, true);
    }
  });

  return (req, res, next) => {
    uploader.single(field)(req, res, err => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: `File exceeds the ${Math.round(maxSize / 1024 / 1024)} MB limit`
          });
        }

        return res.status(400).json({ error: 'Invalid upload request' });
      }

      if (err instanceof InvalidMediaError) {
        return res.status(415).json({ error: err.message });
      }

      console.error('[homepage-media] Upload parsing failed:', err);
      return res.status(400).json({ error: 'Invalid upload request' });
    });
  };
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (
    buffer[0] === 0xFF &&
    buffer[1] === 0xD8 &&
    buffer[2] === 0xFF
  ) {
    return { format: 'jpeg', mime: 'image/jpeg' };
  }

  if (buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  )) {
    return { format: 'png', mime: 'image/png' };
  }

  if (
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { format: 'webp', mime: 'image/webp' };
  }

  return null;
}

function isMp4(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;

  // ISO Base Media File Format / MP4 signature.
  return buffer.toString('ascii', 4, 8) === 'ftyp';
}

async function optimizePoster(buffer) {
  const detected = detectImageType(buffer);

  if (!detected) {
    throw new InvalidMediaError('Only JPEG, PNG, and WebP posters are supported');
  }

  try {
    const image = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS
    });

    const metadata = await image.metadata();

    if (
      metadata.format !== detected.format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS
    ) {
      throw new InvalidMediaError('Invalid poster image or dimensions');
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

    return optimizedBuffer;
  } catch (err) {
    if (err instanceof InvalidMediaError) throw err;
    throw new InvalidMediaError('Poster image could not be decoded');
  }
}

async function uploadAsset(req, res, type, slot) {
  const existing = await db('homepage_media_assets')
    .where({ type, slot: Number(slot) })
    .first();

  if (existing) {
    return res.status(409).json({
      error: `Homepage ${type} slot ${slot} is already occupied. Delete its inactive asset before uploading another.`
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  let buffer;
  let mime;
  let filename;

  if (type === 'hero') {
    if (!isMp4(req.file.buffer)) {
      return res.status(415).json({
        error: 'File content is not a valid MP4 container'
      });
    }

    buffer = req.file.buffer;
    mime = 'video/mp4';
    filename = `${uuidv4()}.mp4`;
  } else {
    buffer = await optimizePoster(req.file.buffer);
    mime = 'image/webp';
    filename = `${uuidv4()}.webp`;
  }

  const url = await storage.uploadHomepageFile(
    buffer,
    filename,
    mime,
    type
  );

  const id = uuidv4();
  try {
    await db('homepage_media_assets').insert({
      id,
      type,
      slot: Number(slot),
      filename,
      url,
      mime_type: mime,
      file_size: buffer.length
    });

  } catch (err) {
    // Avoid leaving an uploaded object behind if the DB insert fails.
    try {
      await storage.deleteHomepageFile(url, type);
    } catch (cleanupError) {
      console.error('[homepage-media] Upload cleanup failed:', cleanupError);
    }

    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        err.code === '23505') {
      return res.status(409).json({
        error: 'That slot was filled by another upload. Refresh and try again.'
      });
    }

    throw err;
  }

  const record = await db('homepage_media_assets')
    .where({ id })
    .first();

  return res.status(201).json({
    asset: record,
    message: 'Upload successful. Preview it before publishing.'
  });
}

// Public endpoint: returns only the currently published pair.
router.get('/public', async (req, res) => {
  try {
    const state = await db('homepage_media_state')
      .where({ id: 1 })
      .first();

    let video = null;
    let poster = null;

    if (state && state.video_asset_id) {
      video = await db('homepage_media_assets')
        .where({ id: state.video_asset_id, type: 'hero' })
        .first();
    }

    if (state && state.poster_asset_id) {
      poster = await db('homepage_media_assets')
        .where({ id: state.poster_asset_id, type: 'posters' })
        .first();
    }

    res.set('Cache-Control', 'no-store');

    return res.json({
      videoUrl: video ? video.url : FALLBACK_VIDEO,
      posterUrl: poster ? poster.url : FALLBACK_POSTER
    });
  } catch (err) {
    return sendError(res, 'load public media', err);
  }
});

// Admin: list all four slots and the currently published pair.
router.get('/', requireAdmin, async (req, res) => {
  try {
    const assets = await db('homepage_media_assets')
      .orderBy('type')
      .orderBy('slot');

    const state = await db('homepage_media_state')
      .where({ id: 1 })
      .first();

    res.set('Cache-Control', 'no-store');

    return res.json({
      assets: assets.map(asset => ({
        ...asset,
        active:
          asset.id === (state && state.video_asset_id) ||
          asset.id === (state && state.poster_asset_id)
      })),
      active: {
        videoId: state ? state.video_asset_id : null,
        posterId: state ? state.poster_asset_id : null
      }
    });
  } catch (err) {
    return sendError(res, 'load admin media', err);
  }
});

// Upload a video to an empty video slot.
router.post(
  '/video',
  requireAdmin,
  (req, res, next) => {
    if (!validSlot(req.query.slot)) {
      return res.status(400).json({ error: 'Slot must be 1 or 2' });
    }
    next();
  },
  uploadMiddleware('video', MAX_VIDEO_SIZE, 'video/mp4'),
  async (req, res) => {
    try {
      return await uploadAsset(req, res, TYPES.video, req.query.slot);
    } catch (err) {
      if (err instanceof InvalidMediaError) {
        return res.status(415).json({ error: err.message });
      }
      return sendError(res, 'upload video', err);
    }
  }
);

// Flexible poster MIME parser: JPEG, PNG, or WebP.
const posterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_POSTER_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new InvalidMediaError('Only JPEG, PNG, and WebP posters are supported'));
    }
    cb(null, true);
  }
});

router.post(
  '/poster',
  requireAdmin,
  (req, res, next) => {
    if (!validSlot(req.query.slot)) {
      return res.status(400).json({ error: 'Slot must be 1 or 2' });
    }

    posterUpload.single('poster')(req, res, err => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        return res.status(
          err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
        ).json({ error: 'Invalid poster upload' });
      }

      if (err instanceof InvalidMediaError) {
        return res.status(415).json({ error: err.message });
      }

      console.error('[homepage-media] Poster parsing failed:', err);
      return res.status(400).json({ error: 'Invalid poster upload' });
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No poster file provided' });
      }

      if (detectImageType(req.file.buffer)?.mime !== req.file.mimetype) {
        return res.status(415).json({
          error: 'Poster content does not match its declared type'
        });
      }

      return await uploadAsset(req, res, TYPES.poster, req.query.slot);
    } catch (err) {
      if (err instanceof InvalidMediaError) {
        return res.status(415).json({ error: err.message });
      }
      return sendError(res, 'upload poster', err);
    }
  }
);

// Publish a video and poster together in one database transaction.
router.post('/publish', requireAdmin, async (req, res) => {
  try {
    const { videoId, posterId } = req.body || {};

    if (
      typeof videoId !== 'string' ||
      typeof posterId !== 'string' ||
      !videoId ||
      !posterId
    ) {
      return res.status(400).json({
        error: 'Both videoId and posterId are required'
      });
    }

    await db.transaction(async trx => {
      const state = await trx('homepage_media_state')
        .where({ id: 1 })
        .forUpdate()
        .first();

      if (!state) throw new Error('Homepage media state is missing');

      const video = await trx('homepage_media_assets')
        .where({ id: videoId, type: 'hero' })
        .first();

      const poster = await trx('homepage_media_assets')
        .where({ id: posterId, type: 'posters' })
        .first();

      if (!video || !poster) {
        const err = new Error('Invalid video or poster selection');
        err.status = 400;
        throw err;
      }

      await trx('homepage_media_state')
        .where({ id: 1 })
        .update({
          video_asset_id: videoId,
          poster_asset_id: posterId,
          updated_at: trx.fn.now()
        });
    });

    return res.json({
      ok: true,
      message: 'Homepage video and poster published together'
    });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    return sendError(res, 'publish media', err);
  }
});

// Delete an unused asset. Published assets cannot be deleted.
router.delete('/:type/:slot', requireAdmin, async (req, res) => {
  const { type, slot } = req.params;
  const storageType = Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;

  if (!storageType || !validSlot(slot)) {
    return res.status(400).json({ error: 'Invalid media type or slot' });
  }

  try {
    await db.transaction(async trx => {
      const state = await trx('homepage_media_state')
        .where({ id: 1 })
        .forUpdate()
        .first();

      if (!state) throw new Error('Homepage media state is missing');

      const asset = await trx('homepage_media_assets')
        .where({ type: storageType, slot: Number(slot) })
        .first();

      if (!asset) {
        const err = new Error('Asset not found');
        err.status = 404;
        throw err;
      }

      if (
        asset.id === (state && state.video_asset_id) ||
        asset.id === (state && state.poster_asset_id)
      ) {
        const err = new Error('Published media cannot be deleted. Publish a replacement first.');
        err.status = 409;
        throw err;
      }

      // Delete the stored object before removing its database record.
      await storage.deleteHomepageFile(asset.url, storageType);

      await trx('homepage_media_assets')
        .where({ id: asset.id })
        .del();
    });

    return res.json({ ok: true });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return sendError(res, 'delete media', err);
  }
});

module.exports = router;
