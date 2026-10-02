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
