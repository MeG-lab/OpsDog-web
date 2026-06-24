import { randomUUID } from 'node:crypto';

const LOCAL_SOURCE_ID = 'local-default';
const LOCAL_SOURCE_TYPE = 'local';
const REMOTE_SOURCE_TYPE = 'remote_api';

const sourceLabel = (sourceType) => sourceType === REMOTE_SOURCE_TYPE ? 'remote' : 'local';

const toDeviceType = (value) => {
  if (value === 'storage' || value === 'security' || value === 'network') return value;
  return 'server';
};

const toAssetType = (deviceType) => {
  if (deviceType === 'server') return 1;
  if (deviceType === 'storage') return 2;
  if (deviceType === 'security') return 3;
  return 4;
};

const toAssetStatus = (value) => {
  if (value === 'attention' || value === 'critical' || value === 'unknown') return value;
  return 'healthy';
};

const toCheckType = (row) => {
  if (row.check_ping && row.check_tcp) return 'ping+tcp';
  if (row.check_ping) return 'ping';
  if (row.check_tcp) return 'tcp';
  return '';
};

const parsePayload = (value) => {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeLocalAssetDevice = (raw, now) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    assetId: String(source.assetId || ''),
    ipAddress: String(source.ipAddress || ''),
    deviceType: toDeviceType(source.deviceType),
    status: toAssetStatus(source.status),
    location: String(source.location || ''),
    model: String(source.model || ''),
    manufacturer: String(source.manufacturer || ''),
    serialNumber: String(source.serialNumber || ''),
    organization: String(source.organization || ''),
    owner: String(source.owner || ''),
    remark: String(source.remark || ''),
    createdAt: String(source.createdAt || now),
    updatedAt: String(source.updatedAt || now),
  };
};

