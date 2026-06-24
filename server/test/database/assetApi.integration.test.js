import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

const SERVER_ENTRY = path.resolve(import.meta.dirname, '../../src/index.js');
const authCookieByOrigin = new Map();

const getAuthCookie = async (origin) => {
  const cached = authCookieByOrigin.get(origin);
  if (cached) return cached;
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'opsDog2026!!' }),
  });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /opsdog_session=/);
  authCookieByOrigin.set(origin, cookie);
  return cookie;
};

const authenticatedFetch = async (url, options = {}) => {
  const cookie = await getAuthCookie(new URL(url).origin);
  return await fetch(url, {
    ...options,
    headers: {
      Cookie: cookie,
      ...options.headers,
    },
  });
};

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const disableAutostartSystemServers = async (root) => {
  const serversDir = path.join(root, 'server', 'data', 'servers');
  await mkdir(serversDir, { recursive: true });
  for (const id of ['filesystem', 'markdown_pdf', 'ticketing']) {
    await writeJson(path.join(serversDir, `${id}.server.json`), {
      id,
      name: id,
      category: 'system',
      type: 'mcp-system',
      enabled: false,
    });
  }
};

const reservePort = async () => await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    const port = typeof address === 'object' && address ? address.port : null;
    socket.close((error) => error ? reject(error) : resolve(port));
  });
});

const waitForStarted = async (child) => await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error(`Server start timed out: ${output}`)), 10000);
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (output.includes('OpsDog backend listening')) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`Server exited before startup (${code}): ${output}`));
  });
});

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
  if (!graceful && child.exitCode === null) {
    child.kill('SIGKILL');
  }
};

const waitForFixtureAsset = async (origin) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await authenticatedFetch(`${origin}/api/assets/devices`).then((response) => response.json());
    if (payload.items.some((item) => item.id === 'local:fixture-local')) return payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Fixture asset did not become available through the HTTP API.');
};

test('HTTP asset API persists local changes in SQLite without rewriting imported JSON', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-api-sqlite-'));
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  const databasePath = path.join(root, 'runtime', 'opsdog.db');
  const originalLocalPayload = {
    devices: [{
      id: 'fixture-local',
      name: 'Fixture Server',
      assetId: 'FIXTURE-1',
      deviceType: 'server',
      status: 'healthy',
      ipAddress: '127.0.0.1',
      createdAt: '2026-05-26T10:00:00.000Z',
      updatedAt: '2026-05-26T10:00:00.000Z',
    }],
  };
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), originalLocalPayload);
  await writeJson(path.join(assetsDir, 'device.remote.json'), { code: 0, data: [], msg: '' });
  await writeJson(path.join(assetsDir, 'device.meta.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.status.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.merged.json'), { generatedAt: null, total: 0, items: [] });
  await disableAutostartSystemServers(root);

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      OPSDOG_SERVER_ORIGIN: origin,
      ASSET_API_MODE: 'local',
      OPSDOG_DATABASE_PATH: databasePath,
      OPSDOG_ASSETS_DIR: assetsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForStarted(child);
    const initial = await waitForFixtureAsset(origin);
    assert.equal(initial.items.some((item) => item.id === 'local:fixture-local'), true);

    const created = await authenticatedFetch(`${origin}/api/assets/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'created-local',
        name: 'Created Server',
        assetId: 'CREATED-1',
        ipAddress: '127.0.0.2',
        deviceType: 'server',
        status: 'healthy',
      }),
    }).then((response) => response.json());
    assert.equal(created.id, 'local:created-local');

    const updated = await authenticatedFetch(`${origin}/api/assets/devices/${encodeURIComponent(created.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Server' }),
    }).then((response) => response.json());
    assert.equal(updated.name, 'Updated Server');

    const status = await authenticatedFetch(`${origin}/api/monitor/status?source=local`)
      .then((response) => response.json());
    assert.equal(status.items.some((item) => item.deviceId === 'created-local'), true);

    assert.deepEqual(
      JSON.parse(await readFile(path.join(assetsDir, 'devices.local.json'), 'utf8')),
      originalLocalPayload,
    );

    await authenticatedFetch(`${origin}/api/assets/devices/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
    const afterDelete = await authenticatedFetch(`${origin}/api/assets/merged?source=local`)
      .then((response) => response.json());
    assert.equal(afterDelete.items.some((item) => item.id === created.id), false);

    await stopChild(child);
    const database = openSqliteAdapter({ databasePath });
    try {
      assert.equal(database.get("SELECT COUNT(*) AS count FROM devices WHERE id = 'local:fixture-local'").count, 1);
      assert.ok(database.get("SELECT deleted_at FROM devices WHERE id = 'local:created-local'").deleted_at);
    } finally {
      database.close();
    }
  } finally {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP asset API defaults to local SQLite assets without requiring legacy device.json', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-api-default-local-'));
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  const databasePath = path.join(root, 'runtime', 'opsdog.db');
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'fixture-local',
      name: 'Default Local Server',
      assetId: 'DEFAULT-1',
      deviceType: 'server',
      status: 'healthy',
      ipAddress: '127.0.0.1',
    }],
  });
  await writeJson(path.join(assetsDir, 'device.remote.json'), { code: 0, data: [], msg: '' });
  await writeJson(path.join(assetsDir, 'device.meta.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.status.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.merged.json'), { generatedAt: null, total: 0, items: [] });
  await disableAutostartSystemServers(root);

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const { ASSET_API_MODE: _assetApiMode, ...baseEnv } = process.env;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: {
      ...baseEnv,
      OPSDOG_SERVER_ORIGIN: origin,
      OPSDOG_DATABASE_PATH: databasePath,
      OPSDOG_ASSETS_DIR: assetsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForStarted(child);
    const response = await authenticatedFetch(`${origin}/api/assets/devices`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.items.some((item) => item.id === 'local:fixture-local'), true);
  } finally {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP asset API retains JSON behavior when SQLite activation fails', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-api-fallback-'));
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  const childCwd = path.join(root, 'isolated-cwd');
  await mkdir(assetsDir, { recursive: true });
  await mkdir(childCwd, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'fixture-local',
      name: 'Fallback Server',
      assetId: 'FALLBACK-1',
      deviceType: 'server',
      status: 'healthy',
      ipAddress: '127.0.0.1',
    }],
  });
  await writeJson(path.join(assetsDir, 'device.remote.json'), { code: 0, data: [], msg: '' });
  await writeJson(path.join(assetsDir, 'device.meta.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.status.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.merged.json'), { generatedAt: null, total: 0, items: [] });
  await disableAutostartSystemServers(childCwd);

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: childCwd,
    env: {
      ...process.env,
      OPSDOG_SERVER_ORIGIN: origin,
      ASSET_API_MODE: 'local',
      OPSDOG_DATABASE_PATH: root,
      OPSDOG_ASSETS_DIR: assetsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForStarted(child);
    await waitForFixtureAsset(origin);
    const created = await authenticatedFetch(`${origin}/api/assets/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'json-created',
        name: 'JSON Created',
        assetId: 'JSON-1',
        ipAddress: '127.0.0.2',
        deviceType: 'server',
        status: 'healthy',
      }),
    }).then((response) => response.json());
    assert.equal(created.id, 'local:json-created');
    const localJson = JSON.parse(await readFile(path.join(assetsDir, 'devices.local.json'), 'utf8'));
    assert.equal(localJson.devices.some((device) => device.id === 'json-created'), true);
  } finally {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  }
});
