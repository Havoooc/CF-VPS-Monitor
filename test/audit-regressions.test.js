import assert from 'node:assert/strict';
import test from 'node:test';
import { saveMetricsHistory, getLatestMetricsForAllServers } from '../src/database/schema.js';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { handleUpdate } from '../src/handlers/update.js';
import { clearAllCaches } from '../src/utils/cache.js';

function broadcaster(db, sockets = []) {
  globalThis.WebSocketRequestResponsePair ??= class {};
  return new MetricsBroadcaster({
    getWebSockets: () => sockets, setWebSocketAutoResponse() {},
    storage: { get: async () => null, put: async () => {} }
  }, { DB: db });
}

test('history write failures propagate, including a failed schema-repair retry', async () => {
  const failure = new Error('D1 unavailable');
  const db = { prepare: () => ({ bind() { return this; }, run: async () => { throw failure; } }) };
  await assert.rejects(saveMetricsHistory(db, 'node', 1, {}, '', Date.now()), error => error === failure);

  let attempts = 0;
  const repairDb = { prepare: sql => ({
    bind() { return this; },
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => {
      if (!sql.includes('INSERT INTO metrics_history')) return { success: true };
      if (++attempts === 1) throw new Error('table metrics_history has no column named cpu');
      throw failure;
    }
  }) };
  await assert.rejects(saveMetricsHistory(repairDb, 'node', 1, {}, '', Date.now()), error => error === failure);
  assert.equal(attempts, 2);
});

test('POST does not acknowledge a failed D1 history write or schedule broadcasts', async () => {
  clearAllCaches();
  const db = { prepare: sql => ({
    bind() { return this; },
    first: async () => ({ id: 'node', history_partition_id: 1 }),
    run: async () => { throw new Error('D1 unavailable'); }
  }) };
  let backgroundTasks = 0;
  const response = await handleUpdate(new Request('https://test.invalid/update', {
    method: 'POST', body: JSON.stringify({ id: 'node', secret: 'test', metrics: { cpu: 10 } })
  }), { DB: db, API_SECRET: 'test' }, { waitUntil() { backgroundTasks++; } });
  assert.equal(response.status, 500);
  assert.equal(backgroundTasks, 0);
  clearAllCaches();
});

test('WSS retains failed aggregates and retries without advancing the persisted timestamp', async () => {
  let fail = true;
  const saved = [];
  const db = { prepare: () => ({ bind(...values) {
    return { run: async () => {
      if (fail) throw new Error('D1 unavailable');
      saved.push(values);
      return { success: true };
    } };
  } }) };
  const instance = broadcaster(db);
  let attachment = {};
  const ws = { deserializeAttachment: () => attachment, serializeAttachment: value => { attachment = value; } };
  const payload = { serverId: 'node', historyPartitionId: 1, timestamp: Date.now(), reportIntervalMs: 60_000,
    metrics: { cpu: 10, net_in_speed: 100 } };
  await assert.rejects(instance._persistAgentHistoryIfDue(ws, attachment, payload), /D1 unavailable/);
  assert.equal(attachment.lastD1WriteTs, undefined);
  assert.equal(instance.agentHistoryWrites.get('node').flushing, false);
  fail = false;
  const result = await instance._persistAgentHistoryIfDue(ws, attachment, {
    ...payload, metrics: { cpu: 20, net_in_speed: 1 }
  });
  assert.equal(result.persisted, true);
  assert.equal(saved[0][4], 15);
  assert.equal(saved[0][6], 100);
  assert.ok(attachment.lastD1WriteTs > 0);
});

test('broadcast masks a shared sample once for 100 subscribers and preserves per-socket access', () => {
  let copies = 0;
  const sample = { ts: 1, data: { cpu: 10, ip_v4: '192.0.2.1' } };
  Object.defineProperty(sample, 'probeCopy', { enumerable: true, get() { copies++; return true; } });
  const messages = [];
  const sockets = Array.from({ length: 100 }, () => ({
    deserializeAttachment: () => ({ isAdmin: false, scope: 'all', serverIds: ['visible', 'hidden'], allowedServerIds: ['visible'] }),
    send: message => messages.push(JSON.parse(message))
  }));
  broadcaster({}, sockets)._broadcastBatch([
    { serverId: 'visible', samples: [sample] },
    { serverId: 'hidden', samples: [{ ts: 1, data: { cpu: 99 } }] }
  ], 123);
  assert.equal(messages.length, 100);
  assert.equal(copies, 1);
  for (const message of messages) {
    assert.deepEqual(message.updates.map(update => update.serverId), ['visible']);
    assert.equal(message.updates[0].samples[0].data.ip_v4, '1');
  }
  assert.equal(sample.data.ip_v4, '192.0.2.1');
});

test('latest metrics bounds D1 concurrency and retains all 200 nodes', async () => {
  clearAllCaches();
  let active = 0, peak = 0, reads = 0;
  const servers = Array.from({ length: 200 }, (_, index) => ({ id: `node-${index}`, history_partition_id: index + 1 }));
  const db = { prepare: sql => ({
    bind() { return this; },
    all: async () => ({ results: servers }),
    first: async () => {
      reads++;
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { cpu: 10 };
    }
  }) };
  const result = await getLatestMetricsForAllServers(db);
  assert.equal(result.size, 200);
  assert.equal(reads, 200);
  assert.equal(peak, 20);
  assert.equal((await getLatestMetricsForAllServers(db)).size, 200);
  assert.equal(reads, 200);
  clearAllCaches();
});
