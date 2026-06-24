import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createConnectionProfileService } from '../../src/remote/connectionProfileService.js';
import { createKeyringSecretStore, createUnavailableSecretStore } from '../../src/remote/secretStore.js';

const FIXED_NOW = '2026-05-26T11:00:00.000Z';
const SECRET_MARKER = 'disposable-p3-secret-marker';
const REPLACEMENT_SECRET_MARKER = 'disposable-p3-replacement-marker';

class FakeSecretStore {
  constructor({ failSet = false } = {}) {
    this.provider = 'fake-vault';
    this.service = 'opsdog.remote.test';
    this.failSet = failSet;
    this.entries = new Map();
    this.setCalls = [];
    this.deleteCalls = [];
  }

  async setSecret(account, secret) {
    this.setCalls.push({ account, secret });
    if (this.failSet) throw new Error('vault unavailable');
    this.entries.set(account, secret);
  }

  async getSecret(account) {
    return this.entries.get(account) ?? null;
  }

  async deleteSecret(account) {
    this.deleteCalls.push(account);
    this.entries.delete(account);
  }
}

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-profile-service-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  applyMigrations(database, { now: () => FIXED_NOW });
  database.run(
    `
      INSERT INTO asset_sources (id, name, source_type, read_only, created_at, updated_at)
      VALUES ('local-default', 'Local', 'local', 0, ?, ?),
             ('remote-default', 'Remote', 'remote_api', 1, ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
  );
  database.run(
    `
      INSERT INTO devices
        (id, asset_source_id, external_id, name, asset_id, device_type, asset_status,
         ip_address, created_at, updated_at)
      VALUES ('local:one', 'local-default', 'one', 'Local One', 'L-1', 'server', 'healthy',
              '10.0.0.1', ?, ?),
             ('remote:two', 'remote-default', 'two', 'Remote Two', 'R-2', 'server', 'healthy',
              '10.0.0.2', ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
  );
  let nextId = 0;
  return {
    root,
    database,
    createId: () => `p3-${++nextId}`,
  };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

const profilePayload = (overrides = {}) => ({
  name: 'Primary SSH',
  protocol: 'ssh',
  host: '10.0.0.1',
  port: 22,
  username: 'operator',
  authMethod: 'password',
  password: SECRET_MARKER,
  isDefault: true,
  ...overrides,
});

test('unavailable SecretStore fails closed with a stable error code', async () => {
  const store = createUnavailableSecretStore();
  await assert.rejects(
    store.setSecret('credential', SECRET_MARKER),
    (error) => error.code === 'SECRET_STORE_UNAVAILABLE',
  );
});

test('keyring operation failures fail closed with a stable error code', async () => {
  const store = await createKeyringSecretStore({
    service: 'opsdog.remote.test',
    loadKeyring: async () => ({
      Entry: class FailedEntry {
        getPassword() {
          throw new Error('native credential vault failure');
        }
      },
    }),
  });

  await assert.rejects(
    store.getSecret('disposable-operation-failure'),
    (error) => error.code === 'SECRET_STORE_UNAVAILABLE' && error.statusCode === 503,
  );
});

test('connection profile creation writes a vault secret but returns and stores only safe metadata', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    assert.equal(created.deviceId, 'local:one');
    assert.equal(created.hasPasswordCredential, true);
    assert.equal(created.strictHostKeyChecking, true);
    assert.equal(vault.setCalls.length, 1);
    assert.equal(vault.setCalls[0].secret, SECRET_MARKER);

    const serializedResponse = JSON.stringify(created);
    assert.equal(serializedResponse.includes(SECRET_MARKER), false);
    assert.equal(serializedResponse.includes('vaultAccount'), false);
    assert.equal(serializedResponse.includes('secretFingerprint'), false);

    const listed = await service.listProfiles('local:one');
    assert.deepEqual(listed, [created]);

    const databaseText = JSON.stringify({
      credentialRefs: fixture.database.all('SELECT * FROM credential_refs'),
      profiles: fixture.database.all('SELECT * FROM connection_profiles'),
      audit: fixture.database.all('SELECT * FROM audit_events'),
    });
    assert.equal(databaseText.includes(SECRET_MARKER), false);
    assert.equal(fixture.database.get('SELECT event_type FROM audit_events').event_type, 'credential.created');
  } finally {
    cleanupFixture(fixture);
  }
});

