import { getForwardRoutes, saveForwardRoutes } from './forwardRoutes.js';
import { getMeasuredReturnRoutes, saveMeasuredReturnRoutes } from './measuredReturnRoutes.js';

const STATE_KEY = 'daily_route_scan_state';
const API = 'https://www.tcptest.cn/api/v2';
const NODES = {
  telecom: 'e88712a7-5da2-45fe-a22b-97dc5c62600b',
  unicom: '5616de3a-0f66-4d3c-9508-47dc081a650c',
  mobile: '0d400955-d04f-4940-a388-dfa2ffcd4e08'
};
const SERVERS = [
  { id: '218776b9-adda-404f-a34a-7673c43a8c3a', v4: '45.142.125.101', v6: '2a12:a301:2001::10dd' },
  { id: '6d63ca9f-9064-4774-a569-61b718e7443d', v4: '207.57.142.44', v6: '2602:f656:5::2a3' },
  { id: 'e4ab883d-ef3a-46ff-8468-f5800e93f5b1', v4: '24.249.30.16', v6: '2001:57a:f200:b920::18f' },
  { id: '4a3d3943-205a-485b-b75e-22633183e66b', v4: '121.196.232.42' }
];
const CARRIERS = ['telecom', 'unicom', 'mobile'];
const ROUTE_AS = {
  telecom: { '4809': 'CN2', '4134': '163', '136190': 'CT' },
  unicom: { '9929': '9929', '10099': '10099', '4837': '4837' },
  mobile: { '58807': 'CMIN2', '58453': 'CMI', '9808': 'CMI', '56041': 'CMI' }
};

async function readState(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(STATE_KEY).first();
  try { return row?.value ? JSON.parse(row.value) : null; } catch { return null; }
}
async function writeState(db, state) {
  await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(STATE_KEY, JSON.stringify(state)).run();
}
async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0', ...(init?.headers || {}) } });
  if (!response.ok) throw new Error(`routeProbeHttp${response.status}`);
  return response.json();
}

export async function startDailyRouteScan(db, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const current = await readState(db);
  if (current?.day === day && (current.finished_at || current.tasks?.length)) return { skipped: true };
  const tasks = [];
  for (const server of SERVERS) {
    for (const [family, target] of [['ipv4', server.v4], ...(server.v6 ? [['ipv6', server.v6]] : [])]) {
      for (const carrier of CARRIERS) tasks.push({ server_id: server.id, family, carrier, target, node_uuid: NODES[carrier] });
    }
  }
  const state = { day, started_at: now.toISOString(), expected: tasks.length, tasks: [], submit_errors: [] };
  await writeState(db, state);
  for (let offset = 0; offset < tasks.length; offset += 4) {
    const batch = tasks.slice(offset, offset + 4);
    const created = await Promise.allSettled(batch.map(async task => {
      const response = await fetchJson(`${API}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'traceroute', target: task.target, ip_family: task.family, node_filter: { node_uuids: [task.node_uuid], limit: 1 }, options: { max_hops: 30, rounds: 1 } })
      });
      return { ...task, id: response.id, done: false };
    }));
    for (let index = 0; index < created.length; index++) {
      const item = created[index];
      if (item.status === 'fulfilled' && item.value.id) state.tasks.push(item.value);
      else state.submit_errors.push({ family: batch[index].family, carrier: batch[index].carrier, error: item.status === 'rejected' ? String(item.reason?.message || 'request_failed').slice(0, 120) : 'missing_task_id' });
    }
    await writeState(db, state);
  }
  return { submitted: state.tasks.length, expected: tasks.length, failed: state.submit_errors.length };
}

function summarizeRoute(result, carrier) {
  const hops = result?.data?.hops;
  if (!Array.isArray(hops)) return '';
  const labels = [];
  for (const hop of hops) {
    const asn = String(hop.asn || '').replace(/^AS/i, '');
    const label = ROUTE_AS[carrier]?.[asn] || (asn ? `AS${asn}` : '');
    if (label && labels.at(-1) !== label) labels.push(label);
  }
  return labels.join(' → ').slice(0, 160);
}

export async function pollDailyRouteScan(db, now = new Date()) {
  const state = await readState(db);
  if (!state?.tasks?.length || state.finished_at) return { pending: 0 };
  if (now.getTime() - Date.parse(state.started_at) > 90 * 60 * 1000) {
    state.finished_at = now.toISOString();
    state.expired = true;
    await writeState(db, state);
    return { expired: true };
  }
  const pending = state.tasks.filter(task => !task.done);
  const completed = await Promise.allSettled(pending.map(async task => {
    const response = await fetchJson(`${API}/tasks/${encodeURIComponent(task.id)}/results?after=0&limit=100`);
    const result = response.results?.find(item => item.final) || response.results?.at(-1);
    if (!result?.final) return null;
    task.done = true;
    const route = summarizeRoute(result, task.carrier);
    return route ? { task, route } : null;
  }));

  for (const item of completed) if (item.status === 'fulfilled' && item.value) {
    const { task, route } = item.value;
    const existingForward = await getForwardRoutes(db);
    const forward = existingForward[task.server_id] || { ipv4: {}, ipv6: {} };
    forward[task.family] ||= {};
    forward[task.family][task.carrier] = route;
    forward[task.family].region = '浙江温州第三方探测点';
    forward[task.family].source = 'TCPTest 每日自动路由探测';
    forward[task.family].probed_at = now.toISOString();
    await saveForwardRoutes(db, task.server_id, forward);
  }
  if (state.tasks.every(task => task.done)) {
    state.finished_at = now.toISOString();
    await refreshCardReturnRoutes(db);
  }
  await writeState(db, state);
  return { pending: state.tasks.filter(task => !task.done).length };
}

export async function refreshCardReturnRoutes(db) {
  const [forwardRoutes, returnSnapshots] = await Promise.all([getForwardRoutes(db), getMeasuredReturnRoutes(db)]);
  // The live IPv4 value is reported by each VPS probe. Keep the last measured IPv6 snapshot.
  const servers = await db.prepare('SELECT id, return_route FROM servers WHERE COALESCE(return_route, "") <> ""').all();
  for (const server of servers.results || []) {
    let live;
    try { live = JSON.parse(server.return_route); } catch { continue; }
    if (!live || !CARRIERS.every(key => typeof live[key] === 'string')) continue;
    const record = returnSnapshots[server.id] || { ipv4: {}, ipv6: {} };
    record.ipv4 = { ...live, source: '服务器定时回程探针' };
    await saveMeasuredReturnRoutes(db, server.id, record);
  }
  return { forwardServers: Object.keys(forwardRoutes).length };
}
