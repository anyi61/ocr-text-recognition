'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('E2E runner accepts an explicit file filter without also selecting the full directory', () => {
  const output = execFileSync(process.execPath,
    ['scripts/run-e2e.mjs', 'review-permissions.spec.js', '--list'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /review-permissions\.spec\.js/);
  assert.doesNotMatch(output, /restored-translation\.spec\.js|auto-copy\.spec\.js/);
  assert.match(output, /Total: 2 tests in 1 file/);
});

test('E2E runner defaults to the entire browser regression suite', () => {
  const output = execFileSync(process.execPath,
    ['scripts/run-e2e.mjs', '--list'], { cwd: root, encoding: 'utf8' });
  for (const file of ['review-permissions', 'restored-translation', 'auto-copy', 'package-smoke']) {
    assert.ok(output.includes(`${file}.spec.js`), `${file} must be selected by default`);
  }
});
