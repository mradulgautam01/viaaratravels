const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const helpers = fs.readFileSync(path.join(publicDir, 'trip-ui.js'), 'utf8');

test('trip prices and metadata handle common input values', () => {
  const context = vm.createContext({});
  vm.runInContext(helpers, context);
  for (const [value, expected] of [
    [6499, '\u20b96499'], ['\u20b96,499', '\u20b96,499'],
    [0, '\u20b90'], ['TBD', 'TBD'], [null, '']
  ]) {
    assert.equal(context.formatTripPrice(value), expected);
  }
  assert.equal(context.tripMeta({ location: 'Manali', duration: '6D', dates: [] }), 'Manali \u00b7 6D');
  assert.equal(context.tripMeta({ location: 'Manali', dates: ['27 Nov'] }), 'Manali \u00b7 Next: 27 Nov');
  assert.equal(context.escapeTripText(context.formatTripPrice('<img onerror=1>')), '\u20b9&lt;img onerror=1&gt;');
});

test('upcoming trip actions route to booking and WhatsApp for the selected trip', () => {
  const html = fs.readFileSync(path.join(publicDir, 'upcoming-trips.html'), 'utf8');
  const functions = html.slice(html.indexOf('function bookCurrentTrip(){'), html.indexOf('// ===== TRIP DATA ====='));
  let opened;
  const context = vm.createContext({
    currentModalTripId: 'trip 1',
    TRIPS: { 'trip 1': { title: 'Manali', location: 'Manali', dates: ['27 Nov'], price: '6499' } },
    URLSearchParams,
    trackAnalytics() {},
    window: { location: {}, open(...args) { opened = args; } }
  });
  vm.runInContext(helpers + '\n' + functions, context);
  context.bookCurrentTrip();
  assert.equal(context.window.location.href, '/index.html?trip=trip+1&book=1');
  context.openTripWhatsApp();
  const url = new URL(opened[0]);
  assert.equal(url.origin + url.pathname, 'https://wa.me/918595919242');
  assert.match(url.searchParams.get('text'), /Manali/);
  assert.match(url.searchParams.get('text'), /\u20b96499/);
});
