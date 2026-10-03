import { normalizeRouteMeta } from './routeRecord.js';

const families = ['ipv4', 'ipv6'];
const fields = ['telecom', 'unicom', 'mobile', 'region', 'source', 'probed_at', 'last_attempt_at'];
const CACHE_TTL_MS = 30000;

/**
 * 建一个「按节点存两族路由」的读写器。
 *
 * 去程（forward_route:<id>）与回程快照（return_snapshot:<id>）的归一化规则、30s
 * 模块级缓存、upsert 语句完全一致，差别只有 key 前缀和错误标识，所以共用一份实现，
 * 避免两份代码各自演化（历史上回程那份连错误串都是照抄去程的 'invalidForwardRoutes'）。
 *
 * 注意：getAll 返回的是缓存对象本身。调用方若要修改，必须先浅拷贝，否则会把派生
 * 数据写回缓存、并随下一次 save 持久化。
 */
export function createRouteStore({ keyPrefix, invalidError, invalidDateError }) {
  let cache = null;
  let expires = 0;

  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(invalidError);
    const result = {};
    for (const family of families) {
      const record = input[family] || {};
      if (typeof record !== 'object' || Array.isArray(record)) throw new Error(invalidError);
      result[family] = {};
      for (const key of fields) {
        if (record[key] != null && typeof record[key] !== 'string') throw new Error(invalidError);
        const value = (record[key] || '').trim();
        if (value.length > 160 || /[\x00-\x1f]/.test(value)) throw new Error(invalidError);
        if (value) result[family][key] = value;
      }
      if (record.carrier_meta) result[family].carrier_meta = normalizeRouteMeta(record.carrier_meta);
      if (result[family].last_attempt_at && !Number.isFinite(Date.parse(result[family].last_attempt_at))) throw new Error('invalidRouteDate');
      if (result[family].probed_at && !Number.isFinite(Date.parse(result[family].probed_at))) throw new Error(invalidDateError);
    }
    return result;
  }

  async function getAll(db) {
    if (cache && Date.now() < expires) return cache;
    const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE '${keyPrefix}%'`).all();
    const routes = {};
    for (const row of results || []) {
      if (!row.key?.startsWith(keyPrefix)) continue;
      try { routes[row.key.slice(keyPrefix.length)] = normalize(JSON.parse(row.value)); } catch { /* 单节点数据坏掉不影响其余节点 */ }
    }
    cache = routes;
    expires = Date.now() + CACHE_TTL_MS;
    return routes;
  }

  async function save(db, id, routes) {
    const normalized = normalize(routes);
    const result = await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value <> excluded.value')
      .bind(keyPrefix + id, JSON.stringify(normalized)).run();
    cache = null;
    expires = 0;
    return result?.meta?.changes !== 0;
  }

  return { normalize, getAll, save };
}
