/**
 * routes/analytics.js — View and click tracking
 */

const express = require('express');
const db = require('../db/db');
const { requireAdmin, publicWriteLimiter } = require('../lib/auth');

const router = express.Router();

const MAX_TRIP_ID_LENGTH = 64;
const EVENT_TYPES = ['view', 'click'];

function sendServerError(res, action, err) {
  console.error(`[analytics] Failed to ${action}:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// ── POST /api/analytics — track an event ─────────────────────
router.post('/', publicWriteLimiter, async (req, res) => {
  try {
    const { tripId: rawTripId, type } = req.body || {}; // type: 'view' | 'click'
    const tripId = typeof rawTripId === 'string' ? rawTripId.trim() : '';
    if (!tripId || typeof type !== 'string') {
      return res.status(400).json({ error: 'tripId and type required' });
    }
    if (tripId.length > MAX_TRIP_ID_LENGTH) {
      return res.status(400).json({ error: 'tripId is too long' });
    }
    if (!EVENT_TYPES.includes(type)) {
      return res.status(400).json({ error: "type must be 'view' or 'click'" });
    }
    await db('analytics').insert({
      tripId,
      type,
      ts:         Date.now(),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, 'record event', err);
  }
});

// ── GET /api/analytics/trip/:tripId — 7-day perf for one trip
router.get('/trip/:tripId', requireAdmin, async (req, res) => {
  try {
    const { tripId } = req.params;
    const now  = Date.now();
    const D7   = 7 * 24 * 60 * 60 * 1000;
    const D14  = 14 * 24 * 60 * 60 * 1000;

    const rows = await db('analytics')
      .where({ tripId })
      .where('ts', '>=', now - D14);

    const this7  = rows.filter(r => r.ts >= now - D7);
    const prev7  = rows.filter(r => r.ts >= now - D14 && r.ts < now - D7);

    const views      = this7.filter(r => r.type === 'view').length;
    const clicks     = this7.filter(r => r.type === 'click').length;
    const prevViews  = prev7.filter(r => r.type === 'view').length;

    let trend = 'New';
    if (prevViews > 0) {
      const pct = Math.round(((views - prevViews) / prevViews) * 100);
      trend = (pct >= 0 ? '+' : '') + pct + '%';
    } else if (views === 0) {
      trend = '—';
    }

    res.json({ views, clicks, trend });
  } catch (err) {
    sendServerError(res, 'get trip analytics', err);
  }
});

// ── GET /api/analytics/summary — all trips performance ───────
router.get('/summary', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const D14 = 14 * 24 * 60 * 60 * 1000;

    const rows = await db('analytics').where('ts', '>=', now - D14);

    // Group by tripId
    const map = {};
    rows.forEach(r => {
      if (!map[r.tripId]) map[r.tripId] = [];
      map[r.tripId].push(r);
    });

    const D7 = 7 * 24 * 60 * 60 * 1000;
    const result = {};
    for (const [tripId, events] of Object.entries(map)) {
      const this7     = events.filter(r => r.ts >= now - D7);
      const prev7     = events.filter(r => r.ts >= now - D14 && r.ts < now - D7);
      const views     = this7.filter(r => r.type === 'view').length;
      const clicks    = this7.filter(r => r.type === 'click').length;
      const prevViews = prev7.filter(r => r.type === 'view').length;
      let trend = 'New';
      if (prevViews > 0) {
        const pct = Math.round(((views - prevViews) / prevViews) * 100);
        trend = (pct >= 0 ? '+' : '') + pct + '%';
      } else if (views === 0) {
        trend = '—';
      }
      result[tripId] = { views, clicks, trend };
    }

    res.json(result);
  } catch (err) {
    sendServerError(res, 'get analytics summary', err);
  }
});

module.exports = router;
