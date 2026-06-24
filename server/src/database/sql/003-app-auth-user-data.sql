CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  digest TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  remote_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_user_expiry ON sessions(user_id, expires_at);

CREATE TABLE user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, setting_key)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('normal', 'system')),
  model_id TEXT NOT NULL DEFAULT '',
  system_channel TEXT,
  last_read_at REAL,
  metadata_json TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  CHECK (
    (kind = 'system' AND user_id IS NULL)
    OR (kind = 'normal' AND user_id IS NOT NULL)
  )
);

CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

CREATE TABLE conversation_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp REAL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id),
  UNIQUE (conversation_id, position)
);

CREATE INDEX idx_conversation_messages_position
  ON conversation_messages(conversation_id, position);
