import test from 'node:test';
import assert from 'node:assert/strict';
import { getCachedRemoteVersion, getRemoteVersion } from '../src/utils/version.js';

test('release discovery shares in-flight work while cached version is immediately available', async () => {
  const originalFetch = globalThis.fetch;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    await gate;
    return Response.json(String(url).includes('/releases/') ? { tag_name: 'v1.0.0' } : { workers: '2.8.6' });
  };
  try {
    assert.equal(getCachedRemoteVersion(), null);
    const first = getRemoteVersion();
    const second = getRemoteVersion();
    assert.equal(getCachedRemoteVersion(), null);
    assert.equal(requests, 2);
    finish();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(getCachedRemoteVersion().workers, '2.8.6');
  } finally {
    finish();
    globalThis.fetch = originalFetch;
  }
});
