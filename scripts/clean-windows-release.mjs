import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const releaseDirectory = path.join(projectRoot, 'release-desktop');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const installerName = `opsDog-${packageJson.version}-x64.exe`;
const installerPath = path.join(releaseDirectory, installerName);

await access(installerPath);

const entries = await readdir(releaseDirectory, { withFileTypes: true });
await Promise.all(entries
  .filter((entry) => entry.name !== installerName)
  .map((entry) => rm(path.join(releaseDirectory, entry.name), {
    force: true,
    recursive: true,
  })));

console.log(installerPath);
