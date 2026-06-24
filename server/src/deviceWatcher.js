import { execFile } from 'node:child_process';
import net from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { rebuildMergedDevices } from './deviceMergedStore.js';

const ASSETS_DIR = String(process.env.OPSDOG_ASSETS_DIR || '').trim()
  || path.resolve(process.cwd(), 'server/data/assets');
const MERGED_PATH = path.join(ASSETS_DIR, 'device.merged.json');
const STATUS_PATH = path.join(ASSETS_DIR, 'device.status.json');
const META_PATH = path.join(ASSETS_DIR, 'device.meta.json');

const readJson = async (absolutePath, fallback) => {
  try {
    const raw = await readFile(absolutePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeJson = async (absolutePath, payload) => {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(payload, null, 2), 'utf8');
};

const buildPingArgs = (host, timeoutMs) => {
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  if (process.platform === 'win32') {
    return ['-n', '1', '-w', String(timeoutSec * 1000), host];
  }
  if (process.platform === 'darwin') {
    return ['-c', '1', '-W', String(timeoutSec * 1000), host];
  }
  return ['-c', '1', '-W', String(timeoutSec), host];
};

const execPing = (host, timeoutMs) => {
  return new Promise((resolve) => {
    const start = Date.now();
    execFile('ping', buildPingArgs(host, timeoutMs), { timeout: timeoutMs + 2000 }, (error, stdout) => {
      const elapsed = Date.now() - start;
      if (error) {
        resolve({ ok: false, latencyMs: null, error: String(error.message || error) });
        return;
      }
      const timeMatch = stdout.match(/time[=<]\s*(\d+\.?\d*)\s*ms/);
      const latencyMs = timeMatch ? parseFloat(timeMatch[1]) : elapsed;
      resolve({ ok: true, latencyMs });
    });
  });
};

const execTcp = (host, port, timeoutMs) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      const elapsed = Date.now() - start;
      socket.destroy();
      resolve({ ok, latencyMs: ok ? elapsed : null, error });
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true, null));
    socket.on('error', (err) => finish(false, err.message));
    socket.on('timeout', () => finish(false, 'timed out'));
    socket.connect(port, host);
  });
};

const normalizeFallbackTcpPorts = (target) => {
  if (!Array.isArray(target.fallbackTcpPorts)) return [];
  const primaryPort = Number(target.checkPort || 0);
  const seen = new Set([primaryPort]);
  return target.fallbackTcpPorts
    .map((port) => Number(port))
    .filter((port) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || seen.has(port)) return false;
      seen.add(port);
      return true;
    });
};

const executeTcpWithFallback = async (target, executeTcp) => {
  const ports = [Number(target.checkPort), ...normalizeFallbackTcpPorts(target)];
  const errors = [];
  for (const port of ports) {
    const result = await executeTcp(target.checkTarget, port, target.timeoutMs);
    if (result.ok) return { ...result, port };
    if (result.error) errors.push(`${port}: ${result.error}`);
  }
  return { ok: false, latencyMs: null, error: errors.join('; ') };
};

const computeStatus = (failCount, failThreshold, checkType, pingOk, tcpOk) => {
  if (failCount >= failThreshold) return 'critical';
  if (failCount > 0) return 'attention';

  const checkTypes = checkType.split('+').map((s) => s.trim());
  if (checkTypes.includes('ping') && pingOk) return 'healthy';
  if (checkTypes.includes('tcp') && tcpOk) return 'healthy';
  if (pingOk !== undefined && tcpOk !== undefined) return 'critical';

  return 'healthy';
};

const buildMessage = (checkType, pingOk, tcpOk) => {
  const checkTypes = checkType.split('+').map((s) => s.trim());
  const parts = [];

  if (checkTypes.includes('ping')) {
    parts.push(pingOk ? 'ping 正常' : 'ping 失败');
  }
  if (checkTypes.includes('tcp')) {
    parts.push(tcpOk ? 'tcp 正常' : 'tcp 失败');
  }

  return parts.join(' / ');
};

const CHECK_INTERVAL_MS = 5000;
let watcherTimer = null;
let watcherRunning = false;

