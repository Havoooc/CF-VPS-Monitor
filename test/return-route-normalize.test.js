import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeReturnRoute,
  mergeMetricsIntoServer,
  RETURN_ROUTE_ALLOWED_VALUES
} from '../src/utils/metrics.js';
import { handleUpdate } from '../src/handlers/update.js';
import { clearServerDetailCache } from '../src/utils/cache.js';

const VALID = {
  region: '浙江',
  telecom: 'CN2GIA',
  unicom: '9929',
  mobile: 'CMIN2'
};

test('空对象归一化为 null —— 探针缓存缺失时不得清空面板线路', () => {
  assert.equal(normalizeReturnRoute({}), null);
  assert.equal(normalizeReturnRoute('{}'), null);
});

test('非法输入一律归一化为 null', () => {
  assert.equal(normalizeReturnRoute(null), null);
  assert.equal(normalizeReturnRoute(undefined), null);
  assert.equal(normalizeReturnRoute(''), null);
  assert.equal(normalizeReturnRoute('   '), null);
  assert.equal(normalizeReturnRoute('not-json'), null);
  assert.equal(normalizeReturnRoute([]), null);
  assert.equal(normalizeReturnRoute(42), null);
});

test('缺任意一列都视为无结论，避免写出缺列的半成品', () => {
  assert.equal(normalizeReturnRoute({ ...VALID, mobile: undefined }), null);
  assert.equal(normalizeReturnRoute({ ...VALID, telecom: '' }), null);
  assert.equal(
    normalizeReturnRoute({ region: '浙江', telecom: '9929', unicom: '9929' }),
    null
  );
});

test('白名单之外的值被拒绝', () => {
  assert.equal(normalizeReturnRoute({ ...VALID, telecom: '未知' }), null);
  assert.equal(normalizeReturnRoute({ ...VALID, unicom: 'AS9929' }), null);
  assert.equal(normalizeReturnRoute({ ...VALID, mobile: '<script>' }), null);
  for (const value of ['CN2GIA', 'CN2GT', '9929', '10099', '4837', 'CMIN2', 'CMI', '普通国际']) {
    assert.ok(RETURN_ROUTE_ALLOWED_VALUES.has(value), `${value} 应在白名单内`);
    assert.notEqual(normalizeReturnRoute({ ...VALID, telecom: value }), null);
  }
});

test('国内线路语义在白名单内，且可逐列混用', () => {
  // 全程落在境内的节点（如阿里云杭州）用国际词表会得出「普通国际」这种字面错误，
  // 因此单独放行一组国内值。
  for (const value of ['国内电信', '国内联通', '国内移动']) {
    assert.ok(RETURN_ROUTE_ALLOWED_VALUES.has(value), `${value} 应在白名单内`);
  }
  const domestic = {
    region: '浙江',
    telecom: '国内电信',
    unicom: '国内联通',
    mobile: '国内移动'
  };
  assert.deepEqual(normalizeReturnRoute(domestic), domestic);
  assert.deepEqual(normalizeReturnRoute(JSON.stringify(domestic)), domestic);
});

test('国内值不会被误当成国际值', () => {
  assert.equal(normalizeReturnRoute({ ...VALID, telecom: '国内' }), null);
  assert.equal(normalizeReturnRoute({ ...VALID, telecom: '国内电信X' }), null);
  assert.equal(normalizeReturnRoute({ ...VALID, telecom: '国产电信' }), null);
  // 两侧空白会被 trim 掉，属于合法输入
  assert.equal(normalizeReturnRoute({ ...VALID, telecom: ' 国内电信 ' }).telecom, '国内电信');
});

test('合法对象保留业务字段，并透传增强探针的新增字段', () => {
  const result = normalizeReturnRoute({
    ...VALID,
    probed_at: '2026-09-14T06:06:49Z',
    method: 'nexttrace-json-v2',
    target_ips: { telecom: '183.131.147.4' },
    confidence: { telecom: 'high' },
    reason: { telecom: 'CN2 跳 3 个' },
    unknown_field: '应被丢弃'
  });

  assert.deepEqual(result, {
    region: '浙江',
    telecom: 'CN2GIA',
    unicom: '9929',
    mobile: 'CMIN2',
    probed_at: '2026-09-14T06:06:49Z',
    method: 'nexttrace-json-v2',
    target_ips: { telecom: '183.131.147.4' },
    confidence: { telecom: 'high' },
    reason: { telecom: 'CN2 跳 3 个' }
  });
  assert.ok(!('unknown_field' in result));
});

test('JSON 字符串形式同样被接受（兼容 D1 的 TEXT 列）', () => {
  assert.deepEqual(normalizeReturnRoute(JSON.stringify(VALID)), VALID);
});

test('探针发来空对象时，实时负载保留已有线路而不是清空', () => {
  const server = { name: 'VMISS', return_route: VALID };
  mergeMetricsIntoServer(server, { return_route: {} });
  assert.deepEqual(server.return_route, VALID);

  mergeMetricsIntoServer(server, {});
  assert.deepEqual(server.return_route, VALID);
});

test('探针发来合法新值时正常覆盖', () => {
  const server = { name: 'VMISS', return_route: VALID };
  mergeMetricsIntoServer(server, {
    return_route: { region: '浙江', telecom: '普通国际', unicom: '4837', mobile: 'CMI' }
  });
  assert.equal(server.return_route.telecom, '普通国际');
  assert.equal(server.return_route.unicom, '4837');
  assert.equal(server.return_route.mobile, 'CMI');
});

test('回程线路与数据库规范化值相同则不执行 UPDATE', async () => {
  clearServerDetailCache();
  const route = { ...VALID, method: 'nexttrace-json-v2' };
  let routeUpdates = 0;
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return {
            id: 'server-test',
            name: 'test',
            history_partition_id: 1,
            return_route: JSON.stringify(route),
            traffic_alert_percent: null
          };
        },
        async run() {
          if (sql.includes('UPDATE servers SET return_route')) routeUpdates += 1;
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  };
  const env = { API_SECRET: 'test-secret', DB: db, METRICS_BROADCASTER: null };
  const ctx = { waitUntil() {} };
  const request = new Request('https://monitor.example/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'server-test',
      secret: 'test-secret',
      metrics: { timestamp: Date.now(), return_route: { ...VALID, method: 'nexttrace-json-v2' } }
    })
  });

  const response = await handleUpdate(request, env, ctx);
  assert.ok(response.status === 200 || response.status === 204);
  assert.equal(routeUpdates, 0);
});

test('规范化后的回程线路变化仍会更新数据库', async () => {
  clearServerDetailCache();
  let routeUpdates = 0;
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return { results: [] }; },
        async first() {
          return {
            id: 'server-test-change',
            name: 'test',
            history_partition_id: 1,
            return_route: JSON.stringify(VALID),
            traffic_alert_percent: null
          };
        },
        async run() {
          if (sql.includes('UPDATE servers SET return_route')) routeUpdates += 1;
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  };
  const env = { API_SECRET: 'test-secret', DB: db, METRICS_BROADCASTER: null };
  const response = await handleUpdate(new Request('https://monitor.example/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'server-test-change',
      secret: 'test-secret',
      metrics: {
        timestamp: Date.now(),
        return_route: { ...VALID, telecom: '普通国际' }
      }
    })
  }), env, { waitUntil() {} });

  assert.ok(response.status === 200 || response.status === 204);
  assert.equal(routeUpdates, 1);
});
