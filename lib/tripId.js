/**
 * tripId.js — Trip ID generator
 *
 * Template ID:  DEH-XXXXXXX  (prefix locked, suffix placeholder)
 * Instance ID:  DEH061126A   (prefix + DDMMYY + suffix letter A/B/C…)
 *
 * Rules:
 *  - Prefix = first 3 alpha chars of first destination word, uppercased
 *  - Date part = DDMMYY  (day, month, 2-digit year)
 *  - Suffix = A for first instance of that prefix+date, B for second, etc.
 */

const db = require('../db/db');

/**
 * Extract 3-char prefix from a destination string.
 * "Dehradun" → "DEH", "Meghalaya" → "MEG", "Leh Ladakh" → "LEH"
 */
function extractPrefix(destination) {
  if (!destination) return 'TRP';
  // Take first word (split on space, comma, ·, /, -)
  const firstWord = String(destination).trim().split(/[\s,·\/\-]/)[0];
  const alpha = firstWord.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return (alpha.substring(0, 3) || 'TRP');
}

/**
 * Given a trip object, return its 3-char prefix.
 * Uses trip.destinations[0] → trip.location → trip.title as fallback chain.
 */
function getPrefixForTrip(trip) {
  const dest =
    (Array.isArray(trip.destinations) && trip.destinations[0]) ||
    (typeof trip.destinations === 'string' && JSON.parse(trip.destinations || '[]')[0]) ||
    trip.location ||
    trip.title ||
    '';
  return extractPrefix(dest);
}

/**
 * Format a date as DDMMYY.
 * @param {string|Date} date — YYYY-MM-DD string or Date object
 */
function datePart(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return dd + mm + yy;
}

/**
 * Generate the next available instance ID for a given prefix + date.
 * Checks the DB for existing instances to avoid collisions.
 *
 * Returns e.g. "DEH061126A", "DEH061126B", …
 *
 * @param {string} prefix   — 3-char prefix e.g. "DEH"
 * @param {string} date     — YYYY-MM-DD
 * @returns {Promise<string>}
 */
async function nextInstanceId(prefix, date) {
  const base = prefix + datePart(date);
  // Find all existing instance IDs that start with this base
  const existing = await db('trip_instances')
    .where('id', 'like', base + '%')
    .pluck('id');

  if (!existing.length) return base + 'A';

  // Find the highest suffix letter used
  const letters = existing.map(id => id.slice(base.length)).filter(s => /^[A-Z]$/.test(s));
  if (!letters.length) return base + 'A';

  const maxCode = Math.max(...letters.map(l => l.charCodeAt(0)));
  if (maxCode >= 90) throw new Error(`Instance suffix exhausted for ${base} (> Z)`);
  return base + String.fromCharCode(maxCode + 1);
}

/**
 * Template placeholder ID shown in the trips table before any instance is created.
 * e.g. "DEH-XXXXXXX"
 */
function templateId(prefix) {
  return prefix + '-XXXXXXX';
}

module.exports = { extractPrefix, getPrefixForTrip, datePart, nextInstanceId, templateId };
