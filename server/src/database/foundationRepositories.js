export const createFoundationRepositories = (database) => ({
  isInitialImportComplete: () => database.get(
    "SELECT setting_value_json FROM app_settings WHERE setting_key = 'assets.initial_import.completed'",
  )?.setting_value_json === 'true',

  markInitialImportComplete: (at) => database.run(
    `
      INSERT INTO app_settings (setting_key, setting_value_json, updated_at)
      VALUES ('assets.initial_import.completed', 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value_json = excluded.setting_value_json,
        updated_at = excluded.updated_at
    `,
    at,
  ),

  startImportRun: ({ id, sourceBackupPath, startedAt }) => database.run(
    `
      INSERT INTO data_import_runs
        (id, import_kind, source_backup_path, status, started_at)
      VALUES (?, 'json_assets_initial', ?, 'started', ?)
    `,
    id,
    sourceBackupPath,
    startedAt,
  ),

  completeImportRun: ({
    id,
    status,
    importedDevices,
    importedMonitorProfiles,
    issueCount,
    endedAt,
    errorMessage = null,
  }) => database.run(
    `
      UPDATE data_import_runs
      SET status = ?,
          imported_devices = ?,
          imported_monitor_profiles = ?,
          issue_count = ?,
          ended_at = ?,
          error_message = ?
      WHERE id = ?
    `,
    status,
    importedDevices,
    importedMonitorProfiles,
    issueCount,
    endedAt,
    errorMessage,
    id,
  ),

  upsertSource: ({
    id,
    name,
    sourceType,
    readOnly,
    configJson = null,
    createdAt,
    updatedAt,
  }) => database.run(
    `
      INSERT INTO asset_sources
        (id, name, source_type, read_only, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        source_type = excluded.source_type,
        read_only = excluded.read_only,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `,
    id,
    name,
    sourceType,
    readOnly,
    configJson,
    createdAt,
    updatedAt,
  ),

  upsertDevice: ({
    id,
    assetSourceId,
    externalId,
    name,
    assetId,
    deviceType,
    assetStatus,
    ipAddress,
    managementIp,
    manufacturer,
    model,
    serialNumber,
    organization,
    owner,
    location,
    remark,
    sourcePayloadJson,
    createdAt,
    updatedAt,
    syncedAt,
  }) => database.run(
    `
      INSERT INTO devices
        (id, asset_source_id, external_id, name, asset_id, device_type, asset_status,
         ip_address, management_ip, manufacturer, model, serial_number, organization,
         owner, location, remark, source_payload_json, created_at, updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_source_id, external_id) DO UPDATE SET
        name = excluded.name,
        asset_id = excluded.asset_id,
        device_type = excluded.device_type,
        asset_status = excluded.asset_status,
        ip_address = excluded.ip_address,
        management_ip = excluded.management_ip,
        manufacturer = excluded.manufacturer,
        model = excluded.model,
        serial_number = excluded.serial_number,
        organization = excluded.organization,
        owner = excluded.owner,
        location = excluded.location,
        remark = excluded.remark,
        source_payload_json = excluded.source_payload_json,
        updated_at = excluded.updated_at,
        synced_at = excluded.synced_at
    `,
    id,
    assetSourceId,
    externalId,
    name,
    assetId,
    deviceType,
    assetStatus,
    ipAddress,
    managementIp,
    manufacturer,
    model,
    serialNumber,
    organization,
    owner,
    location,
    remark,
    sourcePayloadJson,
    createdAt,
    updatedAt,
    syncedAt,
  ),

  replaceTags: (deviceId, tags, at) => {
    database.run('DELETE FROM device_tags WHERE device_id = ?', deviceId);
    for (const tag of new Set(tags.map((value) => String(value).trim()).filter(Boolean))) {
      database.run(
        'INSERT INTO device_tags (device_id, tag, created_at) VALUES (?, ?, ?)',
        deviceId,
        tag,
        at,
      );
    }
  },

  upsertMonitorProfile: ({
    id,
    deviceId,
    enabled,
    checkPing,
    checkTcp,
    targetHost,
    targetPort,
    intervalSeconds,
    timeoutMs,
    failureThreshold,
    notifyVoice,
    notifyAlert,
    comment,
    createdAt,
    updatedAt,
  }) => database.run(
    `
      INSERT INTO monitor_profiles
        (id, device_id, enabled, check_ping, check_tcp, target_host, target_port,
         interval_seconds, timeout_ms, failure_threshold, notify_voice, notify_alert,
         comment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        enabled = excluded.enabled,
        check_ping = excluded.check_ping,
        check_tcp = excluded.check_tcp,
        target_host = excluded.target_host,
        target_port = excluded.target_port,
        interval_seconds = excluded.interval_seconds,
        timeout_ms = excluded.timeout_ms,
        failure_threshold = excluded.failure_threshold,
        notify_voice = excluded.notify_voice,
        notify_alert = excluded.notify_alert,
        comment = excluded.comment,
        updated_at = excluded.updated_at
    `,
    id,
    deviceId,
    enabled,
    checkPing,
    checkTcp,
    targetHost,
    targetPort,
    intervalSeconds,
    timeoutMs,
    failureThreshold,
    notifyVoice,
    notifyAlert,
    comment,
    createdAt,
    updatedAt,
  ),

  upsertMonitorStatus: ({
    monitorProfileId,
    status,
    online,
    lastCheckAt,
    lastSuccessAt,
    lastFailureAt,
    latencyMs,
    failureCount,
    lastError,
    message,
  }) => database.run(
    `
      INSERT INTO monitor_current_status
        (monitor_profile_id, status, online, last_check_at, last_success_at,
         last_failure_at, latency_ms, failure_count, last_error, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(monitor_profile_id) DO UPDATE SET
        status = excluded.status,
        online = excluded.online,
        last_check_at = excluded.last_check_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        latency_ms = excluded.latency_ms,
        failure_count = excluded.failure_count,
        last_error = excluded.last_error,
        message = excluded.message
    `,
    monitorProfileId,
    status,
    online,
    lastCheckAt,
    lastSuccessAt,
    lastFailureAt,
    latencyMs,
    failureCount,
    lastError,
    message,
  ),

  recordIssue: ({
    id,
    importRunId,
    sourceFile,
    sourceRecordKey,
    issueCode,
    issueSummary,
    sourceRecordJson,
    createdAt,
  }) => database.run(
    `
      INSERT INTO data_import_issues
        (id, import_run_id, source_file, source_record_key, issue_code,
         issue_summary, source_record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    id,
    importRunId,
    sourceFile,
    sourceRecordKey,
    issueCode,
    issueSummary,
    sourceRecordJson,
    createdAt,
  ),
});
