import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFoundationRepositories } from './foundationRepositories.js';

const toRecordArray = (payload, key) => Array.isArray(payload?.[key]) ? payload[key] : [];

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const toAssetStatus = (value, useStatus) => {
  if (value === 'attention' || Number(useStatus) === 13) return 'attention';
  if (value === 'critical') return 'critical';
  if (value === 'unknown') return 'unknown';
  return 'healthy';
};

const toRemoteDeviceType = (assetType) => {
  if (Number(assetType) === 1) return 'server';
  if (Number(assetType) === 2) return 'storage';
  if (Number(assetType) === 3) return 'security';
  return 'network';
};

const toLocalDeviceType = (deviceType) => {
  if (deviceType === 'storage' || deviceType === 'security' || deviceType === 'network') {
    return deviceType;
  }
  return 'server';
};

const sourceDeviceKey = (source, externalId) => `${source}::${externalId}`;
const databaseDeviceId = (source, externalId) => `${source}:${externalId}`;
const monitorProfileId = (deviceId) => `monitor:${deviceId}`;

const mapLocalDevice = (source, at) => {
  const externalId = String(source.id || '');
  return {
    id: databaseDeviceId('local', externalId),
    assetSourceId: 'local-default',
    externalId,
    name: String(source.name || ''),
    assetId: String(source.assetId || ''),
    deviceType: toLocalDeviceType(source.deviceType),
    assetStatus: toAssetStatus(source.status),
    ipAddress: String(source.ipAddress || ''),
    managementIp: '',
    manufacturer: String(source.manufacturer || ''),
    model: String(source.model || ''),
    serialNumber: String(source.serialNumber || ''),
    organization: String(source.organization || ''),
    owner: String(source.owner || ''),
    location: String(source.location || ''),
    remark: String(source.remark || ''),
    sourcePayloadJson: JSON.stringify(source),
    createdAt: String(source.createdAt || at),
    updatedAt: String(source.updatedAt || at),
    syncedAt: at,
  };
};

const mapRemoteDevice = (source, at) => {
  const externalId = String(source.id || '');
  return {
    id: databaseDeviceId('remote', externalId),
    assetSourceId: 'remote-default',
    externalId,
    name: String(source.name || source.deviceName || ''),
    assetId: externalId,
    deviceType: toRemoteDeviceType(source.assetType),
    assetStatus: toAssetStatus(undefined, source.useStatus),
    ipAddress: String(source.ipAddr || ''),
    managementIp: String(source.manageIpAddr || ''),
    manufacturer: String(source.deviceBrand || ''),
    model: String(source.deviceModel || ''),
    serialNumber: String(source.productSn || ''),
    organization: String(source.customerName || ''),
    owner: String(source.manageUser || ''),
    location: String(source.jfName || ''),
    remark: String(source.remark || ''),
    sourcePayloadJson: JSON.stringify(source),
    createdAt: at,
    updatedAt: at,
    syncedAt: at,
  };
};

const mapMonitorProfile = (metadata, deviceId, at) => {
  const checkTypes = String(metadata.checkType || '').split('+');
  return {
    id: monitorProfileId(deviceId),
    deviceId,
    enabled: metadata.monitorEnabled ? 1 : 0,
    checkPing: checkTypes.includes('ping') ? 1 : 0,
    checkTcp: checkTypes.includes('tcp') ? 1 : 0,
    targetHost: String(metadata.checkTarget || ''),
    targetPort: metadata.checkPort ?? null,
    intervalSeconds: Number(metadata.intervalSec || 5),
    timeoutMs: Number(metadata.timeoutMs || 3000),
    failureThreshold: Number(metadata.failThreshold || 3),
    notifyVoice: metadata.notifyVoice ? 1 : 0,
    notifyAlert: metadata.notifyAlert === false ? 0 : 1,
    comment: String(metadata.comment || ''),
    createdAt: at,
    updatedAt: at,
  };
};

const mapMonitorStatus = (status, profileId) => ({
  monitorProfileId: profileId,
  status: ['healthy', 'attention', 'critical', 'unknown'].includes(status.status)
    ? status.status
    : 'unknown',
  online: status.online ? 1 : 0,
  lastCheckAt: status.lastCheckAt || null,
  lastSuccessAt: status.lastSuccessAt || null,
  lastFailureAt: status.lastFailureAt || null,
  latencyMs: status.latencyMs ?? null,
  failureCount: Number(status.failCount || 0),
  lastError: String(status.lastError || ''),
  message: String(status.message || ''),
});

