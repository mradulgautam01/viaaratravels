/**
 * routes/analytics.js — View and click tracking
 */

const express = require('express');
const db = require('../db/db');

const router = express.Router();

// ── POST /api/analytics — track an event ─────────────────────
router.post('/', async (req, res) => {
  try {
    const { tripId, type } = req.body; // type: 'view' | 'click'
    if (!tripId || !type) return res.status(400).json({ error: 'tripId and type required' });
    await db('analytics').insert({
      tripId,
      type,
      ts:         Date.now(),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/trip/:tripId — 7-day perf for one trip
router.get('/trip/:tripId', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analytics/summary — all trips performance ───────
router.get('/summary', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
