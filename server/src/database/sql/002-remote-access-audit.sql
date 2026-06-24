CREATE TABLE credential_refs (
  id TEXT PRIMARY KEY,
  credential_type TEXT NOT NULL
    CHECK (credential_type IN ('password', 'private_key_passphrase')),
  vault_provider TEXT NOT NULL,
  vault_service TEXT NOT NULL,
  vault_account TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_fingerprint TEXT,
  last_verified_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (vault_provider, vault_service, vault_account)
);

CREATE TABLE connection_profiles (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('ssh', 'telnet')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL DEFAULT '',
  auth_method TEXT NOT NULL DEFAULT 'password'
    CHECK (auth_method IN ('password', 'private_key', 'agent', 'none')),
  password_credential_ref_id TEXT REFERENCES credential_refs(id),
  private_key_path TEXT,
  passphrase_credential_ref_id TEXT REFERENCES credential_refs(id),
  strict_host_key_checking INTEGER NOT NULL DEFAULT 1
    CHECK (strict_host_key_checking IN (0, 1)),
  sftp_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sftp_enabled IN (0, 1)),
  encoding TEXT NOT NULL DEFAULT 'utf-8',
  connect_timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (connect_timeout_ms >= 100),
  keepalive_interval_ms INTEGER NOT NULL DEFAULT 15000 CHECK (keepalive_interval_ms >= 0),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (auth_method = 'password' AND password_credential_ref_id IS NOT NULL)
    OR auth_method <> 'password'
  ),
  CHECK (
    protocol = 'ssh'
    OR (sftp_enabled = 0 AND strict_host_key_checking = 0)
  )
);

CREATE UNIQUE INDEX idx_connection_profiles_default_device
  ON connection_profiles(device_id)
  WHERE is_default = 1 AND deleted_at IS NULL;

CREATE INDEX idx_connection_profiles_device
  ON connection_profiles(device_id, protocol, enabled);

CREATE TABLE ssh_host_keys (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  key_type TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  public_key_base64 TEXT NOT NULL,
  trust_status TEXT NOT NULL
    CHECK (trust_status IN ('trusted', 'revoked', 'replaced')),
  first_seen_at TEXT NOT NULL,
  trusted_at TEXT,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_id TEXT REFERENCES ssh_host_keys(id),
  UNIQUE (host, port, key_type, fingerprint_sha256)
);

CREATE UNIQUE INDEX idx_ssh_host_keys_active_trust
  ON ssh_host_keys(host, port, key_type)
  WHERE trust_status = 'trusted';

CREATE TABLE remote_sessions (
  id TEXT PRIMARY KEY,
  connection_profile_id TEXT NOT NULL REFERENCES connection_profiles(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  session_kind TEXT NOT NULL CHECK (session_kind IN ('terminal', 'sftp')),
  protocol TEXT NOT NULL CHECK (protocol IN ('ssh', 'telnet')),
  actor_type TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_type IN ('human', 'automation', 'ai')),
  state TEXT NOT NULL
    CHECK (state IN ('opening', 'active', 'closing', 'closed', 'failed')),
  host_key_id TEXT REFERENCES ssh_host_keys(id),
  transcript_policy TEXT NOT NULL DEFAULT 'metadata_only'
    CHECK (transcript_policy IN ('metadata_only', 'output_only')),
  remote_address TEXT NOT NULL,
  negotiated_algorithms_json TEXT,
  started_at TEXT NOT NULL,
  authenticated_at TEXT,
  ended_at TEXT,
  ended_reason TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE terminal_transcript_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  direction TEXT NOT NULL DEFAULT 'output' CHECK (direction = 'output'),
  content_text TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  redaction_state TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (redaction_state IN ('unreviewed', 'redacted', 'not_required')),
  UNIQUE (session_id, sequence_number)
);

CREATE INDEX idx_remote_sessions_device_time
  ON remote_sessions(device_id, started_at DESC);

CREATE INDEX idx_transcript_chunks_session_seq
  ON terminal_transcript_chunks(session_id, sequence_number);

CREATE TABLE sftp_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES remote_sessions(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('list', 'stat', 'mkdir', 'rename', 'delete')),
  remote_path TEXT NOT NULL,
  destination_path TEXT,
  confirmation_required INTEGER NOT NULL DEFAULT 0
    CHECK (confirmation_required IN (0, 1)),
  confirmation_received INTEGER NOT NULL DEFAULT 0
    CHECK (confirmation_received IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'cancelled')),
  error_message TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE sftp_transfers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES remote_sessions(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  remote_path TEXT NOT NULL,
  display_file_name TEXT NOT NULL,
  size_bytes INTEGER,
  transferred_bytes INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  overwrite_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (overwrite_confirmed IN (0, 1)),
  status TEXT NOT NULL
    CHECK (status IN ('started', 'succeeded', 'failed', 'cancelled')),
  error_message TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX idx_sftp_operations_device_time
  ON sftp_operations(device_id, started_at DESC);

CREATE INDEX idx_sftp_transfers_device_time
  ON sftp_transfers(device_id, started_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_type IN ('human', 'system', 'automation', 'ai')),
  actor_label TEXT NOT NULL DEFAULT 'local-user',
  device_id TEXT REFERENCES devices(id),
  connection_profile_id TEXT REFERENCES connection_profiles(id),
  session_id TEXT REFERENCES remote_sessions(id),
  risk_level TEXT NOT NULL DEFAULT 'read-only'
    CHECK (risk_level IN ('read-only', 'state-change', 'destructive')),
  outcome TEXT NOT NULL CHECK (outcome IN ('attempted', 'succeeded', 'failed', 'denied')),
  summary TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_events_time ON audit_events(created_at DESC);
CREATE INDEX idx_audit_events_device_time ON audit_events(device_id, created_at DESC);
CREATE INDEX idx_audit_events_session_time ON audit_events(session_id, created_at ASC);
