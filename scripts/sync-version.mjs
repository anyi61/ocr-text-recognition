import fs from 'node:fs/promises';

const packageUrl = new URL('../package.json', import.meta.url);
const manifestUrl = new URL('../manifest.json', import.meta.url);
const [packageJson, manifestSource] = await Promise.all([
  fs.readFile(packageUrl, 'utf8').then(JSON.parse),
  fs.readFile(manifestUrl, 'utf8')
]);
const manifest = JSON.parse(manifestSource);

if (manifest.version !== packageJson.version) {
  manifest.version = packageJson.version;
  await fs.writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Synchronized manifest.json to ${packageJson.version}`);
} else {
  console.log(`manifest.json already synchronized at ${packageJson.version}`);
}
