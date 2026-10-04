'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function write(root, name, contents = name) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

async function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { PRODUCTION_FILES } = await import('../scripts/package-extension.mjs');
  for (const name of PRODUCTION_FILES) {
    write(root, name === '_locales' ? '_locales/en/messages.json' : name === 'icons' ? 'icons/icon.svg' : name);
  }
  write(root, 'package.json', JSON.stringify({ version: '3.4.5' }));
  write(root, 'manifest.json', JSON.stringify({ version: '3.4.5' }));
  write(root, 'options.js', "const exportData = { version: '3.4.5' };\n");
  write(root, '.gitignore', '/dist/\n/node_modules/\n');
  write(root, '.github/workflows/ci.yml', 'name: CI');
  write(root, 'docs/guide.md', 'Documentation included');
  write(root, 'tests/example.test.js', 'Tests included');
  write(root, 'README.md', 'Install guide');
  write(root, '.env.production', 'PRIVATE_TEST_ONLY');
  write(root, 'docs/private.pem', 'PRIVATE_TEST_ONLY');
  write(root, 'logs/debug.log', 'PRIVATE_TEST_ONLY');
  write(root, 'test-results/output.txt', 'RUNTIME_TEST_ONLY');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: root });
  write(root, 'node_modules/dependency/index.js', 'DEPENDENCY_TEST_ONLY');
  return root;
}

test('release artifacts contain installable sources, matching checksums and commit metadata without private or generated files', async (t) => {
  const root = await checkout(t);
  const { buildReleaseArtifacts } = await import('../scripts/release-artifacts.mjs');
  const result = buildReleaseArtifacts(root, { tag: 'v3.4.5' });
  const files = fs.readdirSync(result.directory).sort();
  assert.deepEqual(files, ['SHA256SUMS', 'ocr-text-recognition-extension-3.4.5.zip', 'ocr-text-recognition-source-3.4.5.tar.gz', 'release-metadata.json']);
  const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
  assert.equal(metadata.version, '3.4.5');
  assert.equal(metadata.git.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  assert.deepEqual({ dirty: metadata.git.dirty, tag: metadata.git.tag }, { dirty: false, tag: 'v3.4.5' });
  for (const line of fs.readFileSync(result.checksumPath, 'utf8').trim().split('\n')) {
    const [checksum, filename] = line.split('  ');
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(result.directory, filename))).digest('hex'), checksum);
  }
  const sourceEntries = execFileSync('tar', ['-tzf', result.sourcePath], { encoding: 'utf8' });
  for (const file of ['manifest.json', 'README.md', '.github/workflows/ci.yml', 'docs/guide.md', 'tests/example.test.js']) {
    assert.ok(sourceEntries.split('\n').includes(`ocr-text-recognition-3.4.5/${file}`), file);
  }
  for (const excluded of ['node_modules', '/dist/', '.env.production', 'private.pem', '/logs/', 'test-results']) {
    assert.ok(!sourceEntries.includes(excluded), excluded);
  }
  const installEntries = execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' });
  assert.ok(installEntries.includes('manifest.json\n'));
  assert.ok(installEntries.includes('background.js\n'));
  for (const excluded of ['tests/', 'docs/', '.github/', '.env']) assert.ok(!installEntries.includes(excluded));
});

test('source artifacts include current uncommitted project files and declare a dirty checkout', async (t) => {
  const root = await checkout(t);
  write(root, 'new-runtime.js', 'new implementation');
  write(root, 'README.md', 'Updated install guide');
  fs.rmSync(path.join(root, 'docs/guide.md'));
  const { buildReleaseArtifacts } = await import('../scripts/release-artifacts.mjs');
  const result = buildReleaseArtifacts(root);
  assert.equal(result.metadata.git.dirty, true);
  assert.equal(result.metadata.git.tag, null);
  const contents = execFileSync('tar', ['-xOzf', result.sourcePath, 'ocr-text-recognition-3.4.5/new-runtime.js'], { encoding: 'utf8' });
  assert.equal(contents, 'new implementation');
  const guide = execFileSync('tar', ['-xOzf', result.sourcePath, 'ocr-text-recognition-3.4.5/README.md'], { encoding: 'utf8' });
  assert.equal(guide, 'Updated install guide');
  const entries = execFileSync('tar', ['-tzf', result.sourcePath], { encoding: 'utf8' });
  assert.ok(!entries.includes('docs/guide.md'));
});

test('mismatched tags and unsafe versions stop before creating artifacts', async (t) => {
  const root = await checkout(t);
  const { buildReleaseArtifacts } = await import('../scripts/release-artifacts.mjs');
  assert.throws(() => buildReleaseArtifacts(root, { tag: 'v3.4.6' }), /does not match/);
  assert.ok(!fs.existsSync(path.join(root, 'dist')));
  for (const file of ['package.json', 'manifest.json']) write(root, file, JSON.stringify({ version: '../escape' }));
  write(root, 'options.js', "const data = { version: '../escape' };");
  assert.throws(() => buildReleaseArtifacts(root), /major.minor.patch/);
  assert.ok(!fs.existsSync(path.join(root, 'dist')));
});

test('source collection refuses symlinks instead of following paths outside the repository', async (t) => {
  const root = await checkout(t);
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'external-copy.md'));
  const { listSourceFiles } = await import('../scripts/release-artifacts.mjs');
  assert.throws(() => listSourceFiles(root), /regular files/);
});