const backupAssetJson = async ({ assetsDir, backupRoot, at }) => {
  const directoryName = `assets-backup-${at.replace(/[^0-9A-Za-z-]/g, '-')}`;
  const destination = path.join(backupRoot, directoryName);
  await mkdir(backupRoot, { recursive: true });
  await cp(assetsDir, destination, { recursive: true });
  return destination;
};

export const importJsonAssets = async ({
  database,
  assetsDir,
  backupRoot,
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
}) => {
  const repositories = createFoundationRepositories(database);
  if (repositories.isInitialImportComplete()) {
    return { status: 'already_imported' };
  }

  const startedAt = now();
  const runId = createId();
  const sourceBackupPath = await backupAssetJson({ assetsDir, backupRoot, at: startedAt });
  const summary = {
    importedDevices: 0,
    importedMonitorProfiles: 0,
    issueCount: 0,
  };

  repositories.startImportRun({ id: runId, sourceBackupPath, startedAt });

  try {
    const localPayload = await readJson(path.join(assetsDir, 'devices.local.json'));
    const remotePayload = await readJson(path.join(assetsDir, 'device.remote.json'));
    const metaPayload = await readJson(path.join(assetsDir, 'device.meta.json'));
    const statusPayload = await readJson(path.join(assetsDir, 'device.status.json'));
    const devicesBySourceKey = new Map();
    const profilesBySourceKey = new Map();

    database.transaction(() => {
      repositories.upsertSource({
        id: 'local-default',
        name: 'Local devices',
        sourceType: 'local',
        readOnly: 0,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      repositories.upsertSource({
        id: 'remote-default',
        name: 'Remote assets',
        sourceType: 'remote_api',
        readOnly: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
      });

      for (const rawDevice of toRecordArray(localPayload, 'devices')) {
        const device = mapLocalDevice(rawDevice, startedAt);
        repositories.upsertDevice(device);
        devicesBySourceKey.set(sourceDeviceKey('local', device.externalId), device.id);
        summary.importedDevices += 1;
      }
      for (const rawDevice of toRecordArray(remotePayload, 'data')) {
        const device = mapRemoteDevice(rawDevice, startedAt);
        repositories.upsertDevice(device);
        devicesBySourceKey.set(sourceDeviceKey('remote', device.externalId), device.id);
        summary.importedDevices += 1;
      }

      for (const metadata of toRecordArray(metaPayload, 'items')) {
        const source = metadata.source === 'remote' ? 'remote' : 'local';
        const externalId = String(metadata.deviceId || '');
        const key = sourceDeviceKey(source, externalId);
        const deviceId = devicesBySourceKey.get(key);
        if (!deviceId) {
          repositories.recordIssue({
            id: createId(),
            importRunId: runId,
            sourceFile: 'device.meta.json',
            sourceRecordKey: key,
            issueCode: 'orphan_monitor_metadata',
            issueSummary: 'Monitor metadata has no imported device record.',
            sourceRecordJson: JSON.stringify(metadata),
            createdAt: startedAt,
          });
          summary.issueCount += 1;
          continue;
        }

        repositories.replaceTags(deviceId, Array.isArray(metadata.tags) ? metadata.tags : [], startedAt);
        const profile = mapMonitorProfile(metadata, deviceId, startedAt);
        repositories.upsertMonitorProfile(profile);
        profilesBySourceKey.set(key, profile.id);
        summary.importedMonitorProfiles += 1;
      }

      for (const status of toRecordArray(statusPayload, 'items')) {
        const source = status.source === 'remote' ? 'remote' : 'local';
        const key = sourceDeviceKey(source, String(status.deviceId || ''));
        const profileId = profilesBySourceKey.get(key);
        if (!profileId) {
          repositories.recordIssue({
            id: createId(),
            importRunId: runId,
            sourceFile: 'device.status.json',
            sourceRecordKey: key,
            issueCode: 'orphan_monitor_status',
            issueSummary: 'Monitor status has no imported monitor profile.',
            sourceRecordJson: JSON.stringify(status),
            createdAt: startedAt,
          });
          summary.issueCount += 1;
          continue;
        }
        repositories.upsertMonitorStatus(mapMonitorStatus(status, profileId));
      }

      repositories.markInitialImportComplete(startedAt);
      repositories.completeImportRun({
        id: runId,
        status: 'succeeded',
        ...summary,
        endedAt: startedAt,
      });
    });
  } catch (error) {
    repositories.completeImportRun({
      id: runId,
      status: 'failed',
      importedDevices: 0,
      importedMonitorProfiles: 0,
      issueCount: 0,
      endedAt: now(),
      errorMessage: String(error.message || error),
    });
    throw error;
  }

  return {
    id: runId,
    status: 'succeeded',
    sourceBackupPath,
    ...summary,
  };
};
