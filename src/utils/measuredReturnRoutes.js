const fields = ['telecom', 'unicom', 'mobile', 'region', 'source', 'probed_at'];
let cache = null;
let expires = 0;

export function normalizeMeasuredReturnRoutes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalidForwardRoutes');
  const result = {};
  for (const family of ['ipv4', 'ipv6']) {
    const record = input[family] || {};
    if (typeof record !== 'object' || Array.isArray(record)) throw new Error('invalidForwardRoutes');
    result[family] = {};
    for (const key of fields) {
      if (record[key] != null && typeof record[key] !== 'string') throw new Error('invalidForwardRoutes');
      const value = (record[key] || '').trim();
      if (value.length > 160 || /[\x00-\x1f]/.test(value)) throw new Error('invalidForwardRoutes');
      if (value) result[family][key] = value;
    }
    if (result[family].probed_at && !Number.isFinite(Date.parse(result[family].probed_at))) throw new Error('invalidForwardRouteDate');
  }
  return result;
}
export async function getMeasuredReturnRoutes(db) {
  if (cache && Date.now() < expires) return cache;
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'return_snapshot:%'").all();
  const routes = {};
  for (const row of results || []) {
    if (!row.key?.startsWith('return_snapshot:')) continue;
    try { routes[row.key.slice(16)] = normalizeMeasuredReturnRoutes(JSON.parse(row.value)); } catch {}
  }
  cache = routes;
  expires = Date.now() + 30000;
  return routes;
}
export async function saveMeasuredReturnRoutes(db, id, routes) {
  const normalized = normalizeMeasuredReturnRoutes(routes);
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind('return_snapshot:' + id, JSON.stringify(normalized)).run();
  cache = null;
  expires = 0;
}
