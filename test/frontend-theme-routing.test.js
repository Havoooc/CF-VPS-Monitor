import test from 'node:test';
import assert from 'node:assert/strict';
import { serveFrontend } from '../src/handlers/frontend.js';

const settings = { theme_url: 'builtin:luminaplus' };
function assets() {
  const requests = [];
  return { requests, env: { ASSETS: { fetch: async request => {
    requests.push(new URL(request.url).pathname);
    return new Response('asset', { headers: { 'Content-Type': 'application/javascript' } });
  } } } };
}

test('builtin asset alias resolves to bundled theme', async () => {
  const { requests, env } = assets();
  const response = await serveFrontend(new Request('https://example.com/assets/app.js'), env, settings);
  assert.equal(response.status, 200);
  assert.deepEqual(requests, ['/themes/luminaplus/assets/app.js']);
});

test('preview assets require authorization before serving builtin assets', async () => {
  const { requests, env } = assets();
  const request = new Request('https://example.com/assets/app.js?theme_url=https://github.com/Havoooc/CF-VPS-Monitor/tree/theme-dist');
  const response = await serveFrontend(request, env, settings);
  assert.equal(response.status, 401);
  assert.deepEqual(requests, []);
});

test('admin and shared static files use asset binding', async () => {
  for (const path of ['/static/admin.js', '/flags/us.svg', '/os-icons/debian.svg']) {
    const { requests, env } = assets();
    const response = await serveFrontend(new Request('https://example.com' + path), env, settings);
    assert.equal(response.headers.get('Content-Type'), 'application/javascript');
    assert.deepEqual(requests, [path]);
  }
});
