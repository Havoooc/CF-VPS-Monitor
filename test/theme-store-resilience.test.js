import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTheme } from '../src/handlers/theme.js';
import { THEME_STORE_CACHE_TTL_SECONDS } from '../src/utils/config.js';

test('theme catalog retains cached data after GitHub failure and sets a timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 100000000;
  let fail = false;
  Date.now = () => now;
  globalThis.fetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return fail ? new Response('', { status: 503 }) : Response.json({ schema: 1, themes: [{ id: 'luminaplus' }] });
  };
  try {
    const first = await handleTheme();
    assert.equal(first.cached, false);
    now += (THEME_STORE_CACHE_TTL_SECONDS + 1) * 1000;
    fail = true;
    const fallback = await handleTheme();
    assert.equal(fallback.ok, true);
    assert.equal(fallback.stale, true);
    assert.deepEqual(fallback.themeStore, first.themeStore);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
