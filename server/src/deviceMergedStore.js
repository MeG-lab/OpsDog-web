import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ASSETS_DIR = String(process.env.OPSDOG_ASSETS_DIR || '').trim()
  || path.resolve(process.cwd(), 'server/data/assets');
const REMOTE_PATH = path.join(ASSETS_DIR, 'device.remote.json');
const LOCAL_PATH = path.join(ASSETS_DIR, 'devices.local.json');
const META_PATH = path.join(ASSETS_DIR, 'device.meta.json');
const STATUS_PATH = path.join(ASSETS_DIR, 'device.status.json');
const MERGED_PATH = path.join(ASSETS_DIR, 'device.merged.json');

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

const toDeviceType = (assetType) => {
  if (Number(assetType) === 1) return 'server';
  if (Number(assetType) === 2) return 'storage';
  if (Number(assetType) === 3) return 'security';
  return 'network';
};

const toAssetType = (deviceType) => {
  if (deviceType === 'server') return 1;
  if (deviceType === 'storage') return 2;
  if (deviceType === 'security') return 3;
  return 4;
};

const toAssetStatus = (rawStatus, useStatus) => {
  if (rawStatus === 'attention' || Number(useStatus) === 13) return 'attention';
  if (rawStatus === 'critical') return 'critical';
  if (Number(useStatus) === 1 || Number(useStatus) === 10) return 'healthy';
  return 'healthy';
};

const buildMergedId = (source, deviceId) => `${source}:${deviceId}`;
const buildSourceKey = (source, deviceId) => `${source}::${deviceId}`;

const normalizeRemoteDevice = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const deviceId = String(source.id || '');
  return {
    id: buildMergedId('remote', deviceId),
    source: 'remote',
    deviceId,
    remoteId: deviceId,
    localDeviceId: null,
    editable: false,
    name: String(source.name || source.deviceName || ''),
    assetId: String(source.id || ''),
    assetType: Number(source.assetType || 4),
    deviceType: toDeviceType(source.assetType),
    ipAddress: String(source.ipAddr || ''),
    manageIpAddr: String(source.manageIpAddr || ''),
    deviceBrand: String(source.deviceBrand || ''),
    deviceModel: String(source.deviceModel || ''),
    productSn: String(source.productSn || ''),
    customerId: String(source.customerId || ''),
    customerName: String(source.customerName || ''),
    providerName: String(source.providerName || ''),
    jfName: String(source.jfName || ''),
    organization: String(source.customerName || ''),
    owner: String(source.manageUser || ''),
    location: String(source.jfName || ''),
    remark: String(source.remark || ''),
    manageUser: String(source.manageUser || ''),
    manageUserPhone: String(source.manageUserPhone || ''),
    operatorIds: String(source.operatorIds || ''),
    operatorNames: String(source.operatorNames || ''),
    openPort: String(source.openPort || ''),
    useStatus: source.useStatus ?? null,
    assetStatus: toAssetStatus(undefined, source.useStatus),
    status: toAssetStatus(undefined, source.useStatus),
    createdAt: null,
    updatedAt: null,
    tags: [],
    monitorEnabled: false,
    checkType: '',
    checkTarget: '',
    checkPort: null,
    intervalSec: null,
    timeoutMs: null,
    failThreshold: null,
    notifyVoice: false,
    notifyAlert: false,
    comment: '',
    monitorStatus: 'unknown',
    online: false,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    latencyMs: null,
    failCount: 0,
    lastError: '',
    message: '',
    mergedUpdatedAt: new Date().toISOString(),
  };
};

const normalizeLocalDevice = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const deviceId = String(source.id || '');
  return {
    id: buildMergedId('local', deviceId),
    source: 'local',
    deviceId,
    remoteId: null,
    localDeviceId: deviceId,
    editable: true,
    name: String(source.name || ''),
    assetId: String(source.assetId || ''),
    assetType: toAssetType(source.deviceType),
    deviceType: source.deviceType === 'storage'
      ? 'storage'
      : source.deviceType === 'security'
        ? 'security'
        : source.deviceType === 'network'
          ? 'network'
          : 'server',
    ipAddress: String(source.ipAddress || ''),
    manageIpAddr: '',
    deviceBrand: String(source.manufacturer || ''),
    deviceModel: String(source.model || ''),
    productSn: String(source.serialNumber || ''),
    customerId: '',
    customerName: String(source.organization || ''),
    providerName: '',
    jfName: String(source.location || ''),
    organization: String(source.organization || ''),
    owner: String(source.owner || ''),
    location: String(source.location || ''),
    remark: String(source.remark || ''),
    manageUser: String(source.owner || ''),
    manageUserPhone: '',
    operatorIds: '',
    operatorNames: '',
    openPort: '',
    useStatus: null,
    assetStatus: toAssetStatus(source.status),
    status: toAssetStatus(source.status),
    createdAt: String(source.createdAt || ''),
    updatedAt: String(source.updatedAt || ''),
    tags: [],
    monitorEnabled: false,
    checkType: '',
    checkTarget: '',
    checkPort: null,
    intervalSec: null,
    timeoutMs: null,
    failThreshold: null,
    notifyVoice: false,
    notifyAlert: false,
    comment: '',
    monitorStatus: 'unknown',
    online: false,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    latencyMs: null,
    failCount: 0,
    lastError: '',
    message: '',
    mergedUpdatedAt: new Date().toISOString(),
  };
};