test('remote synchronized devices may receive local SSH connection profiles', async () => {
  const fixture = createFixture();
  const service = createConnectionProfileService(fixture.database, new FakeSecretStore(), {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('remote:two', profilePayload({
      host: '10.0.0.2',
      password: `${SECRET_MARKER}-remote`,
    }));
    assert.equal(created.deviceId, 'remote:two');
    assert.equal((await service.listProfiles('remote:two')).length, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET profiles do not require plaintext acknowledgement and force SSH-only capabilities off', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload({
      name: 'Legacy TELNET',
      protocol: 'telnet',
      port: 23,
      sftpEnabled: true,
    }));
    assert.equal(created.protocol, 'telnet');
    assert.equal(created.name, 'Legacy TELNET');
    assert.equal(created.port, 23);
    assert.equal(created.strictHostKeyChecking, false);
    assert.equal(created.sftpEnabled, false);
    assert.equal(created.hasPasswordCredential, true);
    assert.equal(vault.setCalls.length, 1);
    assert.equal(vault.setCalls[0].secret, SECRET_MARKER);

    const row = fixture.database.get(
      'SELECT protocol, strict_host_key_checking, sftp_enabled FROM connection_profiles WHERE id = ?',
      created.id,
    );
    assert.deepEqual(row, {
      protocol: 'telnet',
      strict_host_key_checking: 0,
      sftp_enabled: 0,
    });
    const updated = await service.updateProfile(created.id, {
      name: 'Renamed TELNET',
      protocol: 'telnet',
      sftpEnabled: true,
    });
    assert.equal(updated.name, 'Renamed TELNET');
    assert.equal(updated.protocol, 'telnet');
    assert.equal(updated.sftpEnabled, false);
    const audit = fixture.database.get('SELECT summary, detail_json FROM audit_events');
    assert.match(audit.summary, /TELNET profile/);
    assert.equal(JSON.stringify({ created, audit }).includes(SECRET_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET profiles may omit username and stored password for interactive login', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload({
      name: 'Interactive TELNET',
      protocol: 'telnet',
      port: 23,
      username: '',
      password: '',
      authMethod: 'none',
    }));

    assert.equal(created.protocol, 'telnet');
    assert.equal(created.authMethod, 'none');
    assert.equal(created.username, '');
    assert.equal(created.hasPasswordCredential, false);
    assert.equal(created.strictHostKeyChecking, false);
    assert.equal(created.sftpEnabled, false);
    assert.equal(vault.setCalls.length, 0);

    const row = fixture.database.get(
      'SELECT auth_method, username, password_credential_ref_id FROM connection_profiles WHERE id = ?',
      created.id,
    );
    assert.deepEqual(row, {
      auth_method: 'none',
      username: '',
      password_credential_ref_id: null,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test('invalid profile requests and vault failure do not persist credential references or profiles', async () => {
  const fixture = createFixture();
  try {
    const service = createConnectionProfileService(fixture.database, new FakeSecretStore(), {
      now: () => FIXED_NOW,
      createId: fixture.createId,
    });
    await assert.rejects(service.createProfile('local:one', profilePayload({ protocol: 'ftp' })), /协议/);
    await assert.rejects(service.createProfile('local:one', profilePayload({ password: '' })), /密码/);
    await assert.rejects(service.createProfile('local:one', profilePayload({ port: 70000 })), /端口/);

    const failedVaultService = createConnectionProfileService(
      fixture.database,
      new FakeSecretStore({ failSet: true }),
      { now: () => FIXED_NOW, createId: fixture.createId },
    );
    await assert.rejects(failedVaultService.createProfile('local:one', profilePayload()), /vault unavailable/);

    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM credential_refs').count, 0);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM connection_profiles').count, 0);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM audit_events').count, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('database insertion failure removes a secret that was already written to the vault', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    await assert.rejects(
      service.createProfile('local:one', profilePayload({ connectTimeoutMs: 1 })),
      /CHECK constraint failed/,
    );
    assert.equal(vault.setCalls.length, 1);
    assert.deepEqual(vault.deleteCalls, [vault.setCalls[0].account]);
    assert.equal(vault.entries.size, 0);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM credential_refs').count, 0);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM connection_profiles').count, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('profile metadata updates do not read or overwrite an existing vault secret', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    const updated = await service.updateProfile(created.id, {
      name: 'Renamed SSH',
      host: '10.0.0.9',
      port: 2222,
    });

    assert.equal(updated.name, 'Renamed SSH');
    assert.equal(updated.host, '10.0.0.9');
    assert.equal(updated.port, 2222);
    assert.equal(vault.setCalls.length, 1);
    assert.equal(vault.entries.get(vault.setCalls[0].account), SECRET_MARKER);
  } finally {
    cleanupFixture(fixture);
  }
});

