import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createHostKeyChallengeStore } from '../../src/remote/hostKeyChallengeStore.js';
import { createHostKeyService } from '../../src/remote/hostKeyService.js';
import { createSshTerminalService } from '../../src/remote/sshTerminalService.js';
import { createTerminalTokenStore } from '../../src/remote/terminalTokenStore.js';

const FIXED_NOW = '2026-05-27T08:00:00.000Z';
const PROFILE_ID = 'profile-one';
const PROFILE = {
  id: PROFILE_ID,
  deviceId: 'local:one',
  host: 'host.test',
  port: 22,
};
const PASSWORD_MARKER = 'sensitive-terminal-password-marker';
const INPUT_MARKER = 'sensitive-user-input-marker';
const OUTPUT_MARKER = 'sensitive-remote-output-marker';
const FIRST_KEY = {
  host: PROFILE.host,
  port: PROFILE.port,
  keyType: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:first-terminal-fingerprint',
  publicKeyBase64: Buffer.from('terminal-public-key').toString('base64'),
};
const CHANGED_KEY = {
  ...FIRST_KEY,
  fingerprintSha256: 'SHA256:changed-terminal-fingerprint',
  publicKeyBase64: Buffer.from('changed-terminal-public-key').toString('base64'),
};

class FakeSecretStore {
  getCalls = [];

  async getSecret(account) {
    this.getCalls.push(account);
    return PASSWORD_MARKER;
  }
}

class FakeTerminal extends EventEmitter {
  writes = [];
  resizes = [];
  closed = false;

  onData(listener) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }

  onClose(listener) {
    this.on('close', listener);
    return () => this.off('close', listener);
  }

  write(data) {
    this.writes.push(data);
  }

  resize(dimensions) {
    this.resizes.push(dimensions);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class FakeTransport {
  observedKey = FIRST_KEY;
  probeCalls = [];
  openCalls = [];
  terminal = new FakeTerminal();
  openError = null;

  async probeHostKey(profile) {
    this.probeCalls.push(profile);
    return this.observedKey;
  }

  async openTerminal(profile, password, hostKey, dimensions) {
    this.openCalls.push({ profile, password, hostKey, dimensions });
    if (this.openError) throw this.openError;
    return this.terminal;
  }
}

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-terminal-service-'));
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

  let id = 0;
  const secretStore = new FakeSecretStore();
  const transport = new FakeTransport();
  const hostKeyService = createHostKeyService(
    database,
    createHostKeyChallengeStore({
      now: () => Date.parse(FIXED_NOW),
      createToken: () => 'host-key-challenge',
    }),
    {
      now: () => FIXED_NOW,
      createId: () => `id-${++id}`,
    },
  );
  const tokenStore = createTerminalTokenStore({
    now: () => Date.parse(FIXED_NOW),
    createToken: () => 'terminal-token-one',
  });
  const service = createSshTerminalService(
    database,
    secretStore,
    transport,
    hostKeyService,
    tokenStore,
    {
      now: () => FIXED_NOW,
      createId: () => `id-${++id}`,
    },
  );
  return { root, database, secretStore, transport, hostKeyService, service };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

const trustAndIssue = async (fixture) => {
  const pending = await fixture.service.issueTerminalToken(PROFILE_ID, { cols: 100, rows: 30 });
  fixture.hostKeyService.approveFirstSeen(PROFILE, pending.challengeToken);
  return await fixture.service.issueTerminalToken(PROFILE_ID, { cols: 100, rows: 30 });
};

test('terminal token issuance requires a trusted key and never reads the password', async () => {
  const fixture = createFixture();
  try {
    const pending = await fixture.service.issueTerminalToken(PROFILE_ID, { cols: 100, rows: 30 });
    assert.equal(pending.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
    assert.equal(fixture.secretStore.getCalls.length, 0);

    fixture.hostKeyService.approveFirstSeen(PROFILE, pending.challengeToken);
    const ready = await fixture.service.issueTerminalToken(PROFILE_ID, { cols: 100, rows: 30 });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.token, 'terminal-token-one');
    assert.equal(ready.hostKey.code, 'HOST_KEY_TRUSTED');
    assert.equal(fixture.secretStore.getCalls.length, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('opening and closing a terminal records metadata only and closes the session once', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndIssue(fixture);
    const opened = await fixture.service.openTerminal(ready.token);
    const output = [];
    opened.onData((data) => output.push(data));

    fixture.service.write(opened.sessionId, INPUT_MARKER);
    fixture.service.resize(opened.sessionId, { cols: 120, rows: 36 });
    fixture.transport.terminal.emit('data', OUTPUT_MARKER);
    fixture.service.close(opened.sessionId, 'operator_closed');
    fixture.service.close(opened.sessionId, 'duplicate_close');

    assert.deepEqual(fixture.secretStore.getCalls, ['profile:profile-one:password']);
    assert.equal(fixture.transport.openCalls[0].password, PASSWORD_MARKER);
    assert.deepEqual(fixture.transport.terminal.writes, [INPUT_MARKER]);
    assert.deepEqual(fixture.transport.terminal.resizes, [{ cols: 120, rows: 36 }]);
    assert.deepEqual(output, [OUTPUT_MARKER]);

    const session = fixture.database.get('SELECT state, transcript_policy, ended_reason FROM remote_sessions');
    assert.deepEqual(session, {
      state: 'closed',
      transcript_policy: 'metadata_only',
      ended_reason: 'operator_closed',
    });
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM terminal_transcript_chunks').count, 0);
    assert.equal(
      fixture.database.get("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'terminal.session.closed'").count,
      1,
    );
    const persisted = JSON.stringify({
      sessions: fixture.database.all('SELECT * FROM remote_sessions'),
      audit: fixture.database.all('SELECT * FROM audit_events'),
    });
    assert.equal(persisted.includes(PASSWORD_MARKER), false);
    assert.equal(persisted.includes(INPUT_MARKER), false);
    assert.equal(persisted.includes(OUTPUT_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('changed key at terminal open consumes the token and rejects before reading a password', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndIssue(fixture);
    fixture.transport.observedKey = CHANGED_KEY;

    await assert.rejects(
      fixture.service.openTerminal(ready.token),
      (error) => error.code === 'HOST_KEY_MISMATCH',
    );
    await assert.rejects(
      fixture.service.openTerminal(ready.token),
      (error) => error.code === 'TERMINAL_TOKEN_INVALID',
    );
    assert.equal(fixture.secretStore.getCalls.length, 0);
    assert.equal(fixture.transport.openCalls.length, 0);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM remote_sessions').count, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('terminal opening failure writes only stable failed-session metadata', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndIssue(fixture);
    const openError = new Error(`transport detail includes ${PASSWORD_MARKER}`);
    openError.code = 'SSH_TERMINAL_OPEN_FAILED';
    fixture.transport.openError = openError;

    await assert.rejects(
      fixture.service.openTerminal(ready.token),
      (error) => error.code === 'SSH_TERMINAL_OPEN_FAILED',
    );

    assert.deepEqual(
      fixture.database.get('SELECT state, error_code, error_message FROM remote_sessions'),
      {
        state: 'failed',
        error_code: 'SSH_TERMINAL_OPEN_FAILED',
        error_message: null,
      },
    );
    const failedAudit = fixture.database.get(
      "SELECT detail_json FROM audit_events WHERE event_type = 'terminal.session.failed'",
    );
    assert.equal(JSON.parse(failedAudit.detail_json).errorCode, 'SSH_TERMINAL_OPEN_FAILED');
    assert.equal(failedAudit.detail_json.includes(PASSWORD_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});
