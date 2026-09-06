import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PRODUCTION_FILES = Object.freeze([
  'manifest.json',
  'background.js',
  'background',
  'background-core.js',
  'background-message-router.js',
  'capture-utils.js',
  'content',
  'content.js',
  'extension-runtime.js',
  'history-store.js',
  'i18n-runtime.js',
  'provider-config.js',
  'providers',
  'request-runtime.js',
  'options.html',
  'options.css',
  'options',
  'options.js',
  'popup.html',
  'popup.css',
  'popup',
  'popup.js',
  '_locales',
  'icons'
]);

export function readReleaseVersion(root = ROOT) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const optionsSource = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
  if (packageJson.version !== manifest.version) {
    throw new Error(`Version mismatch: package=${packageJson.version}, manifest=${manifest.version}`);
  }
  if (!/chrome\.runtime\.getManifest\(\)\.version/.test(optionsSource)) {
    throw new Error('Export configuration must read the runtime manifest version');
  }
  return packageJson.version;
}

export function buildPackage(root = ROOT) {
  const version = readReleaseVersion(root);
  for (const relativePath of PRODUCTION_FILES) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      throw new Error(`Missing production file: ${relativePath}`);
    }
  }

  const distDirectory = path.join(root, 'dist');
  const zipPath = path.join(distDirectory, `ocr-text-recognition-extension-${version}.zip`);
  fs.mkdirSync(distDirectory, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  const result = spawnSync('zip', ['-q', '-X', '-r', zipPath, ...PRODUCTION_FILES], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `zip exited with status ${result.status}`);
  }
  return zipPath;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    console.log(buildPackage());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
