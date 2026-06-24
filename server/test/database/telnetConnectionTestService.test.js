import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createTelnetConnectionTestService } from '../../src/remote/telnetConnectionTestService.js';

const FIXED_NOW = '2026-06-02T08:00:00.000Z';
const TELNET_PROFILE_ID = 'telnet-profile-one';
const PASSWORD_MARKER = 'sensitive-telnet-test-password-marker';

class FakeSecretStore {
  getCalls = [];
  secret = PASSWORD_MARKER;

  async getSecret(account) {
    this.getCalls.push(account);
    return this.secret;
  }
}

class FakeTelnetTransport {
  calls = [];
  error = null;

  async testConnection(profile, credentials) {
    this.calls.push({ profile, credentials });
    if (this.error) throw this.error;
    return { authenticated: Boolean(credentials?.password) };
  }
}

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-telnet-test-service-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  applyMigrations(database, { now: () => FIXED_NOW });
  database.run(
    `
      INSERT INTO asset_sources (id, name, source_type, read_only, created_at, updated_at)
      VALUES ('local-default', 'Local', 'local', 0, ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );
  database.run(
    `
      INSERT INTO devices
        (id, asset_source_id, external_id, name, asset_id, device_type, asset_status,
         ip_address, created_at, updated_at)
      VALUES ('local:one', 'local-default', 'one', 'Local One', 'L-1', 'server', 'healthy',
              '10.0.0.1', ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );
  database.run(
    `
      INSERT INTO credential_refs
        (id, credential_type, vault_provider, vault_service, vault_account, label,
         created_at, updated_at)
      VALUES ('credential-one', 'password', 'fake-vault', 'opsdog.remote.test',
              'profile:telnet-profile-one:password', 'TELNET password', ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );
  database.run(
    `
      INSERT INTO connection_profiles
        (id, device_id, name, protocol, host, port, username, auth_method,
         password_credential_ref_id, strict_host_key_checking, sftp_enabled,
         connect_timeout_ms, keepalive_interval_ms, created_at, updated_at)
      VALUES ('telnet-profile-one', 'local:one', 'Legacy TELNET', 'telnet', 'host.test', 23,
              'operator', 'password', 'credential-one', 0, 0, 1000, 0, ?, ?),
             ('interactive-telnet-profile', 'local:one', 'Interactive TELNET', 'telnet', 'host.test', 23,
              '', 'none', NULL, 0, 0, 1000, 0, ?, ?),
             ('ssh-profile-one', 'local:one', 'Primary SSH', 'ssh', 'host.test', 22,
              'operator', 'password', 'credential-one', 1, 1, 1000, 0, ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
  );
  let id = 0;
  const secretStore = new FakeSecretStore();
  const transport = new FakeTelnetTransport();
  const service = createTelnetConnectionTestService(database, secretStore, transport, {
    now: () => FIXED_NOW,
    createId: () => `telnet-test-id-${++id}`,
  });
  return { root, database, secretStore, transport, service };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

test('TELNET connection test reads the vault after validation and records metadata only', async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.service.testConnection(TELNET_PROFILE_ID);

    assert.deepEqual(result, {
      status: 'connected',
      protocol: 'telnet',
      profileId: TELNET_PROFILE_ID,
      host: 'host.test',
      port: 23,
      authenticated: true,
      sftpAvailable: false,
      checkedAt: FIXED_NOW,
    });
    assert.deepEqual(fixture.secretStore.getCalls, ['profile:telnet-profile-one:password']);
    assert.equal(fixture.transport.calls[0].credentials.password, PASSWORD_MARKER);
    const audit = fixture.database.get('SELECT event_type, outcome, detail_json FROM audit_events');
    assert.equal(audit.event_type, 'telnet.connection.tested');
    assert.equal(audit.outcome, 'succeeded');
    assert.equal(JSON.stringify({
      result,
      audit,
      sessions: fixture.database.all('SELECT * FROM remote_sessions'),
    }).includes(PASSWORD_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET connection test supports interactive profiles without reading the vault', async () => {
  const fixture = createFixture();
  try {
    fixture.transport.calls = [];
    const result = await fixture.service.testConnection('interactive-telnet-profile');

    assert.deepEqual(result, {
      status: 'connected',
      protocol: 'telnet',
      profileId: 'interactive-telnet-profile',
      host: 'host.test',
      port: 23,
      authenticated: false,
      sftpAvailable: false,
      checkedAt: FIXED_NOW,
    });
    assert.deepEqual(fixture.secretStore.getCalls, []);
    assert.equal(fixture.transport.calls.length, 1);
    assert.equal(fixture.transport.calls[0].credentials, null);
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET connection test fails closed for unsupported profiles and missing credentials', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      fixture.service.testConnection('ssh-profile-one'),
      (error) => error.code === 'TELNET_UNSUPPORTED',
    );
    fixture.database.run('UPDATE connection_profiles SET enabled = 0 WHERE id = ?', TELNET_PROFILE_ID);
    await assert.rejects(
      fixture.service.testConnection(TELNET_PROFILE_ID),
      (error) => error.code === 'TELNET_CONNECTION_DISABLED',
    );
    fixture.database.run('UPDATE connection_profiles SET enabled = 1 WHERE id = ?', TELNET_PROFILE_ID);
    fixture.secretStore.secret = null;
    await assert.rejects(
      fixture.service.testConnection(TELNET_PROFILE_ID),
      (error) => error.code === 'TELNET_CREDENTIAL_UNAVAILABLE',
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET connection test records only stable failure metadata', async () => {
  const fixture = createFixture();
  try {
    const error = new Error(`raw transport detail ${PASSWORD_MARKER}`);
    error.code = 'TELNET_LOGIN_FAILED';
    fixture.transport.error = error;

    await assert.rejects(
      fixture.service.testConnection(TELNET_PROFILE_ID),
      (caught) => caught.code === 'TELNET_LOGIN_FAILED',
    );
    const audit = fixture.database.get('SELECT event_type, outcome, detail_json FROM audit_events');
    assert.equal(audit.event_type, 'telnet.connection.tested');
    assert.equal(audit.outcome, 'failed');
    assert.deepEqual(JSON.parse(audit.detail_json).errorCode, 'TELNET_LOGIN_FAILED');
    assert.equal(audit.detail_json.includes(PASSWORD_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});
