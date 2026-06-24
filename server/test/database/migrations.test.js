import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

const withDatabase = (work) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-db-migrations-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  try {
    return work(database);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
};

test('migrations create the complete remote access foundation schema once', () => {
  withDatabase((database) => {
    applyMigrations(database, { now: () => '2026-05-26T00:00:00.000Z' });

    assert.deepEqual(
      database.all('SELECT version, name FROM schema_migrations ORDER BY version'),
      [
        { version: 1, name: 'core-assets-monitor' },
        { version: 2, name: 'remote-access-audit' },
        { version: 3, name: 'app-auth-user-data' },
      ],
    );
    assert.deepEqual(
      database.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name),
      [
        'app_settings',
        'asset_sources',
        'audit_events',
        'connection_profiles',
        'conversation_messages',
        'conversations',
        'credential_refs',
        'data_import_issues',
        'data_import_runs',
        'device_tags',
        'devices',
        'monitor_current_status',
        'monitor_profiles',
        'monitor_results',
        'remote_sessions',
        'schema_migrations',
        'sessions',
        'sftp_operations',
        'sftp_transfers',
        'ssh_host_keys',
        'terminal_transcript_chunks',
        'user_settings',
        'users',
      ],
    );

    applyMigrations(database, { now: () => '2026-05-26T00:01:00.000Z' });
    assert.equal(database.get('SELECT COUNT(*) AS count FROM schema_migrations').count, 3);
  });
});

test('migrations retain domain and secret-reference constraints', () => {
  withDatabase((database) => {
    applyMigrations(database);

    assert.throws(
      () => database.run(`
        INSERT INTO asset_sources (id, name, source_type, read_only, created_at, updated_at)
        VALUES ('bad', 'bad', 'invalid', 0, 't', 't')
      `),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => database.run(`
        INSERT INTO credential_refs
          (id, credential_type, vault_provider, vault_service, vault_account, label, created_at, updated_at)
        VALUES ('c', 'raw_secret', 'p', 's', 'a', 'l', 't', 't')
      `),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => database.run(`
        INSERT INTO conversations
          (id, user_id, title, kind, model_id, created_at, updated_at)
        VALUES ('bad-system', 'missing-user', 'bad', 'system', '', 1, 1)
      `),
      /CHECK constraint failed/,
    );
  });
});
