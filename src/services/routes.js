import { normalizeReturnRoute, RETURN_ROUTE_ALLOWED_VALUES } from '../utils/metrics.js';
import { getForwardRoutes, normalizeForwardRoutes, saveForwardRoutes } from '../utils/forwardRoutes.js';
import { getMeasuredReturnRoutes, normalizeMeasuredReturnRoutes, saveMeasuredReturnRoutes } from '../utils/measuredReturnRoutes.js';
import { mergeRouteRecord } from '../utils/routeRecord.js';
import { patchServerDetailCache } from '../utils/cache.js';
import { loadSiteSettings } from '../utils/settings.js';
import { sendNotification } from './notification.js';

const carriers = [['telecom', '电信'], ['unicom', '联通'], ['mobile', '移动']];
function changesBetween(previous, next, prefix) {
  return carriers.filter(([key]) => previous?.[key] && next?.[key] && previous[key].replace(/^CN2(GIA|GT)$/, 'CN2') !== next[key].replace(/^CN2(GIA|GT)$/, 'CN2'))
    .map(([key, label]) => `${prefix} ${label}：${previous[key]} ➔ ${next[key]}`);
}

// Route failures must never prevent CPU/memory/history persistence.
export async function persistRouteReport(env, id, metrics, detail, ctx) {
  const changes = [];
  const operations = [
    async () => {
      if (!metrics.return_route || typeof metrics.return_route !== 'object') return;
      const incoming = normalizeMeasuredReturnRoutes({ ipv4: metrics.return_route }).ipv4;
      for (const [key] of carriers) if (incoming[key] && !RETURN_ROUTE_ALLOWED_VALUES.has(incoming[key])) delete incoming[key];
      if (!carriers.some(([key]) => incoming[key])) return;
      const previous = normalizeReturnRoute(detail?.return_route);
      const next = mergeRouteRecord(previous || {}, incoming);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      await env.DB.prepare("UPDATE servers SET return_route = ? WHERE id = ? AND COALESCE(return_route, '') <> ?")
        .bind(JSON.stringify(next), id, JSON.stringify(next)).run();
      if (detail) detail.return_route = JSON.stringify(next);
      patchServerDetailCache(id, { return_route: JSON.stringify(next) });
      changes.push(...changesBetween(previous, next, 'IPv4 回程'));
    },
    async () => {
      if (!metrics.return_route_ipv6 || typeof metrics.return_route_ipv6 !== 'object') return;
      const incoming = normalizeMeasuredReturnRoutes({ ipv6: metrics.return_route_ipv6 }).ipv6;
      for (const [key] of carriers) if (incoming[key] && !RETURN_ROUTE_ALLOWED_VALUES.has(incoming[key])) delete incoming[key];
      if (!carriers.some(([key]) => incoming[key])) return;
      const previous = (await getMeasuredReturnRoutes(env.DB))[id] || { ipv4: {}, ipv6: {} };
      const next = { ...previous, ipv6: mergeRouteRecord(previous.ipv6, incoming) };
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      await saveMeasuredReturnRoutes(env.DB, id, next);
      changes.push(...changesBetween(previous.ipv6, next.ipv6, 'IPv6 回程'));
    },
    async () => {
      if (!metrics.forward_routes || typeof metrics.forward_routes !== 'object') return;
      const incoming = normalizeForwardRoutes(metrics.forward_routes);
      if (!['ipv4', 'ipv6'].some(family => carriers.some(([key]) => incoming[family][key]))) return;
      const previous = (await getForwardRoutes(env.DB))[id] || { ipv4: {}, ipv6: {} };
      const next = { ipv4: mergeRouteRecord(previous.ipv4, incoming.ipv4), ipv6: mergeRouteRecord(previous.ipv6, incoming.ipv6) };
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      await saveForwardRoutes(env.DB, id, next);
      for (const family of ['ipv4', 'ipv6']) changes.push(...changesBetween(previous[family], next[family], `${family.toUpperCase()} 去程`));
    }
  ];
  for (const operation of operations) {
    try { await operation(); }
    catch (error) { console.warn('[Routes] Route report skipped:', error?.message || error); }
  }
  if (changes.length && typeof ctx?.waitUntil === 'function') {
    ctx.waitUntil((async () => {
      try {
        const settings = await loadSiteSettings(env.DB);
        await sendNotification(settings, changes.join('\n'), {
          event: '线路异动告警', emoji: '🔀', client: detail?.name || id,
          clients: [detail?.name || id], count: changes.length,
          message: `服务器【${detail?.name || id}】线路发生变更：\n${changes.join('\n')}`
        });
      } catch (error) { console.warn('[Routes] Notification failed:', error?.message || error); }
    })());
  }
}
