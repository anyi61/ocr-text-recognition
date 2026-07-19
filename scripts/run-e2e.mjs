import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');

const child = spawn(
  process.execPath,
  [cli, 'test', 'tests/e2e/extension.spec.js', '--workers=1', '--reporter=line'],
  { cwd: root, stdio: 'inherit' }
);

child.on('error', (error) => {
  console.error(`Unable to start Playwright: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Playwright was terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
