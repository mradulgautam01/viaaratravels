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

test('destination separators are saved cleanly and old mojibake is normalized', () => {
  const admin = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const upcoming = fs.readFileSync(path.join(publicDir, 'upcoming-trips.html'), 'utf8');

  assert.equal(admin.includes("destTags.join(' Â· ')"), false);
  assert.equal((admin.match(/destTags\.join\(' · '\)/g) || []).length, 2);
  for (const html of [index, upcoming]) {
    assert.match(html, /destinations\.replace\(\/\\u00c2\\u00b7\/g, '·'\)/);
  }
});

test('homepage testimonials include escaped approved reviews and fall back to defaults', async () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const defaults = html.indexOf('var DEFAULTS=[');
  const start = defaults < 0 ? -1 : html.lastIndexOf('(function(){', defaults);
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start);
  const script = html.slice(start, end);

  async function render(fetch) {
    const track = { innerHTML: '', style: {}, offsetHeight: 1 };
    const warnings = [];
    const context = vm.createContext({
      document: { getElementById: () => track },
      fetch,
      console: { warn: (...args) => warnings.push(args) }
    });
    vm.runInContext(script, context);
    await new Promise(resolve => setImmediate(resolve));
    return { track, warnings };
  }

  const success = await render(async () => ({
    ok: true,
    json: async () => [{ name: '<img>', trip: 'A & B', quote: '<script>bad</script>', stars: 4 }]
  }));
  assert.equal((success.track.innerHTML.match(/class="t-card"/g) || []).length, 12);
  assert.match(success.track.innerHTML, /&lt;img&gt;/);
  assert.match(success.track.innerHTML, /A &amp; B/);
  assert.match(success.track.innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(success.track.innerHTML, /<script>bad<\/script>/);

  const failure = await render(async () => { throw new Error('offline'); });
  assert.equal((failure.track.innerHTML.match(/class="t-card"/g) || []).length, 10);
  assert.equal(failure.warnings.length, 1);
});

for (const page of ['index.html']) {
  test(`${page} submits reviews through the API and reports failures`, async () => {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
    const start = html.indexOf('async function submitPublicReview(e){');
    const end = html.indexOf('</script>', start);
    assert.ok(start >= 0 && end > start);
    const values = {
      pubRvName: { value: ' Traveller ' },
      pubRvEmail: { value: ' traveller@example.com ' },
      pubRvTrip: { value: ' ' },
      pubRvQuote: { value: ' Great trip ' },
      pubRvStars: { value: '4' },
      rvPubWrap: { innerHTML: '' }
    };
    const button = { disabled: false, textContent: 'Submit Review →' };
    let response = { ok: true };
    let sent;
    let message;
    const context = vm.createContext({
      document: { getElementById: id => values[id] },
      fetch: async (url, options) => { sent = { url, options }; return response; },
      setTimeout() {},
      alert: value => { message = value; },
      console
    });
    vm.runInContext(html.slice(start, end), context);
    const event = { preventDefault() {}, currentTarget: { querySelector: () => button } };
    await context.submitPublicReview(event);
    assert.equal(sent.url, '/api/reviews');
    assert.deepEqual(JSON.parse(sent.options.body), {
      name: 'Traveller', email: 'traveller@example.com', trip: 'Viaara trip',
      quote: 'Great trip', stars: 4
    });
    assert.match(values.rvPubWrap.innerHTML, /Thank you!/);
    assert.equal(button.disabled, true);

    button.disabled = false;
    values.rvPubWrap.innerHTML = '';
    response = { ok: false, json: async () => ({ error: 'Invalid email address' }) };
    await context.submitPublicReview(event);
    assert.equal(message, 'Invalid email address');
    assert.equal(button.disabled, false);
    assert.equal(values.rvPubWrap.innerHTML, '');
  });
}

test('upcoming trips does not contain the review feature', () => {
  const html = fs.readFileSync(path.join(publicDir, 'upcoming-trips.html'), 'utf8');
  assert.doesNotMatch(html, /rvPubOverlay|rv-pub-modal|rv-fab|submitPublicReview|closeRvPub|setStars/);
});

test('admin reviews use the API and escape review content', async () => {
  const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
  const start = html.indexOf('/* -- REVIEWS -- */');
  const end = html.indexOf('/* -- BOOKINGS BADGE -- */', start);
  assert.ok(start >= 0 && end > start);
  assert.match(html, /page==='reviews'\)loadReviews\(\)/);
  const nodes = {
    reviewsTableWrap: { innerHTML: '' },
    rvId: { value: '' },
    rvName: { value: 'New Traveller' },
    rvEmail: { value: '' },
    rvTrip: { value: '' },
    rvQuote: { value: 'Great trip' },
    rvStars: { value: '1' },
    rvStatus: { value: 'published' },
    reviewModal: { style: {} }
  };
  const button = { disabled: false };
  const badge = { textContent: '', style: {} };
  const calls = [];
  const context = vm.createContext({
    document: {
      getElementById: id => nodes[id],
      querySelector: selector => selector === '#reviewModal .btn-primary' ? button : badge
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => opts.method === 'GET'
          ? [{ id: 7, name: '<img>', email: 'x@example.com', quote: '<script>bad</script>', stars: 1, status: 'pending' }]
          : { ok: true }
      };
    },
    showToast() {},
    showLogin() {},
    confirm: () => true,
    console
  });
  vm.runInContext(html.slice(start, end), context);
  await context.loadReviews();
  assert.match(nodes.reviewsTableWrap.innerHTML, /&lt;img&gt;/);
  assert.match(nodes.reviewsTableWrap.innerHTML, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.equal(badge.textContent, 1);

  await context.saveReview();
  const creation = calls.find(call => call.opts.method === 'POST');
  assert.equal(creation.url, '/api/reviews/admin');
  assert.equal(JSON.parse(creation.opts.body).status, 'published');
  assert.equal(JSON.parse(creation.opts.body).stars, 1);
  assert.equal(button.disabled, false);

  await context.updateReviewStatus(7, 'published');
  const update = calls.find(call => call.opts.method === 'PUT');
  assert.equal(update.url, '/api/reviews/7');
  assert.equal(JSON.parse(update.opts.body).status, 'published');
});