export const runTargetCheck = async (target, existing, {
  executePing = execPing,
  executeTcp = execTcp,
  now = () => new Date().toISOString(),
} = {}) => {
  const checkTypes = target.checkType.split('+').map((s) => s.trim());
  let pingOk = null;
  let tcpOk = null;
  let latencyMs = null;
  const errors = [];

  const [pingResult, tcpResult] = await Promise.all([
    checkTypes.includes('ping')
      ? executePing(target.checkTarget, target.timeoutMs)
      : Promise.resolve(null),
    checkTypes.includes('tcp') && target.checkPort
      ? executeTcpWithFallback(target, executeTcp)
      : Promise.resolve(null),
  ]);

  if (pingResult) {
    pingOk = pingResult.ok;
    if (pingResult.ok) {
      latencyMs = pingResult.latencyMs;
    } else if (pingResult.error) {
      errors.push(pingResult.error);
    }
  }

  if (tcpResult) {
    tcpOk = tcpResult.ok;
    if (latencyMs == null && tcpResult.ok) {
      latencyMs = tcpResult.latencyMs;
    } else if (tcpResult.error) {
      errors.push(tcpResult.error);
    }
  }

  const checkedAt = now();
  const online = pingOk === true || tcpOk === true;
  let failCount = existing.failCount || 0;
  let lastSuccessAt = existing.lastSuccessAt;
  let lastFailureAt = existing.lastFailureAt;

  if (online) {
    failCount = 0;
    lastSuccessAt = checkedAt;
  } else {
    failCount += 1;
    lastFailureAt = checkedAt;
  }

  return {
    source: target.source,
    deviceId: target.deviceId,
    status: computeStatus(failCount, target.failThreshold, target.checkType, pingOk, tcpOk),
    online,
    checkType: target.checkType,
    lastCheckAt: checkedAt,
    lastSuccessAt,
    lastFailureAt,
    latencyMs,
    failCount,
    lastError: online ? '' : errors.join('; ') || '',
    message: buildMessage(target.checkType, pingOk, tcpOk),
  };
};

const legacyWatcherStore = {
  listMonitorTargets: async () => {
    const metaPayload = await readJson(META_PATH, { items: [] });
    const metaItems = Array.isArray(metaPayload?.items) ? metaPayload.items : [];
    const metaMap = new Map();
    for (const item of metaItems) {
      const key = `${item.source}::${item.deviceId}`;
      if (item.monitorEnabled !== false) {
        metaMap.set(key, item);
      }
    }

    const mergedPayload = await readJson(MERGED_PATH, { items: [] });
    const mergedItems = Array.isArray(mergedPayload?.items) ? mergedPayload.items : [];

    const targets = [];
    for (const device of mergedItems) {
      const key = `${device.source}::${device.deviceId}`;
      const meta = metaMap.get(key);
      if (!meta || !meta.monitorEnabled) continue;
      if (!meta.checkTarget || meta.checkType === '') continue;

      targets.push({
        source: device.source,
        deviceId: device.deviceId,
        checkType: meta.checkType || 'ping',
        checkTarget: meta.checkTarget,
        checkPort: meta.checkPort,
        timeoutMs: meta.timeoutMs || 3000,
        failThreshold: meta.failThreshold || 3,
      });
    }
    return targets;
  },

  readDeviceStatus: async () => {
    const statusPayload = await readJson(STATUS_PATH, { items: [] });
    return Array.isArray(statusPayload?.items) ? statusPayload.items : [];
  },

  writeDeviceStatus: async (items) => {
    await writeJson(STATUS_PATH, { items });
    await rebuildMergedDevices();
  },
};

let configuredWatcherStore = null;

export const configureDeviceWatcherStore = (store) => {
  configuredWatcherStore = store || null;
};

export const runDeviceCheckCycle = async ({
  store = configuredWatcherStore || legacyWatcherStore,
  checkTarget = runTargetCheck,
} = {}) => {
  if (watcherRunning) return;
  watcherRunning = true;
  try {
    const targets = await store.listMonitorTargets();
    const statusItems = await store.readDeviceStatus();
    const statusMap = new Map();
    for (const item of statusItems) {
      statusMap.set(`${item.source}::${item.deviceId}`, item);
    }

    const updatedStatusItems = await Promise.all(targets.map((target) => {
      const key = `${target.source}::${target.deviceId}`;
      const existing = statusMap.get(key) || {
        source: target.source,
        deviceId: target.deviceId,
        status: 'unknown',
        online: false,
        checkType: target.checkType,
        lastCheckAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        latencyMs: null,
        failCount: 0,
        lastError: '',
        message: '等待首次检测',
      };
      return checkTarget(target, existing);
    }));

    await store.writeDeviceStatus(updatedStatusItems);
  } catch (error) {
    console.warn('[deviceWatcher] check cycle failed:', error instanceof Error ? error.message : String(error));
  } finally {
    watcherRunning = false;
  }
};

export const startDeviceWatcher = () => {
  if (watcherTimer) return;
  watcherTimer = setInterval(() => {
    void runDeviceCheckCycle();
  }, CHECK_INTERVAL_MS);
  void runDeviceCheckCycle();
};

export const stopDeviceWatcher = () => {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  watcherRunning = false;
};
