const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
function request(saved) {
  const url = 'https://example.test/game/';
  const network = Promise.withResolvers();
  const handlers = new Map();
  const writes = [];
  let reads = 0, timeout, response, saving;
  const cache = {
    match: async () => { reads++; return saved; },
    put: async (key, copy) => writes.push([key, copy])
  };
  vm.runInNewContext(source, {
    URL, fetch: () => network.promise, caches: { open: async () => cache },
    self: { location: new URL(url), addEventListener: (name, fn) => handlers.set(name, fn) },
    setTimeout: fn => { timeout = fn; return 1; }, clearTimeout: () => { timeout = null; }
  });
  handlers.get('fetch')({
    request: { url, method: 'GET', mode: 'navigate' },
    waitUntil: promise => { saving = promise; }, respondWith: promise => { response = promise; }
  });
  return { url, network, response, saving, writes, get reads() { return reads; }, get timeout() { return timeout; } };
}
const fresh = { ok: true, type: 'basic', clone: () => 'fresh copy' };

test('a fast network response refreshes the offline copy without reading it', async () => {
  const r = request('saved page');
  r.network.resolve(fresh);
  assert.equal(await r.response, fresh);
  await r.saving;
  assert.equal(r.reads, 0);
  assert.equal(r.timeout, null);
  assert.deepEqual(r.writes, [[r.url, 'fresh copy']]);
});

test('a slow response refreshes the cache after the saved page has been served', async () => {
  const r = request('saved page');
  r.timeout();
  assert.equal(await r.response, 'saved page');
  r.network.resolve(fresh);
  await r.saving;
  assert.deepEqual(r.writes, [[r.url, 'fresh copy']]);
});

test('cache misses wait for the network and offline requests use the saved page', async () => {
  const cold = request();
  cold.timeout();
  cold.network.resolve(fresh);
  assert.equal(await cold.response, fresh);
  const offline = request('saved page');
  offline.network.reject(new Error('offline'));
  assert.equal(await offline.response, 'saved page');
  assert.equal(offline.reads, 1);
});
