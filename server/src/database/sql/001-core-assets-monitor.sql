CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE data_import_runs (
  id TEXT PRIMARY KEY,
  import_kind TEXT NOT NULL CHECK (import_kind IN ('json_assets_initial')),
  source_backup_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  imported_devices INTEGER NOT NULL DEFAULT 0,
  imported_monitor_profiles INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_message TEXT
);

CREATE TABLE data_import_issues (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES data_import_runs(id) ON DELETE CASCADE,
  source_file TEXT NOT NULL,
  source_record_key TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  issue_summary TEXT NOT NULL,
  source_record_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE asset_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('local', 'remote_api')),
  read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  asset_source_id TEXT NOT NULL REFERENCES asset_sources(id),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_id TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL CHECK (device_type IN ('server', 'storage', 'security', 'network')),
  asset_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (asset_status IN ('healthy', 'attention', 'critical', 'unknown')),
  ip_address TEXT NOT NULL DEFAULT '',
  management_ip TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  source_payload_json TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (asset_source_id, external_id)
);

CREATE TABLE device_tags (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, tag)
);

CREATE INDEX idx_devices_type_status ON devices(device_type, asset_status);
CREATE INDEX idx_devices_name ON devices(name);
CREATE INDEX idx_devices_ip ON devices(ip_address);

CREATE TABLE monitor_profiles (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  check_ping INTEGER NOT NULL DEFAULT 0 CHECK (check_ping IN (0, 1)),
  check_tcp INTEGER NOT NULL DEFAULT 0 CHECK (check_tcp IN (0, 1)),
  target_host TEXT NOT NULL DEFAULT '',
  target_port INTEGER CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
  interval_seconds INTEGER NOT NULL DEFAULT 5 CHECK (interval_seconds >= 1),
  timeout_ms INTEGER NOT NULL DEFAULT 3000 CHECK (timeout_ms >= 100),
  failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK (failure_threshold >= 1),
  notify_voice INTEGER NOT NULL DEFAULT 0 CHECK (notify_voice IN (0, 1)),
  notify_alert INTEGER NOT NULL DEFAULT 1 CHECK (notify_alert IN (0, 1)),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (check_ping = 1 OR check_tcp = 1 OR enabled = 0)
);

CREATE TABLE monitor_current_status (
  monitor_profile_id TEXT PRIMARY KEY REFERENCES monitor_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('healthy', 'attention', 'critical', 'unknown')),
  online INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0, 1)),
  last_check_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  latency_ms REAL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE monitor_results (
  id TEXT PRIMARY KEY,
  monitor_profile_id TEXT NOT NULL REFERENCES monitor_profiles(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'attention', 'critical', 'unknown')),
  online INTEGER NOT NULL CHECK (online IN (0, 1)),
  ping_ok INTEGER CHECK (ping_ok IS NULL OR ping_ok IN (0, 1)),
  tcp_ok INTEGER CHECK (tcp_ok IS NULL OR tcp_ok IN (0, 1)),
  latency_ms REAL,
  error_message TEXT NOT NULL DEFAULT '',
  result_message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_monitor_results_profile_time
  ON monitor_results(monitor_profile_id, checked_at DESC);
