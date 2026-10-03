const carriers = ['telecom', 'unicom', 'mobile'];
const dates = ['probed_at', 'last_attempt_at'];
export function normalizeRouteMeta(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  for (const carrier of carriers) {
    const source = input[carrier];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const meta = {};
    for (const key of [...dates, 'status', 'route_type', 'quality', 'confidence', 'reason']) {
      const value = source[key];
      if (value == null) continue;
      if (typeof value !== 'string' || value.length > 500 || /[\x00-\x1f]/.test(value)) throw new Error('invalidRouteMetadata');
      if (dates.includes(key) && !Number.isFinite(Date.parse(value))) throw new Error('invalidRouteDate');
      meta[key] = value;
    }
    if (typeof source.destination_reached === 'boolean') meta.destination_reached = source.destination_reached;
    result[carrier] = meta;
  }
  return result;
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
  return next;
}
