import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_ROOT = process.cwd();
const RELEASES_DIR = path.join(APP_ROOT, 'releases');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const packageName = `OpsDog-test-${timestamp}`;
const bundleDir = path.join(RELEASES_DIR, packageName);
const zipPath = path.join(RELEASES_DIR, `${packageName}.zip`);

const copyTargets = [
  '.env.example',
  '.gitignore',
  'README.md',
  'DEPLOY.md',
  'appConfig.js',
  'dev-all.js',
  'device_status.py',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'dist',
  'scripts',
  'server/src',
  'src',
  'tools',
];

const ensureJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const sanitizeDeviceRuntimeDiagnostics = async (filePath) => {
  const payload = await readJson(filePath, null);
  if (!payload || !Array.isArray(payload.items)) return;

  const sanitizedItems = payload.items.map((item) => {
    const next = { ...item };
    if (typeof next.lastError === 'string' && next.lastError.includes('Command failed: ping')) {
      next.lastError = 'ping failed';
    }
    if (typeof next.message === 'string') {
      next.message = next.message.replace(/Command failed: ping[^;]+;?\s*/g, 'ping failed');
    }
    return next;
  });

  await ensureJson(filePath, { ...payload, items: sanitizedItems });
};

const sanitizeMcpRuntimeBaseline = async () => {
  const mcpDir = path.join(bundleDir, 'server', 'data', 'mcp');
  const entries = await readdir(mcpDir, { withFileTypes: true }).catch(() => []);

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const filePath = path.join(mcpDir, entry.name);
      const payload = await readJson(filePath, null);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

      const command = String(payload.command || '').trim().toLowerCase();
      await ensureJson(filePath, {
        ...payload,
        ...(command === 'uvx' ? { autoConnect: false } : {}),
        connectionStatus: 'disconnected',
        lastConnectedAt: null,
        lastToolRefreshAt: null,
        recentLogs: [],
        lastError: null,
      });
    }));
};

const writeBundlePackageJson = async () => {
  const filePath = path.join(bundleDir, 'package.json');
  const payload = await readJson(filePath, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

  await ensureJson(filePath, {
    ...payload,
    scripts: {
      ...(payload.scripts || {}),
      'dev:all': 'node server/src/index.js',
      'start:test': 'node server/src/index.js',
    },
  });
};

const writeBundleLaunchers = async () => {
  const windowsCmd = [
    '@echo off',
    'cd /d "%~dp0"',
    'if not exist .env if exist .env.example copy /Y .env.example .env >nul',
    'echo OpsDog test bundle starting on http://127.0.0.1:8788/',
    'node server\\src\\index.js',
    '',
  ].join('\r\n');
  await writeFile(path.join(bundleDir, 'start-windows.cmd'), windowsCmd, 'utf8');
};

const writeBundleServerBaseline = async () => {
  await ensureJson(path.join(bundleDir, 'server', 'data', 'servers', 'filesystem.server.json'), {
    id: 'filesystem',
    name: 'filesystem',
    category: 'system',
    type: 'mcp-system',
    runtime: 'node',
    transport: 'stdio',
    entry: 'npx',
    description: 'Filesystem MCP Server',
    enabled: false,
    connection: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      headers: {},
      riskLevel: 'read-only',
    },
    capabilities: {
      tools: [],
      recentLogs: [],
    },
  });
};

const copyIntoBundle = async (relativePath) => {
  await cp(path.join(APP_ROOT, relativePath), path.join(bundleDir, relativePath), { recursive: true });
};

const removeArtifacts = async (directory) => {
  const candidates = [
    path.join(directory, '.DS_Store'),
    path.join(directory, 'tools', '.DS_Store'),
    path.join(directory, 'tools', 'script', '.DS_Store'),
  ];
  await Promise.all(candidates.map((candidate) => rm(candidate, { force: true })));
};