test('profile password replacement updates vault metadata without exposing either secret', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    const before = fixture.database.get('SELECT secret_fingerprint FROM credential_refs');
    const updated = await service.updateProfile(created.id, {
      password: REPLACEMENT_SECRET_MARKER,
    });
    const after = fixture.database.get('SELECT secret_fingerprint FROM credential_refs');
    const databaseText = JSON.stringify({
      credentials: fixture.database.all('SELECT * FROM credential_refs'),
      audit: fixture.database.all('SELECT * FROM audit_events'),
    });

    assert.equal(vault.setCalls.length, 2);
    assert.equal(vault.entries.get(vault.setCalls[0].account), REPLACEMENT_SECRET_MARKER);
    assert.notEqual(after.secret_fingerprint, before.secret_fingerprint);
    assert.equal(JSON.stringify(updated).includes(REPLACEMENT_SECRET_MARKER), false);
    assert.equal(databaseText.includes(REPLACEMENT_SECRET_MARKER), false);
    assert.deepEqual(
      fixture.database.all('SELECT event_type FROM audit_events ORDER BY created_at, rowid')
        .map((row) => row.event_type),
      ['credential.created', 'credential.updated'],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('making a second profile default clears the previous default profile', async () => {
  const fixture = createFixture();
  const service = createConnectionProfileService(fixture.database, new FakeSecretStore(), {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const first = await service.createProfile('local:one', profilePayload({ name: 'First' }));
    const second = await service.createProfile('local:one', profilePayload({
      name: 'Second',
      password: `${SECRET_MARKER}-second`,
      isDefault: false,
    }));
    await service.updateProfile(second.id, { isDefault: true });

    const profiles = await service.listProfiles('local:one');
    assert.equal(profiles.find((profile) => profile.id === first.id).isDefault, false);
    assert.equal(profiles.find((profile) => profile.id === second.id).isDefault, true);
  } finally {
    cleanupFixture(fixture);
  }
});

test('deleting a profile soft-deletes its credential and removes the vault entry', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    const result = await service.deleteProfile(created.id, { deleteCredential: true });

    assert.deepEqual(result, { ok: true, profileId: created.id });
    assert.deepEqual(await service.listProfiles('local:one'), []);
    assert.equal(fixture.database.get('SELECT deleted_at FROM connection_profiles').deleted_at, FIXED_NOW);
    assert.equal(fixture.database.get('SELECT deleted_at FROM credential_refs').deleted_at, FIXED_NOW);
    assert.equal(vault.entries.size, 0);
    assert.equal(
      fixture.database.get("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'credential.deleted'").count,
      1,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('deleting a profile is rejected while it has an active remote session', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    fixture.database.run(
      `
        INSERT INTO remote_sessions
          (id, connection_profile_id, device_id, session_kind, protocol, actor_type,
           state, remote_address, started_at)
        VALUES ('active-session', ?, 'local:one', 'terminal', 'ssh', 'human',
                'active', '10.0.0.1', ?)
      `,
      created.id,
      FIXED_NOW,
    );

    await assert.rejects(service.deleteProfile(created.id), /活跃会话/);
    assert.equal((await service.listProfiles('local:one')).length, 1);
    assert.equal(vault.entries.size, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('failed password metadata update restores the previous vault value', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    const account = vault.setCalls[0].account;
    const brokenDatabase = {
      ...fixture.database,
      transaction: () => {
        throw new Error('forced update transaction failure');
      },
    };
    const brokenService = createConnectionProfileService(brokenDatabase, vault, {
      now: () => FIXED_NOW,
      createId: fixture.createId,
    });

    await assert.rejects(
      brokenService.updateProfile(created.id, { password: REPLACEMENT_SECRET_MARKER }),
      /forced update transaction failure/,
    );
    assert.equal(vault.entries.get(account), SECRET_MARKER);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM audit_events').count, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('failed soft-delete transaction restores a removed vault entry', async () => {
  const fixture = createFixture();
  const vault = new FakeSecretStore();
  const service = createConnectionProfileService(fixture.database, vault, {
    now: () => FIXED_NOW,
    createId: fixture.createId,
  });
  try {
    const created = await service.createProfile('local:one', profilePayload());
    const account = vault.setCalls[0].account;
    const brokenDatabase = {
      ...fixture.database,
      transaction: () => {
        throw new Error('forced delete transaction failure');
      },
    };
    const brokenService = createConnectionProfileService(brokenDatabase, vault, {
      now: () => FIXED_NOW,
      createId: fixture.createId,
    });

    await assert.rejects(
      brokenService.deleteProfile(created.id, { deleteCredential: true }),
      /forced delete transaction failure/,
    );
    assert.equal(vault.entries.get(account), SECRET_MARKER);
    assert.equal((await service.listProfiles('local:one')).length, 1);
  } finally {
    cleanupFixture(fixture);
  }
});
