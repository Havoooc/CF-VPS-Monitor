import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { normalizeForwardRoutes, getForwardRoutes, saveForwardRoutes } from '../src/utils/forwardRoutes.js';

test('manual routes validate fields and keep address families separate', () => {
  const result = normalizeForwardRoutes({ ipv4: { telecom: ' CN2 GIA ', region: '上海' }, ipv6: { telecom: '普通国际' } });
  assert.equal(result.ipv4.telecom, 'CN2 GIA');
  assert.equal(result.ipv6.telecom, '普通国际');
  assert.throws(() => normalizeForwardRoutes({ ipv4: { telecom: 123 } }));
  assert.throws(() => normalizeForwardRoutes({ ipv4: { probed_at: 'invalid' } }));
  assert.throws(() => normalizeForwardRoutes({ ipv4: { source: 'x'.repeat(161) } }));
});

test('manual routes persist and invalidate cached values without changing server schema', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("OK"); } }', d1Databases: { DB: 'forward-routes-test' } });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    await saveForwardRoutes(db, 'node-1', { ipv4: { telecom: 'CN2 GIA', source: '自有探针', probed_at: '2026-10-03T00:00:00Z' } });
    assert.equal((await getForwardRoutes(db))['node-1'].ipv4.telecom, 'CN2 GIA');
    await saveForwardRoutes(db, 'node-1', { ipv6: { telecom: '普通国际' } });
    const routes = await getForwardRoutes(db);
    assert.equal(routes['node-1'].ipv4.telecom, undefined);
    assert.equal(routes['node-1'].ipv6.telecom, '普通国际');
  } finally { await mf.dispose(); }
});
