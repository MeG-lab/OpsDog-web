import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createHostKeyChallengeStore } from '../../src/remote/hostKeyChallengeStore.js';
import { createHostKeyService } from '../../src/remote/hostKeyService.js';
import { createSshConnectionTestService } from '../../src/remote/sshConnectionTestService.js';

const FIXED_NOW = '2026-05-27T04:00:00.000Z';
const PASSWORD_MARKER = 'disposable-connection-test-password';
const PROFILE_ID = 'profile-one';
const FIRST_KEY = {
  host: 'host.test',
  port: 22,
  keyType: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:first-fingerprint',
  publicKeyBase64: Buffer.from('first-orchestration-key').toString('base64'),
};
const CHANGED_KEY = {
  ...FIRST_KEY,
  fingerprintSha256: 'SHA256:changed-fingerprint',
  publicKeyBase64: Buffer.from('changed-orchestration-key').toString('base64'),
};

class FakeSecretStore {
  getCalls = [];

  async getSecret(account) {
    this.getCalls.push(account);
    return PASSWORD_MARKER;
  }
}

class FakeTransport {
  observedKey = FIRST_KEY;
  probeCalls = [];
  testCalls = [];

  async probeHostKey(profile) {
    this.probeCalls.push(profile);
    return this.observedKey;
  }

  async testPasswordConnection(profile, password, hostKey) {
    this.testCalls.push({ profile, password, hostKey });
    return { sftpAvailable: true };
  }
}

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-ssh-test-service-'));
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
              'profile:profile-one:password', 'Primary SSH password', ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );
  database.run(
    `
      INSERT INTO connection_profiles
        (id, device_id, name, protocol, host, port, username, auth_method,
         password_credential_ref_id, connect_timeout_ms, keepalive_interval_ms,
         created_at, updated_at)
      VALUES ('profile-one', 'local:one', 'Primary SSH', 'ssh', 'host.test', 22,
              'operator', 'password', 'credential-one', 1000, 0, ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );

  let nextId = 0;
  let nextChallenge = 0;
  const secretStore = new FakeSecretStore();
  const transport = new FakeTransport();
  const hostKeyService = createHostKeyService(
    database,
    createHostKeyChallengeStore({
      now: () => Date.parse(FIXED_NOW),
      createToken: () => `challenge-${++nextChallenge}`,
    }),
    {
      now: () => FIXED_NOW,
      createId: () => `p4-${++nextId}`,
    },
  );
  const service = createSshConnectionTestService(database, secretStore, transport, hostKeyService, {
    now: () => FIXED_NOW,
    createId: () => `p4-${++nextId}`,
  });
  return { root, database, secretStore, transport, service };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

test('unknown key is confirmed before a password is read and trusted test output is safe', async () => {
  const fixture = createFixture();
  try {
    const probe = await fixture.service.probeHostKey(PROFILE_ID);
    assert.equal(probe.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
    assert.equal(fixture.secretStore.getCalls.length, 0);
    assert.equal(JSON.stringify(probe).includes(FIRST_KEY.publicKeyBase64), false);

    const trusted = fixture.service.trustHostKey(PROFILE_ID, { challengeToken: probe.challengeToken });
    assert.equal(trusted.code, 'HOST_KEY_TRUSTED');
    assert.equal(fixture.service.listHostKeys(PROFILE_ID).length, 1);

    const tested = await fixture.service.testConnection(PROFILE_ID);
    assert.equal(tested.status, 'succeeded');
    assert.equal(tested.authentication, 'password');
    assert.equal(tested.sftpAvailable, true);
    assert.equal(tested.hostKey.fingerprintSha256, FIRST_KEY.fingerprintSha256);
    assert.deepEqual(fixture.secretStore.getCalls, ['profile:profile-one:password']);
    assert.equal(fixture.transport.testCalls[0].password, PASSWORD_MARKER);

    const visibleText = JSON.stringify({
      response: tested,
      audits: fixture.database.all('SELECT * FROM audit_events'),
    });
    assert.equal(visibleText.includes(PASSWORD_MARKER), false);
    assert.equal(visibleText.includes(FIRST_KEY.publicKeyBase64), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('changed key blocks authentication without reading the stored password', async () => {
  const fixture = createFixture();
  try {
    const probe = await fixture.service.probeHostKey(PROFILE_ID);
    fixture.service.trustHostKey(PROFILE_ID, { challengeToken: probe.challengeToken });
    fixture.transport.observedKey = CHANGED_KEY;

    const result = await fixture.service.testConnection(PROFILE_ID);
    assert.equal(result.code, 'HOST_KEY_MISMATCH');
    assert.equal(result.previousFingerprintSha256, FIRST_KEY.fingerprintSha256);
    assert.equal(fixture.secretStore.getCalls.length, 0);
    assert.equal(fixture.transport.testCalls.length, 0);
  } finally {
    cleanupFixture(fixture);
  }
});
