const express = require('express');
const db = require('../db/db');
const { requireAdmin, publicWriteLimiter } = require('../lib/auth');

const router = express.Router();

const LIMITS = {
  name: 100,
  email: 254,
  trip: 200,
  quote: 3000,
  instanceId: 64
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ['published', 'pending', 'rejected'];

function sendServerError(res, action, err) {
  console.error(`[reviews] Failed to ${action}:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// Translate database records into the existing frontend format.
function formatReview(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email || '',
    trip: row.trip || '',
    instanceId: row.instanceId || '',
    quote: row.body || '',
    stars: Number(row.rating) || 5,
    status: row.status === 'approved' ? 'published' : row.status,
    date: row.created_at
      ? new Date(row.created_at).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        })
      : ''
  };
}

function validateReview(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request' };
  }

  const fields = {};
  const allowed = ['name', 'email', 'trip', 'instanceId', 'quote', 'stars', 'status'];

  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return { error: `Unexpected field: ${key}` };
    }
  }

  for (const key of ['name', 'email', 'trip', 'quote', 'instanceId']) {
    if (partial && body[key] === undefined) continue;

    const value = body[key] === undefined || body[key] === null
      ? ''
      : body[key];

    if (typeof value !== 'string') {
      return { error: `${key} must be text` };
    }

    const trimmed = value.trim();

    if (trimmed.length > LIMITS[key] && LIMITS[key] !== undefined) {
      return { error: `${key} is too long` };
    }

    fields[key] = trimmed;
  }

  if (!partial && (!fields.name || !fields.quote)) {
    return { error: 'Name and review are required' };
  }

  if (fields.name !== undefined && !fields.name) {
    return { error: 'Name is required' };
  }

  if (fields.quote !== undefined && !fields.quote) {
    return { error: 'Review is required' };
  }

  if (fields.email && !EMAIL_RE.test(fields.email)) {
    return { error: 'Invalid email address' };
  }

  if (body.stars !== undefined) {
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return { error: 'Rating must be between 1 and 5' };
    }
    fields.rating = stars;
  } else if (!partial) {
    fields.rating = 5;
  }

  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
      return { error: 'Invalid review status' };
    }
    fields.status = body.status === 'published' ? 'approved' : body.status;
  }

  if (body.instanceId !== undefined) {
    fields.instanceId = fields.instanceId || null;
  }

  return { fields };
}

// GET /api/reviews/public — approved reviews only
router.get('/public', async (req, res) => {
  try {
    const rows = await db('testimonials')
      .where({ status: 'approved' })
      .orderBy('created_at', 'desc');

    res.json(rows.map(row => {
      const { email, ...review } = formatReview(row);
      return review;
    }));
  } catch (err) {
    sendServerError(res, 'list public reviews', err);
  }
});

// GET /api/reviews — admin review listing
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await db('testimonials').orderBy('created_at', 'desc');
    res.json(rows.map(formatReview));
  } catch (err) {
    sendServerError(res, 'list reviews', err);
  }
});

async function createReview(req, res, isAdmin) {
  try {
    const result = validateReview(req.body);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    const fields = result.fields;

    await db('testimonials').insert({
      name: fields.name,
      email: fields.email || '',
      trip: fields.trip || 'Viaara trip',
      instanceId: fields.instanceId || null,
      rating: fields.rating,
      body: fields.quote,
      status: isAdmin ? (fields.status || 'pending') : 'pending',
      created_at: db.fn.now(),
      updated_at: db.fn.now()
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    sendServerError(res, 'create review', err);
  }
}

// POST /api/reviews — public submission
router.post('/', publicWriteLimiter, (req, res) => {
  return createReview(req, res, false);
});

// POST /api/reviews/admin — admin-created review
router.post('/admin', requireAdmin, (req, res) => {
  return createReview(req, res, true);
});

// PUT /api/reviews/:id — admin edit/status update
router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid review ID' });
  }

  const result = validateReview(req.body, true);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const fields = result.fields;
  const updates = {};

  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.email !== undefined) updates.email = fields.email;
  if (fields.trip !== undefined) updates.trip = fields.trip;
  if (fields.instanceId !== undefined) updates.instanceId = fields.instanceId;
  if (fields.quote !== undefined) updates.body = fields.quote;
  if (fields.rating !== undefined) updates.rating = fields.rating;
  if (fields.status !== undefined) updates.status = fields.status;

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No review fields supplied' });
  }

  try {
    updates.updated_at = db.fn.now();

    const updated = await db('testimonials')
      .where({ id })
      .update(updates);

    if (!updated) {
      return res.status(404).json({ error: 'Review not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, 'update review', err);
  }
});

// DELETE /api/reviews/:id — admin only
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid review ID' });
  }

  try {
    await db('testimonials').where({ id }).delete();
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, 'delete review', err);
  }
});

module.exports = router;
