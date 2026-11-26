/**
 * routes/analytics.js — View and click tracking
 */

const express = require('express');
const db = require('../db/db');
const { requireAdmin, publicWriteLimiter } = require('../lib/auth');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

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

// GET /api/analytics/ga4 — Google Analytics reporting
router.get('/ga4', requireAdmin, async (req, res) => {
  try {
    const period = Number(req.query.days || 30);

    if (![7, 30, 90].includes(period)) {
      return res.status(400).json({ error: 'days must be 7, 30, or 90' });
    }

    const propertyId = process.env.GA4_PROPERTY_ID;
    if (!propertyId) {
      return res.status(500).json({ error: 'GA4 property is not configured' });
    }

    const client = new BetaAnalyticsDataClient();
    const property = `properties/${propertyId}`;
    const dateRanges = [{
      startDate: `${period}daysAgo`,
      endDate: 'today'
    }];

    // Summary: unique users are calculated across the entire period.
    const [summary] = await client.runReport({
      property,
      dateRanges,
      metrics: [
        { name: 'totalUsers' },
        { name: 'activeUsers' },
        { name: 'newUsers' },
        { name: 'screenPageViews' },
        { name: 'sessions' },
        { name: 'engagementRate' },
        { name: 'userEngagementDuration' }
      ]
    });

    const values = summary.rows?.[0]?.metricValues || [];
    const number = index => Number(values[index]?.value || 0);

    // Daily report: chart values, not used to calculate unique period totals.
    const [daily] = await client.runReport({
      property,
      dateRanges,
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'sessions' }
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }]
    });

    const chart = (daily.rows || []).map(row => {
      const v = row.metricValues || [];
      const rawDate = row.dimensionValues?.[0]?.value || '';
      const date = rawDate.length === 8
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : rawDate;

      return {
        date,
        pageViews: Number(v[0]?.value || 0),
        activeUsers: Number(v[1]?.value || 0),
        sessions: Number(v[2]?.value || 0)
      };
    });

    // Traffic sources: sessions grouped by GA4 default channel.
    const [sourceReport] = await client.runReport({
      property,
      dateRanges,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [
        { metric: { metricName: 'sessions' }, desc: true }
      ],
      limit: 10
    });

    const sourceRows = (sourceReport.rows || []).map(row => ({
      channel: row.dimensionValues?.[0]?.value || '(not set)',
      sessions: Number(row.metricValues?.[0]?.value || 0)
    }));

    const totalSourceSessions = sourceRows.reduce(
      (sum, row) => sum + row.sessions, 0
    );

    const trafficSources = sourceRows.map(row => ({
      ...row,
      percentage: totalSourceSessions
        ? Number((row.sessions / totalSourceSessions * 100).toFixed(2))
        : 0
    }));

    res.set('Cache-Control', 'private, no-store');

    res.json({
      period,
      users: number(0),
      activeUsers: number(1),
      newUsers: number(2),
      pageViews: number(3),
      sessions: number(4),
      engagementRate: number(5),
      averageEngagementTime: number(6) / Math.max(number(1), 1),
      chart,
      trafficSources,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[GA4] Reporting failed:', err);
    res.status(500).json({
      error: 'Unable to retrieve GA4 analytics'
    });
  }
});

module.exports = router;
