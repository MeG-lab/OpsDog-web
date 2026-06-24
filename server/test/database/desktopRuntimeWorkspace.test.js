import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { prepareRuntimeWorkspace } from '../../../desktop/main/runtimeWorkspace.mjs';

const temporaryDirectories = [];

const writeFixture = async (root, relativePath, content) => {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
};

const readFixture = (root, relativePath) => readFile(path.join(root, relativePath), 'utf8');

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const createSourceTemplate = async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'opsdog-desktop-source-'));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'opsdog-desktop-runtime-'));
  temporaryDirectories.push(sourceRoot, runtimeRoot);

  await writeFixture(sourceRoot, 'dist/index.html', 'web-v1');
  await writeFixture(sourceRoot, 'server/data/assets/templates/device.merged.json', '{"seed":"merged"}\n');
  await writeFixture(sourceRoot, 'server/data/assets/templates/device.meta.json', '{"seed":"meta"}\n');
  await writeFixture(sourceRoot, 'server/data/assets/templates/device.remote.json', '{"seed":"remote"}\n');
  await writeFixture(sourceRoot, 'server/data/assets/templates/device.status.json', '{"seed":"status"}\n');
  await writeFixture(sourceRoot, 'server/data/assets/templates/devices.local.json', '{"seed":"local"}\n');
  await writeFixture(sourceRoot, 'server/data/mcp-market.json', '{"catalog":[]}\n');
  await writeFixture(sourceRoot, 'tools/script/instant/echo.py', 'print("hello")\n');
  await writeFixture(sourceRoot, 'tools/.DS_Store', 'desktop-metadata');
  await writeFixture(sourceRoot, 'tools/.venv/bin/python', 'virtual-env-binary');
  await writeFixture(sourceRoot, 'tools/skill/.env.example', 'TOKEN=placeholder\n');
  await writeFixture(sourceRoot, '.env', 'UNSAFE=true\n');
  await writeFixture(sourceRoot, 'server/data/mcp/fetch.json', '{"autoConnect":true}\n');
  await writeFixture(sourceRoot, 'server/data/servers/local.server.json', '{"path":"/Users/dev"}\n');

  return { sourceRoot, runtimeRoot };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('desktop runtime workspace initializes writable data without developer state', async () => {
  const { sourceRoot, runtimeRoot } = await createSourceTemplate();

  await prepareRuntimeWorkspace({ sourceRoot, runtimeRoot });

  assert.equal(await readFixture(runtimeRoot, 'dist/index.html'), 'web-v1');
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'package.json')), { type: 'module' });
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/assets/device.merged.json')), {
    generatedAt: null,
    total: 0,
    items: [],
  });
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/assets/device.meta.json')), { items: [] });
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/assets/device.remote.json')), {
    code: 0,
    data: [],
    msg: '',
  });
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/assets/device.status.json')), { items: [] });
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/assets/devices.local.json')), { devices: [] });
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/ticketing/asset-mappings.json')), []);
  assert.deepEqual(JSON.parse(await readFixture(runtimeRoot, 'server/data/ticketing/ticket-records.json')), []);
  assert.equal(await readFixture(runtimeRoot, 'server/data/mcp-market.json'), '{"catalog":[]}\n');
  assert.match(await readFixture(runtimeRoot, 'tools/script/instant/echo.py'), /hello/);
  assert.equal(await exists(path.join(runtimeRoot, 'tools/.DS_Store')), false);
  assert.equal(await exists(path.join(runtimeRoot, 'tools/.venv/bin/python')), false);
  assert.equal(await exists(path.join(runtimeRoot, 'tools/skill/.env.example')), false);
  assert.match(await readFixture(runtimeRoot, '.opsdog-runtime-v1'), /initialized/);
  assert.deepEqual(await readdir(path.join(runtimeRoot, 'server/data/mcp')), []);
  assert.deepEqual(await readdir(path.join(runtimeRoot, 'server/data/servers')), []);
  assert.equal(await exists(path.join(runtimeRoot, '.env')), false);
  assert.equal(await exists(path.join(runtimeRoot, 'server/src/index.js')), false);
  assert.equal(await exists(path.join(runtimeRoot, 'appConfig.js')), false);
  assert.equal(await exists(path.join(runtimeRoot, 'server/data/mcp/fetch.json')), false);
  assert.equal(await exists(path.join(runtimeRoot, 'server/data/servers/local.server.json')), false);
});

test('desktop runtime workspace refreshes packaged code but preserves runtime data', async () => {
  const { sourceRoot, runtimeRoot } = await createSourceTemplate();
  await prepareRuntimeWorkspace({ sourceRoot, runtimeRoot });

  await writeFixture(runtimeRoot, 'server/data/assets/device.merged.json', '{"user":"asset"}\n');
  await writeFixture(runtimeRoot, 'server/data/mcp/user.json', '{"saved":true}\n');
  await writeFixture(runtimeRoot, 'tools/script/custom.py', 'print("custom")\n');
  await writeFixture(sourceRoot, 'dist/index.html', 'web-v2');
  await writeFixture(sourceRoot, 'server/data/assets/templates/device.merged.json', '{"seed":"new"}\n');

  await prepareRuntimeWorkspace({ sourceRoot, runtimeRoot });

  assert.equal(await readFixture(runtimeRoot, 'dist/index.html'), 'web-v2');
  assert.equal(await readFixture(runtimeRoot, 'server/data/assets/device.merged.json'), '{"user":"asset"}\n');
  assert.equal(await readFixture(runtimeRoot, 'server/data/mcp/user.json'), '{"saved":true}\n');
  assert.match(await readFixture(runtimeRoot, 'tools/script/custom.py'), /custom/);
});
