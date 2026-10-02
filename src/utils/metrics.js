import {
  NUMERIC_METRIC_FIELDS,
  PROBE_METRIC_FIELDS
} from './historyFields.js';

export const DISK_IO_METRIC_FIELDS = [
  'read_bps',
  'write_bps',
  'read_iops',
  'write_iops',
  'await_ms',
  'util'
];

export const DISK_IO_FIELD_TO_COLUMN = {
  read_bps: 'disk_read_bps',
  write_bps: 'disk_write_bps',
  read_iops: 'disk_read_iops',
  write_iops: 'disk_write_iops',
  await_ms: 'disk_await_ms',
  util: 'disk_util'
};

function toFiniteMetricNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasOwnMetric(source, field) {
  return Object.prototype.hasOwnProperty.call(source, field);
}

function isPlainMetricObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

// 回程线路（return_route）允许的取值，与 VPS 侧
// /usr/local/bin/cfsm-route-update.sh 的白名单保持一致。
//
// 前 10 个是国际回程语义，只对境外节点成立。
// 「国内电信 / 国内联通 / 国内移动」用于探测路径全程位于中国境内的节点
// （如阿里云杭州）：这类机器不存在国际回程，用国际词表会得出「普通国际」
// 这种字面错误的结论，因此单独给一组国内语义。
export const RETURN_ROUTE_ALLOWED_VALUES = new Set([
  'CN2GIA',
  'CN2GT',
  'CN2',
  '9929',
  '10099',
  '4837',
  'CMIN2',
  'CMI',
  'CMNET',
  '普通国际',
  '国内电信',
  '国内联通',
  '国内移动'
]);

export const RETURN_ROUTE_CARRIER_FIELDS = ['telecom', 'unicom', 'mobile'];

// 归一化并校验回程线路对象。
//
// 返回 null 表示「本次无有效结论」——调用方必须保留旧值，绝不可覆盖。
// 这样即便探针因本地缓存文件缺失而发送 `{}`（cf-probe.sh 的默认回落值），
// 也不会把面板上已有的线路清空。
//
// 三个运营商必须全部是白名单内的值才算有效；只要有一列缺失或非法，
// 就整体视为无结论，避免写出缺列的半成品把某一列显示抹掉。
export function normalizeReturnRoute(value) {
  let source = value;

  if (typeof source === 'string') {
    if (!source.trim()) return null;
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }

  if (!isPlainMetricObject(source)) return null;

  const result = {};
  for (const field of RETURN_ROUTE_CARRIER_FIELDS) {
    const raw = source[field];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!RETURN_ROUTE_ALLOWED_VALUES.has(trimmed)) return null;
    result[field] = trimmed;
  }

  const region = typeof source.region === 'string' ? source.region.trim() : '';
  if (region) result.region = region;
  if (typeof source.probed_at === 'string' && source.probed_at.trim()) {
    result.probed_at = source.probed_at.trim();
  }
  if (typeof source.method === 'string' && source.method.trim()) {
    result.method = source.method.trim();
  }
  if (isPlainMetricObject(source.target_ips)) {
    result.target_ips = source.target_ips;
  }
  for (const field of ['confidence', 'reason']) {
    if (isPlainMetricObject(source[field])) {
      result[field] = source[field];
    }
  }

  return result;
}

export function hasDiskMetricsPayload(metrics) {
  const source = isPlainMetricObject(metrics) ? metrics : {};

  if (hasOwnMetric(source, 'disk')) {
    const disk = isPlainMetricObject(source.disk) ? source.disk : {};
    return DISK_IO_METRIC_FIELDS.some(field => {
      const value = hasOwnMetric(disk, field)
        ? toFiniteMetricNumber(disk[field], null)
        : null;
      return value !== null && value !== 0;
    });
  }

  return DISK_IO_METRIC_FIELDS.some(field => {
    const column = DISK_IO_FIELD_TO_COLUMN[field];
    const value = hasOwnMetric(source, column)
      ? toFiniteMetricNumber(source[column], null)
      : null;
    return value !== null && value !== 0;
  });
}

export function normalizeDiskMetrics(metrics) {
  const source = isPlainMetricObject(metrics) ? metrics : {};
  const hasDiskObject = hasOwnMetric(source, 'disk');
  const disk = isPlainMetricObject(source.disk)
    ? source.disk
    : {};

  return Object.fromEntries(DISK_IO_METRIC_FIELDS.map(field => {
    const column = DISK_IO_FIELD_TO_COLUMN[field];
    const value = hasDiskObject
      ? disk[field]
      : source[column];
    return [field, toFiniteMetricNumber(value)];
  }));
}

function createEmptyDiskMetricColumns(value = null) {
  return Object.fromEntries(DISK_IO_METRIC_FIELDS.map(field => [
    DISK_IO_FIELD_TO_COLUMN[field],
    value
  ]));
}

export function flattenDiskMetrics(metrics) {
  if (!hasDiskMetricsPayload(metrics)) {
    return createEmptyDiskMetricColumns(null);
  }

  const disk = normalizeDiskMetrics(metrics);
  return Object.fromEntries(DISK_IO_METRIC_FIELDS.map(field => [
    DISK_IO_FIELD_TO_COLUMN[field],
    disk[field]
  ]));
}

