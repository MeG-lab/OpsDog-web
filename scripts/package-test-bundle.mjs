import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  await rm(path.join(bundleDir, 'server', 'data', 'reports'), { recursive: true, force: true });
  await mkdir(path.join(bundleDir, 'server', 'data', 'reports'), { recursive: true });
  await rm(path.join(bundleDir, 'server', 'data', 'servers'), { recursive: true, force: true });
  await mkdir(path.join(bundleDir, 'server', 'data', 'servers'), { recursive: true });
  await removeArtifacts(bundleDir);

  const readme = [
    '# 测试包说明',
    '',
    '1. 复制 `.env.example` 为 `.env`。',
    '2. 执行 `npm install`。',
    '3. 执行 `npm run dev:all` 或 `npm run build` 后再启动后端。',
    '4. `server/data/servers/` 为空是正常的，首次启动会自动生成本机可用的系统服务配置。',
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