const sanitizeBundle = async () => {
  await rm(path.join(bundleDir, '.env'), { force: true });
  await rm(path.join(bundleDir, '.env copy'), { force: true });
  await rm(path.join(bundleDir, 'openclaw-aliyun-voice-skill.zip'), { force: true });
  await rm(path.join(bundleDir, 'node_modules'), { recursive: true, force: true });
  await rm(path.join(bundleDir, 'tools', 'skill-packages', 'aliyun-voice-notify', '.venv'), { recursive: true, force: true });
  await rm(path.join(bundleDir, 'server', 'data'), { recursive: true, force: true });
  await mkdir(path.join(bundleDir, 'server', 'data'), { recursive: true });

  await cp(
    path.join(APP_ROOT, 'server', 'data', 'assets'),
    path.join(bundleDir, 'server', 'data', 'assets'),
    { recursive: true },
  );

  await cp(
    path.join(APP_ROOT, 'server', 'data', 'mcp'),
    path.join(bundleDir, 'server', 'data', 'mcp'),
    { recursive: true },
  );
  await sanitizeMcpRuntimeBaseline();

  try {
    const marketRaw = await readFile(path.join(APP_ROOT, 'server', 'data', 'mcp-market.json'), 'utf8');
    await writeFile(path.join(bundleDir, 'server', 'data', 'mcp-market.json'), marketRaw, 'utf8');
  } catch {
    await ensureJson(path.join(bundleDir, 'server', 'data', 'mcp-market.json'), { items: [] });
  }

  try {
    const mappingRaw = await readFile(path.join(APP_ROOT, 'server', 'data', 'ticketing', 'asset-mappings.json'), 'utf8');
    await writeFile(path.join(bundleDir, 'server', 'data', 'ticketing', 'asset-mappings.json'), mappingRaw, 'utf8');
  } catch {
    await ensureJson(path.join(bundleDir, 'server', 'data', 'ticketing', 'asset-mappings.json'), []);
  }
  await ensureJson(path.join(bundleDir, 'server', 'data', 'ticketing', 'ticket-records.json'), []);

  await rm(path.join(bundleDir, 'server', 'data', 'assets', 'device.remote.json.back'), { force: true });
  await sanitizeDeviceRuntimeDiagnostics(path.join(bundleDir, 'server', 'data', 'assets', 'device.status.json'));
  await sanitizeDeviceRuntimeDiagnostics(path.join(bundleDir, 'server', 'data', 'assets', 'device.merged.json'));
  await rm(path.join(bundleDir, 'server', 'data', 'reports'), { recursive: true, force: true });
  await mkdir(path.join(bundleDir, 'server', 'data', 'reports'), { recursive: true });
  await rm(path.join(bundleDir, 'server', 'data', 'servers'), { recursive: true, force: true });
  await mkdir(path.join(bundleDir, 'server', 'data', 'servers'), { recursive: true });
  await writeBundleServerBaseline();
  await removeArtifacts(bundleDir);
  await writeBundlePackageJson();
  await writeBundleLaunchers();

  const readme = [
    '# 测试包说明',
    '',
    '1. 安装 Node.js 18+、npm 9+；使用 Python 托管脚本时还需要 Python 3.9+。',
    '2. 复制 `.env.example` 为 `.env`，按现场环境填写占位项。',
    '3. Windows 测试包已带前端构建产物，可直接执行根目录 `start-windows.cmd`。',
    '4. 也可执行 `npm run dev:all`；测试包中的该命令会直接启动后端并托管已构建前端。',
    '5. 文件系统 MCP 在测试包中默认不自启；需要时再在界面启用。',
    '6. 详细说明见根目录 `DEPLOY.md`。',
    '',
  ].join('\n');
  await writeFile(path.join(bundleDir, 'server', 'data', 'README.md'), readme, 'utf8');
};

await rm(bundleDir, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(bundleDir, { recursive: true });

for (const target of copyTargets) {
  await copyIntoBundle(target);
}

await sanitizeBundle();

await execFileAsync('zip', ['-rq', zipPath, packageName], { cwd: RELEASES_DIR });

process.stdout.write(`${zipPath}\n`);
