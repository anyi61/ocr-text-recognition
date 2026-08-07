'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('release version validates package, manifest, and runtime export source', async () => {
  const { readReleaseVersion } = await import('../scripts/package-extension.mjs');
  assert.equal(readReleaseVersion(path.resolve(__dirname, '..')), require('../package.json').version);
});

test('release version rejects a package and manifest mismatch', async () => {
  const { readReleaseVersion } = await import('../scripts/package-extension.mjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-version-'));
  fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"version":"2.0.0"}');
  fs.writeFileSync(path.join(tempRoot, 'manifest.json'), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(tempRoot, 'options.js'), 'chrome.runtime.getManifest().version');
  assert.throws(() => readReleaseVersion(tempRoot), /Version mismatch/);
});
