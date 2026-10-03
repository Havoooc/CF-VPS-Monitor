import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache } from '../src/utils/boundedCache.js';
import { clearAllCaches, getAllServers } from '../src/utils/cache.js';
import { encryptTurnstileData, isTurnstileVerified } from '../src/middleware/turnstile.js';
import { applyCors } from '../src/utils/cors.js';

test('cache expires records and evicts least recently accessed entries', () => {
  const cache = new BoundedCache(2);
  cache.set('expired', 0, -1);
  assert.equal(cache.get('expired'), undefined);
  cache.set('a', 1, 10000);
  cache.set('b', 2, 10000);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3, 10000);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('server list callers cannot overwrite cached server fields', async () => {
  clearAllCaches();
  const db = { prepare: () => ({ all: async () => ({ results: [{ id: 'node', name: 'original' }] }) }) };
  const first = await getAllServers(db);
  first[0].name = 'changed';
  assert.equal((await getAllServers(db))[0].name, 'original');
  clearAllCaches();
});

test('encrypted verification rejects expired, tampered and wrong-secret credentials', async () => {
  const env = { API_SECRET: 'test-secret-for-verification' };
  const token = await encryptTurnstileData({ expires: Date.now() / 1000 + 60 }, env, {});
  const request = value => new Request('https://monitor.example/api/config', { headers: { 'X-Turnstile-Verified': value } });
  assert.equal(await isTurnstileVerified(request(token), env, {}), true);
  assert.equal(await isTurnstileVerified(request(token), { API_SECRET: 'other' }, {}), false);
  assert.equal(await isTurnstileVerified(request('invalid'), env, {}), false);
  const expired = await encryptTurnstileData({ expires: 1 }, env, {});
  assert.equal(await isTurnstileVerified(request(expired), env, {}), false);
});

test('verified credential does not grant cross-origin access outside whitelist', async () => {
  const token = await encryptTurnstileData({ expires: Date.now() / 1000 + 60 }, { API_SECRET: 'test-secret' }, {});
  for (const origin of ['https://allowed.example', 'https://untrusted.example']) {
    const request = new Request('https://monitor.example/api/config', { headers: { Origin: origin, 'X-Turnstile-Verified': token } });
    assert.equal(await isTurnstileVerified(request, { API_SECRET: 'test-secret' }, {}), true);
    const response = applyCors(new Response('{}'), request, ['https://allowed.example']);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin === 'https://allowed.example' ? origin : null);
  }
});


test('route cache coalesces cold reads and isolates database bindings', async () => {
  const { createRouteStore } = await import('../src/utils/routeStore.js');
  const store = createRouteStore({ keyPrefix: 'route:', invalidError: 'invalid', invalidDateError: 'date' });
  let reads = 0;
  const db = { prepare: () => ({ all: async () => { reads++; await new Promise(resolve => setImmediate(resolve)); return { results: [{ key: 'route:node', value: JSON.stringify({ ipv4: { telecom: 'CN2' } }) }] }; } }) };
  const [a, b] = await Promise.all([store.getAll(db), store.getAll(db)]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  const other = { prepare: () => ({ all: async () => ({ results: [] }) }) };
  assert.deepEqual(await store.getAll(other), {});
});

test('route write invalidates an in-flight cache fill', async () => {
  const { createRouteStore } = await import('../src/utils/routeStore.js');
  const store = createRouteStore({ keyPrefix: 'route:', invalidError: 'invalid', invalidDateError: 'date' });
  let release;
  let reads = 0;
  const db = { prepare: () => ({
    bind() { return this; }, run: async () => ({ meta: { changes: 1 } }),
    all: async () => { reads++; if (reads === 1) await new Promise(resolve => { release = resolve; }); return { results: [] }; }
  }) };
  const oldRead = store.getAll(db);
  await store.save(db, 'node', { ipv4: { telecom: 'CN2' } });
  await store.getAll(db);
  release();
  await oldRead;
  await store.getAll(db);
  assert.equal(reads, 2);
});


test('REST replay opt-out skips DO queries while legacy clients keep replay', async () => {
  const { handleServersAPI, handleServerAPI } = await import('../src/handlers/dashboard.js');
  const server = { id: 'node', name: 'Node', region: 'US', history_partition_id: 1, timestamp: 0 };
  let calls = 0;
  const env = {
    DB: { prepare: sql => ({
      bind() { return this; },
      all: async () => ({ results: sql.includes('FROM servers') ? [server] : [] }),
      first: async () => sql.includes('FROM servers') ? server : ({ timestamp: Date.now(), cpu: 1 })
    }) },
    METRICS_BROADCASTER: { idFromName: () => 'global', get: () => ({ fetch: async () => {
      calls++; return Response.json({ updates: [] });
    } }) }
  };
  const sys = { is_public: 'true', show_three_net_details: 'false' };
  try {
    for (const [handler, path] of [[handleServersAPI, '/api/servers'], [handleServerAPI, '/api/server?id=node']]) {
      clearAllCaches();
      const separator = path.includes('?') ? '&' : '?';
      const before = calls;
      const light = await handler(new Request(`https://test.invalid${path}${separator}include_replay=0`), env, sys);
      assert.equal(light.status, 200);
      assert.deepEqual((await light.json()).latestReportUpdates, []);
      assert.equal(calls, before);
      const legacy = await handler(new Request(`https://test.invalid${path}`), env, sys);
      assert.equal(legacy.status, 200);
      assert.equal(calls, before + 1);
    }
  } finally { clearAllCaches(); }
});
