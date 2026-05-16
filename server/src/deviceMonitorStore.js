import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ASSETS_DIR = path.resolve(process.cwd(), 'server/data/assets');
const META_PATH = path.join(ASSETS_DIR, 'device.meta.json');
const STATUS_PATH = path.join(ASSETS_DIR, 'device.status.json');
const LOCAL_PATH = path.join(ASSETS_DIR, 'devices.local.json');

const ensureJsonFile = async (absolutePath, fallback) => {
  try {
    await stat(absolutePath);
  } catch {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, JSON.stringify(fallback, null, 2), 'utf8');
  }
};

const readJson = async (absolutePath, fallback) => {
  await ensureJsonFile(absolutePath, fallback);
  const raw = await readFile(absolutePath, 'utf8');
  return JSON.parse(raw);
};

const writeJson = async (absolutePath, payload) => {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(payload, null, 2), 'utf8');
};

const buildMetaKey = (source, deviceId) => `${source}::${deviceId}`;

const defaultMonitorProfile = (device) => {
  const deviceType = String(device?.deviceType || 'server');
  const ipAddress = String(device?.ipAddress || '').trim();

  if (deviceType === 'security') {
    return {
      checkType: 'tcp',
      checkTarget: ipAddress,
      checkPort: 443,
    };
  }

  if (deviceType === 'storage') {
    return {
      checkType: 'ping',
      checkTarget: ipAddress,
      checkPort: null,
    };
  }

  return {
    checkType: 'ping+tcp',
    checkTarget: ipAddress,
    checkPort: 22,
  };
};

export const readDeviceMeta = async () => {
  const payload = await readJson(META_PATH, { items: [] });
  return Array.isArray(payload?.items) ? payload.items : [];
};

export const writeDeviceMeta = async (items) => {
  await writeJson(META_PATH, { items });
};

export const readDeviceStatus = async () => {
  const payload = await readJson(STATUS_PATH, { items: [] });
  return Array.isArray(payload?.items) ? payload.items : [];
};

export const writeDeviceStatus = async (items) => {
  await writeJson(STATUS_PATH, { items });
};

export const upsertLocalDeviceMonitorDefaults = async (device) => {
  const metaItems = await readDeviceMeta();
  const statusItems = await readDeviceStatus();
  const key = buildMetaKey('local', device.id);
  const profile = defaultMonitorProfile(device);
  const metaIndex = metaItems.findIndex((item) => buildMetaKey(item?.source || 'local', item?.deviceId || '') === key);
  const statusIndex = statusItems.findIndex((item) => buildMetaKey(item?.source || 'local', item?.deviceId || '') === key);

  const nextMeta = {
    source: 'local',
    deviceId: device.id,
    tags: metaIndex >= 0 && Array.isArray(metaItems[metaIndex].tags) ? metaItems[metaIndex].tags : ['用户添加'],
    monitorEnabled: true,
    checkType: profile.checkType,
    checkTarget: profile.checkTarget,
    checkPort: profile.checkPort,
    intervalSec: metaIndex >= 0 ? metaItems[metaIndex].intervalSec ?? 15 : 15,
    timeoutMs: metaIndex >= 0 ? metaItems[metaIndex].timeoutMs ?? 3000 : 3000,
    failThreshold: metaIndex >= 0 ? metaItems[metaIndex].failThreshold ?? 3 : 3,
    notifyVoice: metaIndex >= 0 ? Boolean(metaItems[metaIndex].notifyVoice) : false,
    notifyAlert: metaIndex >= 0 ? Boolean(metaItems[metaIndex].notifyAlert) : true,
    comment: metaIndex >= 0 ? String(metaItems[metaIndex].comment || '') : '本地设备默认自动启用在线检测。',
  };

  if (metaIndex >= 0) {
    metaItems[metaIndex] = nextMeta;
  } else {
    metaItems.unshift(nextMeta);
  }

  const nextStatus = {
    source: 'local',
    deviceId: device.id,
    status: statusIndex >= 0 ? statusItems[statusIndex].status || 'unknown' : 'unknown',
    online: statusIndex >= 0 ? Boolean(statusItems[statusIndex].online) : false,
    checkType: profile.checkType,
    lastCheckAt: statusIndex >= 0 ? statusItems[statusIndex].lastCheckAt || null : null,
    lastSuccessAt: statusIndex >= 0 ? statusItems[statusIndex].lastSuccessAt || null : null,
    lastFailureAt: statusIndex >= 0 ? statusItems[statusIndex].lastFailureAt || null : null,
    latencyMs: statusIndex >= 0 ? statusItems[statusIndex].latencyMs ?? null : null,
    failCount: statusIndex >= 0 ? Number(statusItems[statusIndex].failCount || 0) : 0,
    lastError: statusIndex >= 0 ? String(statusItems[statusIndex].lastError || '') : '',
    message: statusIndex >= 0 ? String(statusItems[statusIndex].message || '等待首次检测') : '等待首次检测',
  };

  if (statusIndex >= 0) {
    statusItems[statusIndex] = nextStatus;
  } else {
    statusItems.unshift(nextStatus);
  }

  await writeDeviceMeta(metaItems);
  await writeDeviceStatus(statusItems);
};

export const removeLocalDeviceMonitorEntries = async (deviceId) => {
  const metaItems = await readDeviceMeta();
  const statusItems = await readDeviceStatus();
  const key = buildMetaKey('local', deviceId);

  await writeDeviceMeta(metaItems.filter((item) => buildMetaKey(item?.source || 'local', item?.deviceId || '') != key));
  await writeDeviceStatus(statusItems.filter((item) => buildMetaKey(item?.source || 'local', item?.deviceId || '') != key));
};

export const syncLocalDevicesMonitorDefaults = async () => {
  const payload = await readJson(LOCAL_PATH, { devices: [] });
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  for (const device of devices) {
    if (!device || typeof device !== 'object') continue;
    await upsertLocalDeviceMonitorDefaults(device);
  }
};
