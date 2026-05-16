import { exec } from 'node:child_process';
import net from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { rebuildMergedDevices } from './deviceMergedStore.js';

const ASSETS_DIR = path.resolve(process.cwd(), 'server/data/assets');
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

const execPing = (host, timeoutMs) => {
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  return new Promise((resolve) => {
    const cmd = `ping -c 1 -W ${timeoutSec * 1000} ${host}`;
    const start = Date.now();
    exec(cmd, { timeout: timeoutMs + 2000 }, (error, stdout) => {
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

let watcherTimer = null;

const runCheckCycle = async () => {
  try {
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

    const statusPayload = await readJson(STATUS_PATH, { items: [] });
    const statusItems = Array.isArray(statusPayload?.items) ? statusPayload.items : [];
    const statusMap = new Map();
    for (const item of statusItems) {
      statusMap.set(`${item.source}::${item.deviceId}`, item);
    }

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

    const updatedStatusItems = [];

    for (const target of targets) {
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

      const checkTypes = target.checkType.split('+').map((s) => s.trim());
      let pingOk = null;
      let tcpOk = null;
      let latencyMs = null;
      const errors = [];

      if (checkTypes.includes('ping')) {
        const pingResult = await execPing(target.checkTarget, target.timeoutMs);
        pingOk = pingResult.ok;
        if (pingResult.ok) {
          latencyMs = pingResult.latencyMs;
        } else {
          errors.push(pingResult.error);
        }
      }

      if (checkTypes.includes('tcp') && target.checkPort) {
        const tcpResult = await execTcp(target.checkTarget, target.checkPort, target.timeoutMs);
        tcpOk = tcpResult.ok;
        if (!tcpResult.ok) {
          errors.push(tcpResult.error);
        }
      }

      const now = new Date().toISOString();
      const online = pingOk === true || tcpOk === true;
      let failCount = existing.failCount || 0;
      let lastSuccessAt = existing.lastSuccessAt;
      let lastFailureAt = existing.lastFailureAt;

      if (online) {
        failCount = 0;
        lastSuccessAt = now;
      } else {
        failCount += 1;
        lastFailureAt = now;
      }

      const status = computeStatus(failCount, target.failThreshold, target.checkType, pingOk, tcpOk);
      const message = buildMessage(target.checkType, pingOk, tcpOk);

      updatedStatusItems.push({
        source: target.source,
        deviceId: target.deviceId,
        status,
        online,
        checkType: target.checkType,
        lastCheckAt: now,
        lastSuccessAt,
        lastFailureAt,
        latencyMs,
        failCount,
        lastError: errors.join('; ') || '',
        message,
      });
    }

    await writeJson(STATUS_PATH, { items: updatedStatusItems });
    await rebuildMergedDevices();
  } catch (error) {
    console.warn('[deviceWatcher] check cycle failed:', error.message);
  }
};

export const startDeviceWatcher = () => {
  if (watcherTimer) return;

  const schedule = () => {
    watcherTimer = setTimeout(() => {
      void runCheckCycle().finally(() => schedule());
    }, 5000);
  };

  void runCheckCycle().finally(() => schedule());
};

export const stopDeviceWatcher = () => {
  if (watcherTimer) {
    clearTimeout(watcherTimer);
    watcherTimer = null;
  }
};