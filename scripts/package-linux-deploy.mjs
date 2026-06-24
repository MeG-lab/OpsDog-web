import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_ROOT = process.cwd();
const RELEASES_DIR = path.join(APP_ROOT, 'releases');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const packageName = `OpsDog-linux-${timestamp}`;
const bundleDir = path.join(RELEASES_DIR, packageName);
const tarPath = path.join(RELEASES_DIR, `${packageName}.tar.gz`);

const copyTargets = [
  '.env.example',
  'README.md',
  'appConfig.js',
  'appConfig.d.ts',
  'dist',
  'package.json',
  'package-lock.json',
  'server/src',
  'tools',
];

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const ensureJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

const copyIfExists = async (relativePath) => {
  try {
    await cp(path.join(APP_ROOT, relativePath), path.join(bundleDir, relativePath), { recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

const removeJunk = async (directory) => {
  const candidates = [
    '.DS_Store',
    '.env',
    '.env copy',
    '.playwright-mcp',
    '.desktop-installers',
    '.desktop-runtime',
    'node_modules',
    'release-desktop',
    'server/data/opsdog',
    'server/data/opsdog.db',
    'server/data/opsdog.db-shm',
    'server/data/opsdog.db-wal',
    'tools/.DS_Store',
    'tools/script/.DS_Store',
    'tools/skill-packages/aliyun-voice-notify/.venv',
  ];
  await Promise.all(candidates.map((candidate) => (
    rm(path.join(directory, candidate), { recursive: true, force: true })
  )));
};

const writeEmptyAssets = async () => {
  const assetsDir = path.join(bundleDir, 'server', 'data', 'assets');
  const templatesDir = path.join(assetsDir, 'templates');
  await mkdir(templatesDir, { recursive: true });

  const files = {
    'device.remote.json': { code: 0, data: [], msg: '' },
    'devices.local.json': { devices: [] },
    'device.meta.json': { items: [] },
    'device.status.json': { items: [] },
    'device.merged.json': { generatedAt: null, total: 0, items: [] },
  };

  await Promise.all(Object.entries(files).flatMap(([name, payload]) => [
    ensureJson(path.join(assetsDir, name), payload),
    ensureJson(path.join(templatesDir, name), payload),
  ]));

  await writeFile(path.join(templatesDir, 'README.md'), [
    '初始化模板目录。',
    '',
    'Linux 部署包默认不携带任何设备数据。',
    '如需重置设备界面为空，可复制本目录 JSON 到上一层 server/data/assets。',
    '',
  ].join('\n'), 'utf8');
};

const writeCleanMcpData = async () => {
  const mcpDir = path.join(bundleDir, 'server', 'data', 'mcp');
  await mkdir(mcpDir, { recursive: true });
  await writeFile(path.join(mcpDir, '.gitkeep'), '', 'utf8');

  const market = await readJson(path.join(APP_ROOT, 'server', 'data', 'mcp-market.json'), { items: [] });
  await ensureJson(path.join(bundleDir, 'server', 'data', 'mcp-market.json'), market);
};

const writeCleanServerData = async () => {
  const dataDir = path.join(bundleDir, 'server', 'data');
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await writeEmptyAssets();
  await writeCleanMcpData();

  await mkdir(path.join(dataDir, 'opsdog'), { recursive: true });
  await mkdir(path.join(dataDir, 'reports'), { recursive: true });
  await mkdir(path.join(dataDir, 'servers'), { recursive: true });
  await mkdir(path.join(dataDir, 'ticketing'), { recursive: true });
  await ensureJson(path.join(dataDir, 'ticketing', 'asset-mappings.json'), []);
  await ensureJson(path.join(dataDir, 'ticketing', 'ticket-records.json'), []);

  await writeFile(path.join(dataDir, 'README.md'), [
    '# OpsDog Linux 数据目录',
    '',
    '- `assets/` 默认是空设备台账，Linux 部署包不会携带开发环境设备。',
    '- `opsdog/` 存放 SQLite 运行库，首次启动自动创建。',
    '- `mcp/` 默认不携带运行态 MCP Server 配置。',
    '- `reports/` 存放报告输出。',
    '',
  ].join('\n'), 'utf8');
};

const writeBundlePackageJson = async () => {
  const filePath = path.join(bundleDir, 'package.json');
  const payload = await readJson(filePath, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

  const scripts = {
    ...(payload.scripts || {}),
    start: 'node server/src/index.js',
    'start:server': 'node server/src/index.js',
    'install:linux': 'bash install-linux.sh',
  };

  await ensureJson(filePath, {
    ...payload,
    engines: {
      ...(payload.engines || {}),
      node: '>=22.22.0',
    },
    scripts,
    devDependencies: {},
  });
};

const writeLinuxFiles = async () => {
  await cp(
    path.join(APP_ROOT, 'deploy', 'linux', 'install-linux.sh'),
    path.join(bundleDir, 'install-linux.sh'),
  );
  await chmod(path.join(bundleDir, 'install-linux.sh'), 0o755);

  await writeFile(path.join(bundleDir, 'README-linux.md'), [
    '# OpsDog Linux 部署包',
    '',
    '## 快速安装',
    '',
    '```bash',
    'tar -xzf OpsDog-linux-*.tar.gz',
    'cd OpsDog-linux-*',
    './install-linux.sh -y',
    '```',
    '',
    '默认启动地址：`http://127.0.0.1:8788/`。',
    '',
    '## 常用命令',
    '',
    '```bash',
    './install-linux.sh --check-only',
    './install-linux.sh --no-start',
    './install-linux.sh --reset-assets -y',
    './start-linux.sh',
    './stop-linux.sh',
    './status-linux.sh',
    '```',
    '',
    '## 设备数据',
    '',
    'Linux 部署包默认写入空设备台账：',
    '',
    '- `server/data/assets/device.remote.json`',
    '- `server/data/assets/devices.local.json`',
    '- `server/data/assets/device.meta.json`',
    '- `server/data/assets/device.status.json`',
    '- `server/data/assets/device.merged.json`',
    '',
    '首次打开设备界面时不会带入开发环境设备。',
    '',
  ].join('\n'), 'utf8');
};

const stripMacExtendedAttributes = async () => {
  try {
    await execFileAsync('xattr', ['-cr', bundleDir]);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
};

const assertBuiltWebExists = async () => {
  try {
    await readFile(path.join(APP_ROOT, 'dist', 'index.html'), 'utf8');
  } catch {
    throw new Error('dist/index.html not found. Run npm run build before packaging.');
  }
};

await assertBuiltWebExists();
await rm(bundleDir, { recursive: true, force: true });
await rm(tarPath, { force: true });
await mkdir(bundleDir, { recursive: true });
await mkdir(RELEASES_DIR, { recursive: true });

for (const target of copyTargets) {
  await copyIfExists(target);
}

await removeJunk(bundleDir);
await writeCleanServerData();
await writeBundlePackageJson();
await writeLinuxFiles();
await stripMacExtendedAttributes();

await execFileAsync('tar', ['--no-xattrs', '-czf', tarPath, packageName], {
  cwd: RELEASES_DIR,
  env: {
    ...process.env,
    COPYFILE_DISABLE: '1',
  },
});

process.stdout.write(`${tarPath}\n`);