const buildGeneratedLocalAssetId = (deviceId, date) => {
  const compactDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
  const suffix = String(deviceId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `LOCAL-ASSET-${compactDate}-${suffix}`;
};

const defaultMonitorProfile = (device) => {
  if (device.deviceType === 'security') {
    return { checkType: 'tcp', checkTarget: device.ipAddress, checkPort: 443 };
  }
  if (device.deviceType === 'storage') {
    return { checkType: 'ping', checkTarget: device.ipAddress, checkPort: null };
  }
  return { checkType: 'ping+tcp', checkTarget: device.ipAddress, checkPort: 22 };
};

const checkFlags = (checkType) => ({
  checkPing: checkType.split('+').includes('ping') ? 1 : 0,
  checkTcp: checkType.split('+').includes('tcp') ? 1 : 0,
});

const resolveLocalDeviceId = (deviceId) => {
  const normalized = String(deviceId || '').trim();
  if (!normalized) throw new Error('设备 ID 不能为空。');
  if (normalized.startsWith('remote:')) {
    throw new Error('远端资产当前为只读，暂不支持直接编辑或删除。');
  }
  return normalized.startsWith('local:') ? normalized : `local:${normalized}`;
};

const filterMergedDevices = (items, query = {}) => {
  const entries = Object.entries(query || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (entries.length === 0) return items;

  return items.filter((item) => entries.every(([key, value]) => {
    const expected = String(value).trim().toLowerCase();
    if (key === 'name') return item.name.toLowerCase().includes(expected);
    if (key === 'ipAddr') return item.ipAddress.toLowerCase().includes(expected);
    if (key === 'assetType') return String(item.assetType) === expected;
    if (key === 'source') return item.source === expected;
    return true;
  }));
};

const MERGED_QUERY = `
  SELECT d.*, s.source_type, s.read_only,
         p.id AS monitor_profile_id, p.enabled AS monitor_enabled,
         p.check_ping, p.check_tcp, p.target_host, p.target_port,
         p.interval_seconds, p.timeout_ms, p.failure_threshold,
         p.notify_voice, p.notify_alert, p.comment,
         st.status AS monitor_status, st.online, st.last_check_at,
         st.last_success_at, st.last_failure_at, st.latency_ms,
         st.failure_count, st.last_error, st.message
  FROM devices d
  JOIN asset_sources s ON s.id = d.asset_source_id
  LEFT JOIN monitor_profiles p ON p.device_id = d.id
  LEFT JOIN monitor_current_status st ON st.monitor_profile_id = p.id
  WHERE d.deleted_at IS NULL
`;

const mapMergedDevice = (row, tags, mergedUpdatedAt) => {
  const source = sourceLabel(row.source_type);
  const remote = source === 'remote';
  const payload = parsePayload(row.source_payload_json);
  const monitorStatus = String(row.monitor_status || 'unknown');
  const assetStatus = toAssetStatus(row.asset_status);
  const deviceId = String(row.external_id);

  return {
    id: row.id,
    source,
    deviceId,
    remoteId: remote ? deviceId : null,
    localDeviceId: remote ? null : deviceId,
    editable: !remote,
    name: String(row.name || ''),
    assetId: String(row.asset_id || ''),
    assetType: toAssetType(row.device_type),
    deviceType: row.device_type,
    ipAddress: String(row.ip_address || ''),
    manageIpAddr: String(row.management_ip || ''),
    deviceBrand: String(row.manufacturer || ''),
    deviceModel: String(row.model || ''),
    productSn: String(row.serial_number || ''),
    customerId: remote ? String(payload.customerId || '') : '',
    customerName: String(row.organization || ''),
    providerName: remote ? String(payload.providerName || '') : '',
    jfName: String(row.location || ''),
    organization: String(row.organization || ''),
    owner: String(row.owner || ''),
    location: String(row.location || ''),
    remark: String(row.remark || ''),
    manageUser: String(row.owner || ''),
    manageUserPhone: remote ? String(payload.manageUserPhone || '') : '',
    operatorIds: remote ? String(payload.operatorIds || '') : '',
    operatorNames: remote ? String(payload.operatorNames || '') : '',
    openPort: remote ? String(payload.openPort || '') : '',
    useStatus: remote ? payload.useStatus ?? null : null,
    assetStatus,
    status: monitorStatus === 'unknown' ? assetStatus : monitorStatus,
    createdAt: remote ? null : String(row.created_at || ''),
    updatedAt: remote ? null : String(row.updated_at || ''),
    tags,
    monitorEnabled: Boolean(row.monitor_enabled),
    checkType: row.monitor_profile_id ? toCheckType(row) : '',
    checkTarget: String(row.target_host || ''),
    checkPort: row.target_port ?? null,
    intervalSec: row.interval_seconds ?? null,
    timeoutMs: row.timeout_ms ?? null,
    failThreshold: row.failure_threshold ?? null,
    notifyVoice: Boolean(row.notify_voice),
    notifyAlert: Boolean(row.notify_alert),
    comment: String(row.comment || ''),
    monitorStatus,
    online: Boolean(row.online),
    lastCheckAt: row.last_check_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastFailureAt: row.last_failure_at || null,
    latencyMs: typeof row.latency_ms === 'number' ? row.latency_ms : null,
    failCount: Number(row.failure_count || 0),
    lastError: String(row.last_error || ''),
    message: String(row.message || ''),
    mergedUpdatedAt,
  };
};

const mapLocalApiDevice = (row) => ({
  id: row.id,
  name: String(row.name || ''),
  assetId: String(row.asset_id || ''),
  ipAddress: String(row.ip_address || ''),
  deviceType: row.device_type,
  status: toAssetStatus(row.asset_status),
  location: String(row.location || ''),
  model: String(row.model || ''),
  manufacturer: String(row.manufacturer || ''),
  serialNumber: String(row.serial_number || ''),
  organization: String(row.organization || ''),
  owner: String(row.owner || ''),
  remark: String(row.remark || ''),
  createdAt: String(row.created_at || ''),
  updatedAt: String(row.updated_at || ''),
});

export const createSqliteAssetMonitorStore = (database, {
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
} = {}) => {
  const ensureLocalSource = (at) => database.run(
    `
      INSERT INTO asset_sources
        (id, name, source_type, read_only, config_json, created_at, updated_at)
      VALUES (?, 'Local devices', 'local', 0, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `,
    LOCAL_SOURCE_ID,
    at,
    at,
  );

  const upsertLocalDeviceRow = (device, at, insertOnly = false) => {
    const databaseId = `local:${device.id}`;
    const values = [
      databaseId,
      LOCAL_SOURCE_ID,
      device.id,
      device.name,
      device.assetId,
      device.deviceType,
      device.status,
      device.ipAddress,
      device.manufacturer,
      device.model,
      device.serialNumber,
      device.organization,
      device.owner,
      device.location,
      device.remark,
      JSON.stringify(device),
      device.createdAt,
      device.updatedAt,
      at,
    ];
    if (insertOnly) {
      database.run(
        `
          INSERT INTO devices
            (id, asset_source_id, external_id, name, asset_id, device_type, asset_status,
             ip_address, manufacturer, model, serial_number, organization, owner, location,
             remark, source_payload_json, created_at, updated_at, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ...values,
      );
      return;
    }

    database.run(
      `
        UPDATE devices
        SET name = ?, asset_id = ?, device_type = ?, asset_status = ?, ip_address = ?,
            manufacturer = ?, model = ?, serial_number = ?, organization = ?, owner = ?,
            location = ?, remark = ?, source_payload_json = ?, updated_at = ?, synced_at = ?
        WHERE id = ? AND asset_source_id = ?
      `,
      device.name,
      device.assetId,
      device.deviceType,
      device.status,
      device.ipAddress,
      device.manufacturer,
      device.model,
      device.serialNumber,
      device.organization,
      device.owner,
      device.location,
      device.remark,
      JSON.stringify(device),
      device.updatedAt,
      at,
      databaseId,
      LOCAL_SOURCE_ID,
    );
  };

  const upsertLocalMonitorDefaults = (device, at) => {
    const deviceId = `local:${device.id}`;
    const profile = defaultMonitorProfile(device);
    const { checkPing, checkTcp } = checkFlags(profile.checkType);
    const existing = database.get('SELECT id FROM monitor_profiles WHERE device_id = ?', deviceId);
    if (existing) {
      database.run(
        `
          UPDATE monitor_profiles
          SET enabled = 1, check_ping = ?, check_tcp = ?, target_host = ?, target_port = ?,
              updated_at = ?
          WHERE device_id = ?
        `,
        checkPing,
        checkTcp,
        profile.checkTarget,
        profile.checkPort,
        at,
        deviceId,
      );
    } else {
      database.run(
        `
          INSERT INTO monitor_profiles
            (id, device_id, enabled, check_ping, check_tcp, target_host, target_port,
             interval_seconds, timeout_ms, failure_threshold, notify_voice, notify_alert,
             comment, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, 5, 3000, 3, 0, 1, ?, ?, ?)
        `,
        `monitor:${deviceId}`,
        deviceId,
        checkPing,
        checkTcp,
        profile.checkTarget,
        profile.checkPort,
        '本地设备默认自动启用在线检测。',
        at,
        at,
      );
      database.run(
        'INSERT OR IGNORE INTO device_tags (device_id, tag, created_at) VALUES (?, ?, ?)',
        deviceId,
        '用户添加',
        at,
      );
    }

    const profileId = database.get(
      'SELECT id FROM monitor_profiles WHERE device_id = ?',
      deviceId,
    ).id;
    database.run(
      `
        INSERT OR IGNORE INTO monitor_current_status
          (monitor_profile_id, status, online, failure_count, last_error, message)
        VALUES (?, 'unknown', 0, 0, '', '等待首次检测')
      `,
      profileId,
    );
  };

  const readLocalDeviceRow = (databaseId) => database.get(
    `
      SELECT d.*
      FROM devices d
      JOIN asset_sources s ON s.id = d.asset_source_id
      WHERE d.id = ? AND s.source_type = 'local' AND d.deleted_at IS NULL
    `,
    databaseId,
  );

  const listMergedDevices = async (query = {}) => {
    const generatedAt = now();
    const tagsByDevice = new Map();
    for (const tag of database.all('SELECT device_id, tag FROM device_tags ORDER BY tag')) {
      const tags = tagsByDevice.get(tag.device_id) || [];
      tags.push(tag.tag);
      tagsByDevice.set(tag.device_id, tags);
    }
    const allItems = database.all(MERGED_QUERY)
      .map((row) => mapMergedDevice(row, tagsByDevice.get(row.id) || [], generatedAt))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    const items = filterMergedDevices(allItems, query);
    return {
      generatedAt,
      total: allItems.length,
      filteredTotal: items.length,
      items,
    };
  };

  const readDeviceStatus = async () => database.all(
    `
      SELECT s.source_type, d.external_id, p.check_ping, p.check_tcp,
             st.status, st.online, st.last_check_at, st.last_success_at,
             st.last_failure_at, st.latency_ms, st.failure_count,
             st.last_error, st.message
      FROM monitor_current_status st
      JOIN monitor_profiles p ON p.id = st.monitor_profile_id
      JOIN devices d ON d.id = p.device_id
      JOIN asset_sources s ON s.id = d.asset_source_id
      WHERE d.deleted_at IS NULL
      ORDER BY d.id
    `,
  ).map((row) => ({
    source: sourceLabel(row.source_type),
    deviceId: String(row.external_id),
    status: String(row.status || 'unknown'),
    online: Boolean(row.online),
    checkType: toCheckType(row),
    lastCheckAt: row.last_check_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastFailureAt: row.last_failure_at || null,
    latencyMs: typeof row.latency_ms === 'number' ? row.latency_ms : null,
    failCount: Number(row.failure_count || 0),
    lastError: String(row.last_error || ''),
    message: String(row.message || ''),
  }));

  const listMonitorTargets = async () => database.all(
    `
      SELECT s.source_type, d.external_id, p.check_ping, p.check_tcp,
             COALESCE(
               CASE WHEN p.check_tcp = 1 THEN NULLIF(cp.host, '') END,
               p.target_host
             ) AS effective_target_host,
             CASE
               WHEN p.check_tcp = 1 THEN COALESCE(cp.port, p.target_port)
               ELSE p.target_port
             END AS effective_target_port,
             p.target_port AS configured_target_port,
             cp.id AS connection_profile_id,
             p.timeout_ms, p.failure_threshold
      FROM monitor_profiles p
      JOIN devices d ON d.id = p.device_id
      JOIN asset_sources s ON s.id = d.asset_source_id
      LEFT JOIN connection_profiles cp ON cp.id = (
        SELECT selected_cp.id
        FROM connection_profiles selected_cp
        WHERE selected_cp.device_id = d.id
          AND selected_cp.enabled = 1
          AND selected_cp.deleted_at IS NULL
        ORDER BY selected_cp.is_default DESC,
                 selected_cp.updated_at DESC,
                 selected_cp.created_at DESC
        LIMIT 1
      )
      WHERE p.enabled = 1 AND d.deleted_at IS NULL AND p.target_host <> ''
        AND (p.check_ping = 1 OR p.check_tcp = 1)
    `,
  ).map((row) => ({
    source: sourceLabel(row.source_type),
    deviceId: String(row.external_id),
    checkType: toCheckType(row),
    checkTarget: String(row.effective_target_host),
    checkPort: row.effective_target_port ?? null,
    fallbackTcpPorts: !row.connection_profile_id && row.configured_target_port === 22 ? [23] : [],
    timeoutMs: Number(row.timeout_ms || 3000),
    failThreshold: Number(row.failure_threshold || 3),
  }));

  const writeDeviceStatus = async (items) => database.transaction(() => {
    for (const item of items) {
      const sourceType = item.source === 'remote' ? REMOTE_SOURCE_TYPE : LOCAL_SOURCE_TYPE;
      const profile = database.get(
        `
          SELECT p.id
          FROM monitor_profiles p
          JOIN devices d ON d.id = p.device_id
          JOIN asset_sources s ON s.id = d.asset_source_id
          WHERE s.source_type = ? AND d.external_id = ?
        `,
        sourceType,
        String(item.deviceId || ''),
      );
      if (!profile) continue;
      database.run(
        `
          INSERT INTO monitor_current_status
            (monitor_profile_id, status, online, last_check_at, last_success_at,
             last_failure_at, latency_ms, failure_count, last_error, message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(monitor_profile_id) DO UPDATE SET
            status = excluded.status, online = excluded.online,
            last_check_at = excluded.last_check_at, last_success_at = excluded.last_success_at,
            last_failure_at = excluded.last_failure_at, latency_ms = excluded.latency_ms,
            failure_count = excluded.failure_count, last_error = excluded.last_error,
            message = excluded.message
        `,
        profile.id,
        toAssetStatus(item.status),
        item.online ? 1 : 0,
        item.lastCheckAt || null,
        item.lastSuccessAt || null,
        item.lastFailureAt || null,
        item.latencyMs ?? null,
        Number(item.failCount || 0),
        String(item.lastError || ''),
        String(item.message || ''),
      );
    }
  });

  const syncLocalDevicesMonitorDefaults = async () => database.transaction(() => {
    const devices = database.all(
      "SELECT * FROM devices WHERE asset_source_id = ? AND deleted_at IS NULL",
      LOCAL_SOURCE_ID,
    );
    const at = now();
    for (const row of devices) {
      upsertLocalMonitorDefaults({
        id: row.external_id,
        ipAddress: row.ip_address,
        deviceType: row.device_type,
      }, at);
    }
  });

  const createLocalManagedAssetDevice = async (payload = {}) => {
    const at = now();
    const externalId = String(payload.id || createId());
    const nextDevice = normalizeLocalAssetDevice({
      ...payload,
      id: externalId,
      assetId: payload.assetId || buildGeneratedLocalAssetId(externalId, new Date(at)),
      createdAt: payload.createdAt || at,
      updatedAt: at,
    }, at);
    database.transaction(() => {
      ensureLocalSource(at);
      upsertLocalDeviceRow(nextDevice, at, true);
      upsertLocalMonitorDefaults(nextDevice, at);
    });
    return mapLocalApiDevice(readLocalDeviceRow(`local:${externalId}`));
  };

  const updateLocalManagedAssetDevice = async (deviceId, payload = {}) => {
    const databaseId = resolveLocalDeviceId(deviceId);
    const existing = readLocalDeviceRow(databaseId);
    if (!existing) throw new Error(`设备未找到：${deviceId}`);
    const at = now();
    const nextDevice = normalizeLocalAssetDevice({
      name: existing.name,
      assetId: existing.asset_id,
      ipAddress: existing.ip_address,
      deviceType: existing.device_type,
      status: existing.asset_status,
      location: existing.location,
      model: existing.model,
      manufacturer: existing.manufacturer,
      serialNumber: existing.serial_number,
      organization: existing.organization,
      owner: existing.owner,
      remark: existing.remark,
      createdAt: existing.created_at,
      ...payload,
      id: existing.external_id,
      assetId: payload.assetId || existing.asset_id || buildGeneratedLocalAssetId(existing.external_id, new Date(at)),
      createdAt: existing.created_at,
      updatedAt: at,
    }, at);
    database.transaction(() => {
      upsertLocalDeviceRow(nextDevice, at);
      upsertLocalMonitorDefaults(nextDevice, at);
    });
    return mapLocalApiDevice(readLocalDeviceRow(databaseId));
  };

  const deleteLocalManagedAssetDevice = async (deviceId) => {
    const databaseId = resolveLocalDeviceId(deviceId);
    if (!readLocalDeviceRow(databaseId)) throw new Error(`设备未找到：${deviceId}`);
    const at = now();
    database.transaction(() => {
      database.run(
        'UPDATE monitor_profiles SET enabled = 0, updated_at = ? WHERE device_id = ?',
        at,
        databaseId,
      );
      database.run(
        'UPDATE devices SET deleted_at = ?, updated_at = ? WHERE id = ? AND asset_source_id = ?',
        at,
        at,
        databaseId,
        LOCAL_SOURCE_ID,
      );
    });
    return { ok: true, deviceId };
  };

  return {
    listMergedDevices,
    rebuildMergedDevices: listMergedDevices,
    readDeviceStatus,
    listMonitorTargets,
    writeDeviceStatus,
    syncLocalDevicesMonitorDefaults,
    createLocalManagedAssetDevice,
    updateLocalManagedAssetDevice,
    deleteLocalManagedAssetDevice,
  };
};
