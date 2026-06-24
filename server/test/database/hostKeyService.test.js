import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createHostKeyChallengeStore } from '../../src/remote/hostKeyChallengeStore.js';
import { createHostKeyService } from '../../src/remote/hostKeyService.js';

const FIXED_NOW = '2026-05-27T03:00:00.000Z';
const PROFILE = {
  id: 'profile-one',
  deviceId: 'local:one',
  host: 'host.test',
  port: 22,
};
const FIRST_KEY = {
  host: PROFILE.host,
  port: PROFILE.port,
  keyType: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:first-fingerprint',
  publicKeyBase64: Buffer.from('first-disposable-public-key').toString('base64'),
};
const CHANGED_KEY = {
  ...FIRST_KEY,
  fingerprintSha256: 'SHA256:changed-fingerprint',
  publicKeyBase64: Buffer.from('changed-disposable-public-key').toString('base64'),
};

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-host-key-service-'));
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
         password_credential_ref_id, created_at, updated_at)
      VALUES ('profile-one', 'local:one', 'Primary SSH', 'ssh', 'host.test', 22,
              'operator', 'password', 'credential-one', ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );

  let nextId = 0;
  let nextToken = 0;
  const challengeStore = createHostKeyChallengeStore({
    now: () => Date.parse(FIXED_NOW),
    createToken: () => `challenge-${++nextToken}`,
    ttlMs: 60_000,
  });
  const service = createHostKeyService(database, challengeStore, {
    now: () => FIXED_NOW,
    createId: () => `host-key-${++nextId}`,
  });
  return { root, database, challengeStore, service };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

test('first-seen key requires confirmation, persists only after approval and exposes safe output', () => {
  const fixture = createFixture();
  try {
    const pending = fixture.service.evaluateObservedKey(PROFILE, FIRST_KEY);
    assert.equal(pending.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
    assert.equal(pending.fingerprintSha256, FIRST_KEY.fingerprintSha256);
    assert.equal(typeof pending.challengeToken, 'string');
    assert.equal(JSON.stringify(pending).includes(FIRST_KEY.publicKeyBase64), false);

    const trusted = fixture.service.approveFirstSeen(PROFILE, pending.challengeToken);
    assert.equal(trusted.code, 'HOST_KEY_TRUSTED');
    assert.equal(trusted.trustStatus, 'trusted');
    assert.equal(JSON.stringify(trusted).includes(FIRST_KEY.publicKeyBase64), false);

    const stored = fixture.database.get('SELECT * FROM ssh_host_keys');
    assert.equal(stored.public_key_base64, FIRST_KEY.publicKeyBase64);
    const audit = fixture.database.get('SELECT event_type, detail_json FROM audit_events');
    assert.equal(audit.event_type, 'host_key.approved');
    assert.equal(audit.detail_json.includes(FIRST_KEY.publicKeyBase64), false);
    assert.equal(JSON.parse(audit.detail_json).fingerprintSha256, FIRST_KEY.fingerprintSha256);

    assert.throws(
      () => fixture.service.approveFirstSeen(PROFILE, pending.challengeToken),
      (error) => error.code === 'HOST_KEY_CHALLENGE_INVALID',
    );
    assert.equal(fixture.service.evaluateObservedKey(PROFILE, FIRST_KEY).code, 'HOST_KEY_TRUSTED');
    assert.equal(fixture.service.listHostKeys(PROFILE.id).length, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('changed fingerprint is rejected without replacing the trusted key', () => {
  const fixture = createFixture();
  try {
    const pending = fixture.service.evaluateObservedKey(PROFILE, FIRST_KEY);
    fixture.service.approveFirstSeen(PROFILE, pending.challengeToken);

    const mismatch = fixture.service.evaluateObservedKey(PROFILE, CHANGED_KEY);
    assert.equal(mismatch.code, 'HOST_KEY_MISMATCH');
    assert.equal(mismatch.previousFingerprintSha256, FIRST_KEY.fingerprintSha256);
    assert.equal('challengeToken' in mismatch, false);
    assert.equal(JSON.stringify(mismatch).includes(CHANGED_KEY.publicKeyBase64), false);

    const stored = fixture.database.all('SELECT fingerprint_sha256, trust_status FROM ssh_host_keys');
    assert.deepEqual(stored, [{
      fingerprint_sha256: FIRST_KEY.fingerprintSha256,
      trust_status: 'trusted',
    }]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('challenge tokens expire before they can authorize a host key', () => {
  let now = 0;
  const challengeStore = createHostKeyChallengeStore({
    now: () => now,
    createToken: () => 'expiring-challenge',
    ttlMs: 100,
  });
  const token = challengeStore.issue({ profileId: PROFILE.id, observedKey: FIRST_KEY });
  now = 101;
  assert.throws(
    () => challengeStore.consume(token, PROFILE.id),
    (error) => error.code === 'HOST_KEY_CHALLENGE_INVALID',
  );
});