export function attachDiskMetricsObject(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;
  const result = { ...metrics };
  delete result.disk;
  if (!hasDiskMetricsPayload(metrics)) {
    return result;
  }
  return {
    ...result,
    disk: normalizeDiskMetrics(metrics)
  };
}

export function isDisabledProbeMetric(value) {
  return value === false || value === 'false';
}

// 将探针上报的指标字段统一转换为数字类型，与 /api/servers 的 servers[] 字段类型保持一致。
// 数据库 D1 对 REAL/INTEGER 列返回 JS number，而探针 POST 的原始字段可能是字符串，
// latestReportUpdates 和 WebSocket 推送直接透传探针数据，需要在此统一类型。
export function coerceNumericMetricFields(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const result = { ...payload };

  for (const field of NUMERIC_METRIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) continue;
    const value = result[field];
    if (value === null || value === undefined) continue;
    const num = Number(value);
    result[field] = Number.isFinite(num) ? num : 0;
  }

  for (const field of PROBE_METRIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) continue;
    const value = result[field];
    if (value === false || value === 'false') {
      result[field] = false;
    } else if (value === null || value === undefined) {
      continue;
    } else {
      const num = Number(value);
      result[field] = Number.isFinite(num) ? num : null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(result, 'disk')) {
    if (!hasDiskMetricsPayload(result)) {
      delete result.disk;
      return result;
    }
    result.disk = normalizeDiskMetrics(result);
  }

  return result;
}

function normalizeProbeMetric(value) {
  return isDisabledProbeMetric(value) ? false : value;
}

export function normalizeProbeMetricRow(metrics) {
  if (!metrics) return metrics;

  const normalized = { ...metrics };
  for (const field of PROBE_METRIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = normalizeProbeMetric(normalized[field]);
    }
  }
  return normalized;
}

export function mergeMetricsIntoServer(server, metrics) {
  if (!metrics) return;

  server.cpu = metrics.cpu || 0;
  server.load_avg = metrics.load ?? metrics.load_avg ?? '0 0 0';
  server.net_in_speed = metrics.net_in_speed || 0;
  server.net_out_speed = metrics.net_out_speed || 0;
  server.net_rx = metrics.net_rx || 0;
  server.net_tx = metrics.net_tx || 0;
  server.net_rx_monthly = metrics.net_rx_monthly || 0;
  server.net_tx_monthly = metrics.net_tx_monthly || 0;
  server.processes = metrics.processes || 0;
  server.tcp_conn = metrics.tcp_conn || 0;
  server.udp_conn = metrics.udp_conn || 0;
  server.ping_ct = normalizeProbeMetric(metrics.ping_ct);
  server.ping_cu = normalizeProbeMetric(metrics.ping_cu);
  server.ping_cm = normalizeProbeMetric(metrics.ping_cm);
  server.ping_bd = normalizeProbeMetric(metrics.ping_bd);
  server.loss_ct = normalizeProbeMetric(metrics.loss_ct);
  server.loss_cu = normalizeProbeMetric(metrics.loss_cu);
  server.loss_cm = normalizeProbeMetric(metrics.loss_cm);
  server.loss_bd = normalizeProbeMetric(metrics.loss_bd);
  server.ping_node_1 = normalizeProbeMetric(metrics.ping_node_1);
  server.ping_node_2 = normalizeProbeMetric(metrics.ping_node_2);
  server.ping_node_3 = normalizeProbeMetric(metrics.ping_node_3);
  server.ping_node_4 = normalizeProbeMetric(metrics.ping_node_4);
  server.loss_node_1 = normalizeProbeMetric(metrics.loss_node_1);
  server.loss_node_2 = normalizeProbeMetric(metrics.loss_node_2);
  server.loss_node_3 = normalizeProbeMetric(metrics.loss_node_3);
  server.loss_node_4 = normalizeProbeMetric(metrics.loss_node_4);
  server.ram_total = metrics.ram_total || 0;
  server.ram_used = metrics.ram_used || 0;
  server.swap_total = metrics.swap_total || 0;
  server.swap_used = metrics.swap_used || 0;
  server.disk_total = metrics.disk_total || 0;
  server.disk_used = metrics.disk_used || 0;
  if (hasDiskMetricsPayload(metrics)) {
    server.disk = normalizeDiskMetrics(metrics);
  } else {
    delete server.disk;
  }
  server.cpu_cores = metrics.cpu_cores || 0;
  server.cpu_info = metrics.cpu_info || '';
  server.gpu_info = metrics.gpu_info || '';
  server.arch = metrics.arch || '';
  server.os = metrics.os || '';
  server.kernel_version = metrics.kernel_version || '';
  server.agent_version = metrics.agent_version || '';
  // Optional non-numeric metadata reported by enhanced probes.
  // Keep it out of historical numeric aggregation, but expose it in the live server payload.
  // 非法值（含空对象 `{}`）归一化为 null，此时保留服务器上已有的值，不做覆盖。
  const returnRoute = normalizeReturnRoute(metrics.return_route ?? server.return_route);
  server.return_route = returnRoute ?? server.return_route ?? null;
  server.region = server.region || metrics.region || '';
  server.ip_v4 = metrics.ip_v4 || '0';
  server.ip_v6 = metrics.ip_v6 || '0';
  server.boot_time = metrics.boot_time || '';
  server.last_updated = metrics.timestamp || 0;
}
