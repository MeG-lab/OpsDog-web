import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const installerDirectory = path.join(projectRoot, '.desktop-installers');
const nodeInstallerName = 'node-lts-x64.msi';
const pythonInstallerName = 'python-x64.exe';
const nodeIndexUrl = 'https://nodejs.org/dist/index.json';
const pythonDownloadsUrl = 'https://www.python.org/downloads/windows/';
const execFileAsync = promisify(execFile);

const existsWithContent = async (filePath) => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() && fileStat.size > 1024 * 1024;
  } catch {
    return false;
  }
};

const parseVersionParts = (version) => version.split('.').map((part) => Number.parseInt(part, 10));

const compareVersions = (left, right) => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const fetchText = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载索引失败：${url} (${response.status})`);
    return await response.text();
  } catch (error) {
    const { stdout } = await execFileAsync('curl', ['-fsSL', '--compressed', url], { maxBuffer: 20 * 1024 * 1024 });
    if (!stdout) throw error;
    return stdout;
  }
};

const downloadWithCurl = (url, targetPath) => new Promise((resolve, reject) => {
  const child = spawn('curl', ['-fL', '--compressed', '--progress-bar', '-o', targetPath, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`curl 下载失败：${url} (exit ${code})`));
  });
});

const resolveNodeInstallerUrl = async () => {
  if (process.env.OPSDOG_NODE_INSTALLER_URL) return process.env.OPSDOG_NODE_INSTALLER_URL;

  const releases = JSON.parse(await fetchText(nodeIndexUrl));
  const selected = releases.find((release) => {
    const major = Number.parseInt(String(release.version).replace(/^v/, '').split('.')[0], 10);
    return release.lts && major >= 24 && release.files?.includes('win-x64-msi');
  }) || releases.find((release) => release.lts && release.files?.includes('win-x64-msi'));

  if (!selected) throw new Error('未找到可用的 Node.js LTS Windows x64 MSI。');
  return `https://nodejs.org/dist/${selected.version}/node-${selected.version}-x64.msi`;
};

const resolvePythonInstallerUrl = async () => {
  if (process.env.OPSDOG_PYTHON_INSTALLER_URL) return process.env.OPSDOG_PYTHON_INSTALLER_URL;

  const downloadsPage = await fetchText(pythonDownloadsUrl);
  const matches = [...downloadsPage.matchAll(/(?:https:\/\/www\.python\.org)?(\/ftp\/python\/(\d+\.\d+\.\d+)\/python-\2-amd64\.exe)/g)];
  const candidates = new Map(matches.map((match) => [match[2], `https://www.python.org${match[1]}`]));
  const selectedVersion = [...candidates.keys()].sort(compareVersions).at(-1);
  if (!selectedVersion) throw new Error('未找到可用的 Python Windows x64 安装器。');
  return candidates.get(selectedVersion);
};

const downloadInstaller = async ({ label, url, targetName }) => {
  const targetPath = path.join(installerDirectory, targetName);
  if (await existsWithContent(targetPath)) {
    console.log(`${label}: using cached ${targetPath}`);
    return targetPath;
  }

  console.log(`${label}: downloading ${url}`);
  const temporaryPath = `${targetPath}.download`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label} 下载失败：${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(temporaryPath, buffer);
  } catch {
    await downloadWithCurl(url, temporaryPath);
  }
  await rename(temporaryPath, targetPath);
  return targetPath;
};

await mkdir(installerDirectory, { recursive: true });

const nodeInstallerUrl = await resolveNodeInstallerUrl();
const pythonInstallerUrl = await resolvePythonInstallerUrl();
const nodeInstallerPath = await downloadInstaller({
  label: 'Node.js LTS',
  url: nodeInstallerUrl,
  targetName: nodeInstallerName,
});
const pythonInstallerPath = await downloadInstaller({
  label: 'Python',
  url: pythonInstallerUrl,
  targetName: pythonInstallerName,
});

await writeFile(
  path.join(installerDirectory, 'manifest.json'),
  `${JSON.stringify({
    node: { url: nodeInstallerUrl, file: nodeInstallerName },
    python: { url: pythonInstallerUrl, file: pythonInstallerName },
  }, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify({ nodeInstallerPath, pythonInstallerPath }, null, 2));
