/**
 * routes/leads.js — Leads / enquiry management
 */

const express = require('express');
const db = require('../db/db');

const router = express.Router();

// ── GET /api/leads ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const leads = await db('leads').orderBy('created_at', 'desc');
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/count/new — badge count ───────────────────
router.get('/count/new', async (req, res) => {
  try {
    const [{ count }] = await db('leads').where({ status: 'New' }).count('id as count');
    res.json({ count: parseInt(count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads — submit enquiry (from public site) ───────
router.post('/', async (req, res) => {
  try {
    const { name, phone, email, trip, tripId, instanceId, message } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

    await db('leads').insert({
      name,
      phone:      phone || '',
      email:      email || '',
      trip:       trip || '',
      tripId:     tripId || null,
      instanceId: instanceId || null,
      message:    message || 'Requested quote via website',
      status:     'New',
      date:       new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/leads/:id — update status ────────────────────────
router.put('/:id', async (req, res) => {
  try {
    await db('leads').where({ id: req.params.id }).update({
      ...req.body,
      updated_at: db.fn.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/leads/:id ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await db('leads').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
