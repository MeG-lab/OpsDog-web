import assert from 'node:assert/strict';
import test from 'node:test';
import { runDeviceCheckCycle, runTargetCheck } from '../../src/deviceWatcher.js';

const FIXED_NOW = '2026-05-26T10:00:00.000Z';
const target = {
  source: 'local',
  deviceId: 'server-1',
  checkType: 'ping+tcp',
  checkTarget: '127.0.0.1',
  checkPort: 22,
  timeoutMs: 3000,
  failThreshold: 2,
};

const existing = {
  source: 'local',
  deviceId: 'server-1',
  status: 'attention',
  online: false,
  checkType: 'ping+tcp',
  lastCheckAt: null,
  lastSuccessAt: null,
  lastFailureAt: '2026-05-26T09:59:00.000Z',
  latencyMs: null,
  failCount: 1,
  lastError: 'previous failure',
  message: 'ping 失败 / tcp 失败',
};

test('target checks reset failures after success and advance attention to critical on failures', async () => {
  const healthy = await runTargetCheck(target, existing, {
    now: () => FIXED_NOW,
    executePing: async () => ({ ok: true, latencyMs: 3 }),
    executeTcp: async () => ({ ok: true, latencyMs: 4 }),
  });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.online, true);
  assert.equal(healthy.failCount, 0);
  assert.equal(healthy.lastSuccessAt, FIXED_NOW);

  const attention = await runTargetCheck(target, { ...existing, failCount: 0 }, {
    now: () => FIXED_NOW,
    executePing: async () => ({ ok: false, latencyMs: null, error: 'ping failed' }),
    executeTcp: async () => ({ ok: false, latencyMs: null, error: 'tcp failed' }),
  });
  assert.equal(attention.status, 'attention');
  assert.equal(attention.failCount, 1);

  const critical = await runTargetCheck(target, existing, {
    now: () => FIXED_NOW,
    executePing: async () => ({ ok: false, latencyMs: null, error: 'ping failed' }),
    executeTcp: async () => ({ ok: false, latencyMs: null, error: 'tcp failed' }),
  });
  assert.equal(critical.status, 'critical');
  assert.equal(critical.failCount, 2);
  assert.equal(critical.lastFailureAt, FIXED_NOW);
});

test('target checks may recover default SSH port failures through TELNET fallback', async () => {
  const healthy = await runTargetCheck({ ...target, fallbackTcpPorts: [23] }, existing, {
    now: () => FIXED_NOW,
    executePing: async () => ({ ok: false, latencyMs: null, error: 'spawn ping ENOENT' }),
    executeTcp: async (_host, port) => {
      if (port === 23) return { ok: true, latencyMs: 4 };
      return { ok: false, latencyMs: null, error: `connect ECONNREFUSED 127.0.0.1:${port}` };
    },
  });

  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.online, true);
  assert.equal(healthy.failCount, 0);
  assert.equal(healthy.lastError, '');
});

test('watcher cycle obtains targets and status through an injected store and writes results', async () => {
  let written = null;
  const store = {
    listMonitorTargets: async () => [target],
    readDeviceStatus: async () => [existing],
    writeDeviceStatus: async (items) => {
      written = items;
    },
  };

  await runDeviceCheckCycle({
    store,
    checkTarget: (nextTarget, previous) => runTargetCheck(nextTarget, previous, {
      now: () => FIXED_NOW,
      executePing: async () => ({ ok: true, latencyMs: 2 }),
      executeTcp: async () => ({ ok: true, latencyMs: 2 }),
    }),
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].deviceId, 'server-1');
  assert.equal(written[0].status, 'healthy');
  assert.equal(written[0].failCount, 0);
});
