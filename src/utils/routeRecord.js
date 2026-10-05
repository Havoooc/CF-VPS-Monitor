const carriers = ['telecom', 'unicom', 'mobile'];
const dates = ['probed_at', 'last_attempt_at'];
const metaFields = ['status', 'route_type', 'quality', 'confidence', 'reason', 'region', 'source'];

/**
 * 归一化 carrier_meta。
 *
 * 单个字段不合规（类型错、超长、含控制字符、日期不可解析）只丢这一个字段，不再抛错。
 * 调用方把异常吞在「整条 IPv4 / IPv6 / 去程路由写入」之外，一个坏字段会让整条路由
 * 记录被跳过，代价远大于丢弃它。
 *
 * route_path 已从卡片下线，因此不在白名单内；历史数据里的残留由 stripRoutePaths 清理。
 */
export function normalizeRouteMeta(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  for (const carrier of carriers) {
    const source = input[carrier];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const meta = {};
    for (const key of [...dates, ...metaFields]) {
      const value = source[key];
      if (value == null) continue;
      if (typeof value !== 'string' || value.length > 500 || /[\x00-\x1f]/.test(value)) continue;
      if (dates.includes(key) && !Number.isFinite(Date.parse(value))) continue;
      meta[key] = value;
    }
    if (typeof source.destination_reached === 'boolean') meta.destination_reached = source.destination_reached;
    result[carrier] = meta;
  }
  return result;
}

/**
 * 剥掉 carrier_meta 里的 route_path（逐跳 ASN 链）。
 *
 * 这份数据既不在卡片上展示，也不再参与任何判定，却是每次上报里最大的一块
 * （每运营商最多 1200 字符 × 3 × 2 个地址族），存进 D1 再随 /api/servers 全量下发，
 * 单节点就有数 KB 纯浪费。新数据从源头就不带它，这里负责清理历史残留。
 *
 * 接受 JSON 字符串或对象，返回同样形态；无改动时原样返回，方便调用方直接替换。
 */
export function stripRoutePaths(value) {
  if (value == null) return value;
  const fromString = typeof value === 'string';
  let record = value;
  if (fromString) {
    if (!value.trim()) return value;
    try { record = JSON.parse(value); } catch { return value; }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return value;
  const meta = record.carrier_meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return value;
  let changed = false;
  const cleaned = { ...meta };
  for (const carrier of carriers) {
    const entry = cleaned[carrier];
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'route_path' in entry) {
      const { route_path: _dropped, ...rest } = entry;
      cleaned[carrier] = rest;
      changed = true;
    }
  }
  if (!changed) return value;
  const next = { ...record, carrier_meta: cleaned };
  return fromString ? JSON.stringify(next) : next;
}

export function mergeRouteRecord(previous = {}, incoming = {}) {
  const next = { ...previous, ...incoming, carrier_meta: { ...previous.carrier_meta } };
  for (const carrier of carriers) {
    const oldMeta = previous.carrier_meta?.[carrier];
    const newMeta = incoming.carrier_meta?.[carrier];
    const oldTime = Date.parse(oldMeta?.probed_at || previous.probed_at || '');
    const newTime = Date.parse(newMeta?.probed_at || incoming.probed_at || '');
    if (Number.isFinite(oldTime) && (!Number.isFinite(newTime) || newTime < oldTime)) {
      if (previous[carrier]) next[carrier] = previous[carrier];
      if (oldMeta) next.carrier_meta[carrier] = oldMeta;
      // Still record a newer unsuccessful attempt without refreshing the accepted clock.
      if (newMeta && Date.parse(newMeta.last_attempt_at || '') > Date.parse(oldMeta?.last_attempt_at || oldMeta?.probed_at || previous.probed_at || '')) {
        next.carrier_meta[carrier] = { ...oldMeta, last_attempt_at: newMeta.last_attempt_at, status: newMeta.status, reason: newMeta.reason };
      }
    } else if (newMeta) {
      next.carrier_meta[carrier] = newMeta;
    }
  }
  if (!Object.keys(next.carrier_meta).length) delete next.carrier_meta;
  // previous 可能来自库里尚未清理的历史记录，合并结果统一剥一次 route_path。
  return stripRoutePaths(next);
}
