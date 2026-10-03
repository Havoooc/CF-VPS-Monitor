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

test('carrier timestamps survive normalization and older reports cannot roll back accepted routes', async () => {
  const { mergeRouteRecord } = await import('../src/utils/routeRecord.js');
  const previous = { telecom: 'CN2', carrier_meta: { telecom: { probed_at: '2026-10-03T00:00:00Z', status: 'ok' } } };
  const stale = { telecom: '163', carrier_meta: { telecom: { probed_at: '2026-10-01T00:00:00Z', last_attempt_at: '2026-10-04T00:00:00Z', status: 'failed' } } };
  const merged = mergeRouteRecord(previous, stale);
  assert.equal(merged.telecom, 'CN2');
  assert.equal(merged.carrier_meta.telecom.probed_at, previous.carrier_meta.telecom.probed_at);
  assert.equal(merged.carrier_meta.telecom.last_attempt_at, '2026-10-04T00:00:00Z');
  assert.equal(normalizeForwardRoutes({ ipv4: merged }).ipv4.carrier_meta.telecom.status, 'failed');
});

test('carrier meta drops only the malformed field instead of rejecting the record', () => {
  // 整条记录被拒 = 这次上报的该族路由全部跳过，代价远大于丢掉一个坏字段。
  const sanitized = normalizeForwardRoutes({
    ipv4: { telecom: 'CN2', carrier_meta: { telecom: { probed_at: 'invalid', reason: '证据段无联通骨干' } } }
  });
  assert.equal(sanitized.ipv4.telecom, 'CN2');
  assert.equal(sanitized.ipv4.carrier_meta.telecom.probed_at, undefined);
  assert.equal(sanitized.ipv4.carrier_meta.telecom.reason, '证据段无联通骨干');
});

test('route_path is dropped from new and legacy records', async () => {
  const { normalizeRouteMeta, stripRoutePaths, mergeRouteRecord } = await import('../src/utils/routeRecord.js');
  // 新数据：白名单里已经没有 route_path。
  assert.equal(normalizeRouteMeta({ telecom: { route_path: 'AS4809 → AS4134', status: 'ok' } }).telecom.route_path, undefined);
  // 历史残留：合并与出口都会剥掉（含以 JSON 字符串形态存放的 servers.return_route）。
  const legacy = { telecom: 'CN2', carrier_meta: { telecom: { probed_at: '2026-10-03T00:00:00Z', route_path: 'AS4809' } } };
  const merged = mergeRouteRecord(legacy, { telecom: 'CN2', carrier_meta: { telecom: { probed_at: '2026-10-03T00:00:00Z' } } });
  assert.equal(merged.carrier_meta.telecom.route_path, undefined);
  const asString = stripRoutePaths(JSON.stringify(legacy));
  assert.equal(typeof asString, 'string');
  assert.equal(asString.includes('route_path'), false);
  assert.equal(JSON.parse(asString).carrier_meta.telecom.probed_at, '2026-10-03T00:00:00Z');
});
