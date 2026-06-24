import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import {
  BACKEND_HOST,
  BACKEND_ORIGIN,
  BACKEND_PORT,
  ensureBackendPortAvailable,
  startBackendProcess,
  waitForBackendHealth,
} from '../../../desktop/main/backendProcess.mjs';

test('desktop backend process uses a stable local origin', () => {
  assert.equal(BACKEND_HOST, '127.0.0.1');
  assert.equal(BACKEND_PORT, 8788);
  assert.equal(BACKEND_ORIGIN, 'http://127.0.0.1:8788');
});

test('desktop backend process reports occupied backend port clearly', async () => {
  const occupiedProbe = new EventEmitter();
  occupiedProbe.listen = () => {
    const error = new Error('occupied');
    error.code = 'EADDRINUSE';
    occupiedProbe.emit('error', error);
  };

  await assert.rejects(
    ensureBackendPortAvailable({
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      createServer: () => occupiedProbe,
    }),
    /8788.*占用/,
  );
});

test('desktop backend health polling retries until ready', async () => {
  let calls = 0;
  await waitForBackendHealth({
    origin: BACKEND_ORIGIN,
    timeoutMs: 100,
    intervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return { ok: calls >= 3 };
    },
  });

  assert.equal(calls, 3);
});

test('desktop backend starts Windows runtime in local asset mode', async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = { stdout, stderr, kill: () => undefined };
  let invocation = null;
  let logs = '';

  const result = await startBackendProcess({
    runtimeRoot: '/runtime',
    serverEntry: path.join('/app', 'server/src/index.js'),
    platform: 'win32',
    forkProcess: (modulePath, args, options) => {
      invocation = { modulePath, args, options };
      return child;
    },
    ensurePortAvailable: async () => undefined,
    waitUntilHealthy: async () => undefined,
    onLog: (message) => { logs += message; },
  });

  stdout.emit('data', Buffer.from('ready'));
  stderr.emit('data', Buffer.from('warn'));

  assert.equal(result, child);
  assert.equal(invocation.modulePath, path.join('/app', 'server/src/index.js'));
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.options.cwd, '/runtime');
  assert.equal(invocation.options.stdio, 'pipe');
  assert.equal(invocation.options.env.OPSDOG_SERVER_ORIGIN, BACKEND_ORIGIN);
  assert.equal(invocation.options.env.ASSET_API_MODE, 'local');
  assert.equal(logs, 'readywarn');
});
