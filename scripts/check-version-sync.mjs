import fs from 'node:fs/promises';
import process from 'node:process';

const [packageJson, manifest] = await Promise.all([
  fs.readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse)
]);

if (packageJson.version !== manifest.version) {
  console.error(`Version mismatch: package.json=${packageJson.version}, manifest.json=${manifest.version}`);
  process.exitCode = 1;
} else {
  console.log(`Version synchronized: ${manifest.version}`);
}