const applyMeta = (merged, meta) => ({
  ...merged,
  tags: Array.isArray(meta.tags) ? meta.tags : [],
  monitorEnabled: Boolean(meta.monitorEnabled),
  checkType: String(meta.checkType || ''),
  checkTarget: String(meta.checkTarget || ''),
  checkPort: meta.checkPort ?? null,
  intervalSec: meta.intervalSec ?? null,
  timeoutMs: meta.timeoutMs ?? null,
  failThreshold: meta.failThreshold ?? null,
  notifyVoice: Boolean(meta.notifyVoice),
  notifyAlert: Boolean(meta.notifyAlert),
  comment: String(meta.comment || ''),
});

const applyStatus = (merged, status) => {
  const monitorStatus = String(status.status || 'unknown');
  return {
    ...merged,
    monitorStatus,
    status: monitorStatus === 'unknown' ? merged.assetStatus : monitorStatus,
    online: Boolean(status.online),
    lastCheckAt: status.lastCheckAt || null,
    lastSuccessAt: status.lastSuccessAt || null,
    lastFailureAt: status.lastFailureAt || null,
    latencyMs: typeof status.latencyMs === 'number' ? status.latencyMs : null,
    failCount: Number(status.failCount || 0),
    lastError: String(status.lastError || ''),
    message: String(status.message || ''),
  };
};

const filterMergedDevices = (items, query = {}) => {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (entries.length === 0) return items;

  return items.filter((item) => entries.every(([key, value]) => {
    const expected = String(value).trim().toLowerCase();
    if (!expected) return true;

    if (key === 'name') return item.name.toLowerCase().includes(expected);
    if (key === 'ipAddr') return item.ipAddress.toLowerCase().includes(expected);
    if (key === 'assetType') return String(item.assetType) === expected;
    if (key === 'source') return item.source === expected;
    return true;
  }));
};

export const rebuildMergedDevices = async () => {
  const remotePayload = await readJson(REMOTE_PATH, { code: 0, data: [] });
  const localPayload = await readJson(LOCAL_PATH, { devices: [] });
  const metaPayload = await readJson(META_PATH, { items: [] });
  const statusPayload = await readJson(STATUS_PATH, { items: [] });

  const remoteItems = Array.isArray(remotePayload?.data) ? remotePayload.data : [];
  const localItems = Array.isArray(localPayload?.devices) ? localPayload.devices : [];
  const metaItems = Array.isArray(metaPayload?.items) ? metaPayload.items : [];
  const statusItems = Array.isArray(statusPayload?.items) ? statusPayload.items : [];

  const mergedMap = new Map();

  for (const item of remoteItems) {
    const normalized = normalizeRemoteDevice(item);
    mergedMap.set(buildSourceKey('remote', normalized.deviceId), normalized);
  }

  for (const item of localItems) {
    const normalized = normalizeLocalDevice(item);
    mergedMap.set(buildSourceKey('local', normalized.deviceId), normalized);
  }

  for (const item of metaItems) {
    const source = item?.source === 'remote' ? 'remote' : 'local';
    const deviceId = String(item?.deviceId || '');
    const key = buildSourceKey(source, deviceId);
    const existing = mergedMap.get(key);
    if (!existing) continue;
    mergedMap.set(key, applyMeta(existing, item));
  }

  for (const item of statusItems) {
    const source = item?.source === 'remote' ? 'remote' : 'local';
    const deviceId = String(item?.deviceId || '');
    const key = buildSourceKey(source, deviceId);
    const existing = mergedMap.get(key);
    if (!existing) continue;
    mergedMap.set(key, applyStatus(existing, item));
  }

  const generatedAt = new Date().toISOString();
  const items = Array.from(mergedMap.values())
    .map((item) => ({ ...item, mergedUpdatedAt: generatedAt }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

  const payload = {
    generatedAt,
    total: items.length,
    items,
  };

  await mkdir(path.dirname(MERGED_PATH), { recursive: true });
  await writeFile(MERGED_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
};

export const readMergedDevices = async () => {
  await ensureJsonFile(MERGED_PATH, { generatedAt: null, total: 0, items: [] });
  const payload = await readJson(MERGED_PATH, { generatedAt: null, total: 0, items: [] });
  return {
    generatedAt: payload.generatedAt || null,
    total: Number(payload.total || 0),
    items: Array.isArray(payload.items) ? payload.items : [],
  };
};

export const listMergedDevices = async (query = {}) => {
  const payload = await readMergedDevices();
  const items = filterMergedDevices(payload.items, query);
  return {
    generatedAt: payload.generatedAt,
    total: payload.total,
    filteredTotal: items.length,
    items,
  };
};
