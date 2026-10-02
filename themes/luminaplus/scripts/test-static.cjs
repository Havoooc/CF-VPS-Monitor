const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = mkdtempSync(join(tmpdir(), 'theme-static-test-'));
try {
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'scripts/build-static.mjs'), readFileSync(join(__dirname, 'build-static.mjs')));
  const run = background => {
    writeFileSync(join(root, 'dist/index.html'), '<html><head><meta name="apiBase" content=""><title>test</title></head></html>');
    return spawnSync(process.execPath, [join(root, 'scripts/build-static.mjs')], {
      env: {...process.env, API_BASE:'https://example.invalid', BACKGROUND_IMAGE:background}, encoding:'utf8',
    });
  };
  assert.equal(run('https://example.invalid/image.png').status, 0);
  assert.notEqual(run('https://example.invalid/</style><script src=//example.invalid/poc.js></script>').status, 0);
  assert.notEqual(run('javascript:alert(1)').status, 0);
  console.log('Static build URL regression checks passed');
} finally { rmSync(root, {recursive:true,force:true}); }
