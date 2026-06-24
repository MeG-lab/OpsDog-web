import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SERVER_ENTRY = path.resolve(import.meta.dirname, '../../src/index.js');

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

const seedAssets = async (root) => {
  const assetsDir = path.join(root, 'server', 'data', 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), { devices: [] });
  await writeJson(path.join(assetsDir, 'device.remote.json'), { code: 0, data: [], msg: '' });
  await writeJson(path.join(assetsDir, 'device.meta.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.status.json'), { items: [] });
  await writeJson(path.join(assetsDir, 'device.merged.json'), { generatedAt: null, total: 0, items: [] });
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

const extractCookie = (response) => {
  const raw = response.headers.get('set-cookie') || '';
  assert.match(raw, /opsdog_session=/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  return raw.split(';')[0];
};

test('HTTP auth uses cookie sessions and isolates config and conversations by user', { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-auth-http-'));
  try {
    await seedAssets(root);
    await disableAutostartSystemServers(root);
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: root,
      env: {
        ...process.env,
        OPSDOG_SERVER_ORIGIN: origin,
        OPSDOG_WEB_ORIGIN: origin,
        OPSDOG_DISABLE_SECRET_STORE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForStarted(child);

      const protectedResponse = await fetch(`${origin}/api/assets/devices`);
      assert.equal(protectedResponse.status, 401);
      assert.deepEqual(await protectedResponse.json(), { error: 'Authentication required.' });

      const loginResponse = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'opsDog2026!!' }),
      });
      assert.equal(loginResponse.status, 200);
      const adminCookie = extractCookie(loginResponse);
      const loginBody = await loginResponse.json();
      assert.equal(loginBody.user.username, 'admin');

      const assetResponse = await fetch(`${origin}/api/assets/devices`, {
        headers: { Cookie: adminCookie },
      });
      assert.equal(assetResponse.status, 200);

      const createUser = await fetch(`${origin}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ username: 'operator', password: 'operator-password-2026' }),
      });
      assert.equal(createUser.status, 200);

      await fetch(`${origin}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ activeModelId: 'admin-model', llmConfigs: [] }),
      });
      await fetch(`${origin}/api/conversations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify([{
          id: 'admin-conversation',
          title: 'Admin conversation',
          kind: 'normal',
          modelId: 'admin-model',
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: 'admin-message', role: 'user', content: 'secret', timestamp: 1 }],
        }]),
      });

      const operatorLogin = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: 'operator-password-2026' }),
      });
      assert.equal(operatorLogin.status, 200);
      const operatorCookie = extractCookie(operatorLogin);

      const operatorConfig = await fetch(`${origin}/api/config`, {
        headers: { Cookie: operatorCookie },
      }).then((response) => response.json());
      assert.equal(operatorConfig.activeModelId ?? null, null);

      const operatorConversations = await fetch(`${origin}/api/conversations`, {
        headers: { Cookie: operatorCookie },
      }).then((response) => response.json());
      assert.equal(operatorConversations.some((item) => item.id === 'admin-conversation'), false);

      const logoutResponse = await fetch(`${origin}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: adminCookie },
      });
      assert.equal(logoutResponse.status, 200);
      assert.match(logoutResponse.headers.get('set-cookie') || '', /Max-Age=0/);
      const afterLogout = await fetch(`${origin}/api/config`, { headers: { Cookie: adminCookie } });
      assert.equal(afterLogout.status, 401);
    } finally {
      await stopChild(child);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
