'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('release package uses an explicit production allowlist', async () => {
  const { PRODUCTION_FILES } = await import('../scripts/package-extension.mjs');

  assert.ok(PRODUCTION_FILES.includes('manifest.json'));
  assert.ok(PRODUCTION_FILES.includes('background.js'));
  assert.ok(PRODUCTION_FILES.includes('_locales'));
  for (const excluded of ['tests', 'docs', 'node_modules', '.git', '.codegraph']) {
    assert.ok(!PRODUCTION_FILES.includes(excluded), `${excluded} must not be packaged`);
  }
});
