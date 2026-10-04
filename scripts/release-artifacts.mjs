import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPackage, readReleaseVersion } from './package-extension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'test-results', 'playwright-report',
  'logs', 'tmp', 'temp', '.cache', '.codegraph', '.cursor', '.claude', '.agents', 'local-docs'
]);
const PRIVATE_FILE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials|secrets?)(?:\..*)?|PRIVATE\.md)$/i;
const EXCLUDED_EXTENSION = /\.(?:log|pem|key|p12|pfx|jks|keystore|zip|crx|gz|tar|tmp|bak|backup)$/i;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function listSourceFiles(root) {
  const entries = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8'
  }).split('\0').filter(Boolean);
  return [...new Set(entries)].filter((entry) => {
    const parts = entry.split('/');
    if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part) || PRIVATE_FILE.test(part)) || EXCLUDED_EXTENSION.test(entry)) return false;
    if (path.isAbsolute(entry) || parts.includes('..')) throw new Error('Unsafe source archive path');
    const absolutePath = path.join(root, entry);
    // A tracked file may have been deleted locally. Symlinks must never cause
    // a source archive to copy files outside this checkout.
    if (!fs.existsSync(absolutePath)) return false;
    if (!fs.lstatSync(absolutePath).isFile()) throw new Error(`Source archive requires regular files: ${entry}`);
    return true;
  }).sort();
}

export function buildReleaseArtifacts(root = ROOT, { tag } = {}) {
  const version = readReleaseVersion(root);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must use major.minor.patch');
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match version v${version}`);
  }
  const commit = git(root, ['rev-parse', '--verify', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=normal']).length > 0;
  const sourceFiles = listSourceFiles(root);
  const directory = path.join(root, 'dist', `release-${version}`);
  fs.mkdirSync(directory, { recursive: true });
  const zipPath = path.join(directory, path.basename(buildPackage(root)));
  fs.copyFileSync(path.join(root, 'dist', path.basename(zipPath)), zipPath);

  const sourcePath = path.join(directory, `ocr-text-recognition-source-${version}.tar.gz`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-release-source-'));
  const sourceRootName = `ocr-text-recognition-${version}`;
  try {
    for (const relative of sourceFiles) {
      const destination = path.join(temporary, sourceRootName, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, relative), destination);
    }
    execFileSync('tar', ['-czf', sourcePath, '-C', temporary, sourceRootName]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const metadataPath = path.join(directory, 'release-metadata.json');
  const metadata = {
    schemaVersion: 1,
    version,
    createdAt: new Date().toISOString(),
    git: { commit, dirty, tag: tag ?? null },
    sourceFileCount: sourceFiles.length,
    files: [path.basename(zipPath), path.basename(sourcePath)]
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const checksumPath = path.join(directory, 'SHA256SUMS');
  fs.writeFileSync(checksumPath, [zipPath, sourcePath, metadataPath].map((filename) => {
    const checksum = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    return `${checksum}  ${path.basename(filename)}\n`;
  }).join(''));
  return { directory, zipPath, sourcePath, metadataPath, checksumPath, metadata };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
    const result = buildReleaseArtifacts(ROOT, { tag });
    console.log(result.directory);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
