const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const context = vm.createContext({ MODULES: {} });
for (const name of ['data.js', 'appearance.js']) {
  const start = html.indexOf(`MODULES["${name}"]=`);
  const next = html.indexOf('\nMODULES[', start + 1);
  vm.runInContext(html.slice(start, next), context);
}
const appearance = context.MODULES['appearance.js'];
const triangle = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3';
test('OBJ import accepts geometry beyond both former limits and negative indices', async () => {
  const source = triangle + '\n' + 'v 2 2 2\n'.repeat(4000) + 'f 1 2 3\n'.repeat(7000) + 'f -4003 -4002 -4001';
  const imported = await appearance.importWorkshopModel({ name: 'large.obj', text: async () => source });
  const parsed = appearance.parseWorkshopOBJ(imported.source);
  assert.equal(parsed.positions.length / 3, 4003);
  assert.equal(parsed.indices.length / 3, 7002);
  assert.equal(appearance.parseWorkshopOBJ('v NaN 0 0\nf 1 1 1'), null);
  assert.equal(appearance.parseWorkshopOBJ('v 0 0 0\nf 1 1 1'), null);
  assert.equal(appearance.parseWorkshopOBJ(triangle + '\nf 0 2 3'), null);
});
test('old single-model saves migrate and unrestricted transforms survive a save round trip', () => {
  const model = { source: triangle, x: 42, y: -20, z: 100, size: 30, rotation: 720, pitch: -275, roll: 540 };
  const migrated = appearance.normalizeAppearance({ model });
  assert.equal(migrated.models.length, 1);
  const restored = appearance.normalizeAppearance(JSON.parse(JSON.stringify({ models: Array(12).fill(model) })));
  assert.equal(restored.models.length, 12);
  for (const field of ['x', 'y', 'z', 'size', 'rotation', 'pitch', 'roll']) assert.equal(restored.models[11][field], model[field]);
  assert.equal(appearance.workshopItems(restored).length, 0);
  assert.equal(appearance.normalizeAppearance({ models: [], model }).models.length, 0);
  assert.equal(appearance.normalizeAppearance({ models: [{ ...model, x: Infinity, size: -1 }] }).models[0].size, .85);
});

const trackerCode = fs.readFileSync(path.join(root, 'visit-tracker.js'), 'utf8');
function tracker({ storage = new Map(), nav = {}, host = 'hswar.cz', referrer = '', response = { ok: true }, fail = false, blockedStorage = false } = {}) {
  const requests = [], timers = [], events = new Map();
  const env = {
    window: {}, location: { hostname: host, protocol: 'https:' },
    navigator: { language: 'cs-CZ', onLine: true, ...nav },
    document: { referrer, visibilityState: 'visible', addEventListener: (n, f) => events.set(n, f), removeEventListener: n => events.delete(n) },
    sessionStorage: { getItem: k => { if (blockedStorage) throw Error(); return storage.get(k); }, setItem: (k, v) => { if (blockedStorage) throw Error(); storage.set(k, v); } },
    crypto: require('node:crypto').webcrypto, Date, URL, AbortController,
    matchMedia: () => ({ matches: false }),
    addEventListener: (n, f) => events.set(n, f), removeEventListener: n => events.delete(n),
    setTimeout: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clearTimeout: () => {},
    fetch: async (url, options) => { requests.push({ url, ...options }); if (fail) throw Error('offline'); return response; }
  };
  vm.runInNewContext(trackerCode, env);
  env.window.HSWVisitTracker.start({ url: 'https://project.supabase.co', publishableKey: 'test-public-key' });
  return { requests, timers, events, storage };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('visit deduplication survives reload, while an expired visit gets a new ID', async () => {
  const first = tracker(); await settle();
  assert.equal(first.requests.length, 1);
  assert.equal(tracker({ storage: first.storage }).requests.length, 0);
  const previous = JSON.parse(first.storage.get('hsw-visit-v1'));
  first.storage.set('hsw-visit-v1', JSON.stringify({ ...previous, at: Date.now() - 31 * 60000 }));
  const next = tracker({ storage: first.storage });
  assert.equal(next.requests.length, 1);
  assert.notEqual(JSON.parse(next.requests[0].body).visit_id, previous.id);
});
test('privacy settings and local previews never send visits', () => {
  assert.equal(tracker({ nav: { doNotTrack: '1' } }).requests.length, 0);
  assert.equal(tracker({ nav: { globalPrivacyControl: true } }).requests.length, 0);
  assert.equal(tracker({ host: 'localhost' }).requests.length, 0);
  assert.equal(tracker({ nav: { onLine: false } }).requests.length, 0);
});
test('referrer is categorized without sending its URL, and storage failure does not break tracking', async () => {
  const run = tracker({ referrer: 'https://www.google.com/search?q=private-query', blockedStorage: true });
  await settle();
  const payload = JSON.parse(run.requests[0].body);
  assert.equal(payload.visit_source, 'search');
  assert.equal(Object.keys(payload).length, 4);
  assert.ok(!run.requests[0].body.includes('private-query'));
});
test('network retries keep the same ID and stop after three attempts', async () => {
  const run = tracker({ fail: true }); await settle();
  await run.timers.find(t => t.ms === 15000).f();
  await run.timers.find(t => t.ms === 30000).f();
  assert.equal(run.requests.length, 3);
  assert.equal(new Set(run.requests.map(r => JSON.parse(r.body).visit_id)).size, 1);
  assert.equal(run.events.size, 0);
});
test('missing database migration does not trigger repeated calls', async () => {
  const run = tracker({ response: { ok: false, status: 404 } }); await settle();
  assert.equal(run.requests.length, 1);
  assert.equal(run.timers.filter(t => t.ms >= 15000).length, 0);
  assert.equal(run.events.size, 0);
});
