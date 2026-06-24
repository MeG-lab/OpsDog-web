import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

const SERVER_ENTRY = path.resolve(import.meta.dirname, '../../src/index.js');
const SECRET_ONE = 'disposable-api-profile-secret-one';
const SECRET_TWO = 'disposable-api-profile-secret-two';
const TELNET_SECRET = 'disposable-api-telnet-profile-secret';
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
  if (!graceful && child.exitCode === null) child.kill('SIGKILL');
};

const cleanVaultAccount = async (service, account) => {
  if (!account) return;
  const { Entry } = await import('@napi-rs/keyring');
  const entry = new Entry(service, account);
  entry.deletePassword();
};

test('remote profile API stores disposable passwords outside SQLite and returns sanitized profiles', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-remote-profile-api-'));
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  const databasePath = path.join(root, 'runtime', 'opsdog.db');
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'fixture-local',
      name: 'Fixture Server',
      assetId: 'FIXTURE-1',
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
  const unavailableSshPort = await reservePort();
  const unavailableTelnetPort = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      OPSDOG_SERVER_ORIGIN: origin,
      OPSDOG_DATABASE_PATH: databasePath,
      OPSDOG_ASSETS_DIR: assetsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let vaultCredentials = [];

  try {
    await waitForStarted(child);
    const createResponse = await authenticatedFetch(`${origin}/api/remote/devices/${encodeURIComponent('local:fixture-local')}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Primary SSH',
        protocol: 'ssh',
        host: '127.0.0.1',
        port: unavailableSshPort,
        username: 'operator',
        authMethod: 'password',
        password: SECRET_ONE,
        isDefault: true,
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    assert.equal(created.hasPasswordCredential, true);
    assert.equal(JSON.stringify(created).includes(SECRET_ONE), false);

    const updated = await authenticatedFetch(`${origin}/api/remote/profiles/${encodeURIComponent(created.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated SSH', password: SECRET_TWO }),
    }).then((response) => response.json());
    assert.equal(updated.name, 'Updated SSH');
    assert.equal(JSON.stringify(updated).includes(SECRET_TWO), false);

    const listed = await authenticatedFetch(`${origin}/api/remote/devices/${encodeURIComponent('local:fixture-local')}/profiles`)
      .then((response) => response.json());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hasPasswordCredential, true);

    const hostKeysResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(created.id)}/host-keys`,
    );
    assert.equal(hostKeysResponse.status, 200);
    assert.deepEqual(await hostKeysResponse.json(), []);

    const invalidTrustResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(created.id)}/host-key/trust`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: 'invalid-disposable-token' }),
      },
    );
    assert.equal(invalidTrustResponse.status, 400);
    assert.equal((await invalidTrustResponse.json()).details.code, 'HOST_KEY_CHALLENGE_INVALID');

    const failedProbeResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(created.id)}/host-key/probe`,
      { method: 'POST' },
    );
    assert.equal(failedProbeResponse.status, 502);
    assert.equal((await failedProbeResponse.json()).details.code, 'SSH_PROBE_FAILED');

    const failedTestResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(created.id)}/test`,
      { method: 'POST' },
    );
    assert.equal(failedTestResponse.status, 502);
    assert.equal((await failedTestResponse.json()).details.code, 'SSH_PROBE_FAILED');

    const failedTerminalTokenResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(created.id)}/terminal-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 30 }),
      },
    );
    assert.equal(failedTerminalTokenResponse.status, 502);
    assert.equal((await failedTerminalTokenResponse.json()).details.code, 'SSH_PROBE_FAILED');

    const failedProtocolTestResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(created.id)}/test-connection`,
      { method: 'POST' },
    );
    assert.equal(failedProtocolTestResponse.status, 502);
    assert.equal((await failedProtocolTestResponse.json()).details.code, 'SSH_PROBE_FAILED');

    const telnetCreateResponse = await authenticatedFetch(`${origin}/api/remote/devices/${encodeURIComponent('local:fixture-local')}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Legacy TELNET',
        protocol: 'telnet',
        host: '127.0.0.1',
        port: unavailableTelnetPort,
        username: 'operator',
        authMethod: 'password',
        password: TELNET_SECRET,
        plaintextAcknowledged: true,
        sftpEnabled: true,
        connectTimeoutMs: 100,
      }),
    });
    assert.equal(telnetCreateResponse.status, 200);
    const telnetCreated = await telnetCreateResponse.json();
    assert.equal(telnetCreated.protocol, 'telnet');
    assert.equal(telnetCreated.sftpEnabled, false);
    assert.equal(telnetCreated.strictHostKeyChecking, false);
    assert.equal(JSON.stringify(telnetCreated).includes(TELNET_SECRET), false);

    const failedTelnetTestResponse = await authenticatedFetch(
      `${origin}/api/remote/profiles/${encodeURIComponent(telnetCreated.id)}/test-connection`,
      { method: 'POST' },
    );
    assert.equal(failedTelnetTestResponse.status, 502);
    assert.equal((await failedTelnetTestResponse.json()).details.code, 'TELNET_CONNECTION_FAILED');

    const database = openSqliteAdapter({ databasePath });
    try {
      const databaseText = JSON.stringify({
        credentials: database.all('SELECT * FROM credential_refs'),
        profiles: database.all('SELECT * FROM connection_profiles'),
        audit: database.all('SELECT * FROM audit_events'),
      });
      assert.equal(databaseText.includes(SECRET_ONE), false);
      assert.equal(databaseText.includes(SECRET_TWO), false);
      assert.equal(databaseText.includes(TELNET_SECRET), false);
      vaultCredentials = database.all('SELECT vault_service, vault_account FROM credential_refs');
    } finally {
      database.close();
    }

    const deleted = await authenticatedFetch(`${origin}/api/remote/profiles/${encodeURIComponent(created.id)}`, {
      method: 'DELETE',
    }).then((response) => response.json());
    assert.equal(deleted.ok, true);
  } finally {
    await stopChild(child);
    for (const credential of vaultCredentials) {
      await cleanVaultAccount(credential.vault_service, credential.vault_account).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote profile API fails closed when its system vault is disabled', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-remote-profile-disabled-'));
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  const databasePath = path.join(root, 'runtime', 'opsdog.db');
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'fixture-local',
      name: 'Fixture Server',
      assetId: 'FIXTURE-1',
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
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      OPSDOG_SERVER_ORIGIN: origin,
      OPSDOG_DATABASE_PATH: databasePath,
      OPSDOG_ASSETS_DIR: assetsDir,
      OPSDOG_DISABLE_SECRET_STORE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let vaultService = null;
  let vaultAccount = null;

  try {
    await waitForStarted(child);
    const response = await authenticatedFetch(`${origin}/api/remote/devices/${encodeURIComponent('local:fixture-local')}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Disabled Vault SSH',
        protocol: 'ssh',
        host: '127.0.0.1',
        port: 22,
        username: 'operator',
        authMethod: 'password',
        password: 'disposable-disabled-vault-secret',
      }),
    });
    const body = await response.json();

    const database = openSqliteAdapter({ databasePath });
    try {
      const unexpected = database.get('SELECT vault_service, vault_account FROM credential_refs');
      vaultService = unexpected?.vault_service || null;
      vaultAccount = unexpected?.vault_account || null;
      assert.equal(response.status, 503);
      assert.equal(body.details.code, 'SECRET_STORE_UNAVAILABLE');
      assert.equal(database.get('SELECT COUNT(*) AS count FROM credential_refs').count, 0);
      assert.equal(database.get('SELECT COUNT(*) AS count FROM connection_profiles').count, 0);
    } finally {
      database.close();
    }
  } finally {
    await stopChild(child);
    await cleanVaultAccount(vaultService, vaultAccount).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote profile API restricts browser origins without blocking local clients', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-remote-profile-origin-'));
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  const databasePath = path.join(root, 'runtime', 'opsdog.db');
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'fixture-local',
      name: 'Fixture Server',
      assetId: 'FIXTURE-1',
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
  const webOrigin = 'http://127.0.0.1:4175';
  const profileUrl = `${origin}/api/remote/devices/${encodeURIComponent('local:fixture-local')}/profiles`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      OPSDOG_WEB_ORIGIN: webOrigin,
      OPSDOG_SERVER_ORIGIN: origin,
      OPSDOG_DATABASE_PATH: databasePath,
      OPSDOG_ASSETS_DIR: assetsDir,
      OPSDOG_DISABLE_SECRET_STORE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForStarted(child);

    const localClient = await authenticatedFetch(profileUrl);
    assert.equal(localClient.status, 200);
    assert.notEqual(localClient.headers.get('access-control-allow-origin'), '*');

    const allowedBrowser = await authenticatedFetch(profileUrl, { headers: { Origin: webOrigin } });
    assert.equal(allowedBrowser.status, 200);
    assert.equal(allowedBrowser.headers.get('access-control-allow-origin'), webOrigin);

    const rejectedBrowser = await authenticatedFetch(profileUrl, { headers: { Origin: 'https://example.invalid' } });
    assert.equal(rejectedBrowser.status, 403);
    assert.notEqual(rejectedBrowser.headers.get('access-control-allow-origin'), '*');
    assert.equal((await rejectedBrowser.json()).details.code, 'REMOTE_ORIGIN_FORBIDDEN');

    const rejectedPreflight = await authenticatedFetch(profileUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.invalid' },
    });
    assert.equal(rejectedPreflight.status, 403);

    const allowedPreflight = await authenticatedFetch(profileUrl, {
      method: 'OPTIONS',
      headers: { Origin: webOrigin },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), webOrigin);
  } finally {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  }
});
