import { getMetricsHistory } from '../database/schema.js';
import { loadSiteSettings, normalizeLongHistoryPoints, debug } from '../utils/settings.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache, getCacheDuration } from '../utils/cache.js';
import { createBadRequestResponse, createNotFoundResponse, createUnauthorizedResponse, createSuccessResponse } from '../utils/errors.js';
import { omitNullLossProbeFields } from './dashboard.js';

export async function fetchHistoryData(env, request, id, hours, columns, sys = null) {
  if (!id) return createBadRequestResponse('Missing ID');

  const ALLOWED_HOURS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168];
  if (!ALLOWED_HOURS.includes(hours)) {
    return createBadRequestResponse('Invalid hours parameter');
  }
  
  if (!sys) {
    sys = await loadSiteSettings(env.DB);
  }
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  if (hours > 24 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse();
  
  // 最多查询7天数据
  const clampedHours = Math.min(hours, 168);
  const cacheDuration = getCacheDuration(clampedHours);
  const longHistoryPoints = clampedHours > 1
    ? Number(normalizeLongHistoryPoints(sys.long_history_points))
    : null;

  const cached = getMetricsHistoryCache(id, clampedHours, columns, longHistoryPoints);
  if (cached && Date.now() - cached.timestamp < cacheDuration) {
    const cachedData = Array.isArray(cached.data)
      ? cached.data.map(omitNullLossProbeFields)
      : cached.data;
    return createSuccessResponse(cachedData, { 'X-Cache': 'HIT' });
  }
  
  let data;
  try {
    data = await getMetricsHistory(
      env.DB,
      id,
      clampedHours,
      columns,
      server,
      longHistoryPoints
    );
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (/invalid history partition id/i.test(message)) {
      debug('[History] 服务器未分配历史分区，无法按主键范围查询:', message);
      return new Response(JSON.stringify({
        message: 'historyPartitionNotAssigned'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (/no such column/i.test(message)) {
      debug('[History] 数据库字段缺失，可能尚未升级数据库:', message);
      return new Response(JSON.stringify({
        message: 'databaseUpgradeRequired'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw e;
  }
  
  const sanitizedData = Array.isArray(data)
    ? data.map(omitNullLossProbeFields)
    : data;
  setMetricsHistoryCache(id, clampedHours, columns, sanitizedData, longHistoryPoints);
  
  return createSuccessResponse(sanitizedData, { 'X-Cache': 'MISS' });
}

