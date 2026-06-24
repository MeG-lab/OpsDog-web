import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createRemoteTerminalService } from '../../src/remote/remoteTerminalService.js';
import { createTelnetTerminalService } from '../../src/remote/telnetTerminalService.js';
import { createTerminalTokenStore } from '../../src/remote/terminalTokenStore.js';

const FIXED_NOW = '2026-06-02T09:00:00.000Z';
const TELNET_PROFILE_ID = 'telnet-profile-one';
const PASSWORD_MARKER = 'sensitive-telnet-terminal-password-marker';
const INPUT_MARKER = 'sensitive-telnet-input-marker';
const OUTPUT_MARKER = 'sensitive-telnet-output-marker';

class FakeSecretStore {
  getCalls = [];
  secret = PASSWORD_MARKER;

  async getSecret(account) {
    this.getCalls.push(account);
    return this.secret;
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

class FakeTelnetTransport {
  openCalls = [];
  terminal = new FakeTerminal();
  openError = null;

  async openTerminal(profile, credentials, dimensions) {
    this.openCalls.push({ profile, credentials, dimensions });
    if (this.openError) throw this.openError;
    return this.terminal;
  }
}

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-telnet-terminal-service-'));
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
              'operator', 'password', 'credential-one', 0, 0, 1000, 0, ?, ?)
    `,
    FIXED_NOW,
    FIXED_NOW,
  );
  let id = 0;
  const secretStore = new FakeSecretStore();
  const transport = new FakeTelnetTransport();
  const tokenStore = createTerminalTokenStore({
    now: () => Date.parse(FIXED_NOW),
    createToken: () => 'telnet-terminal-token-one',
  });
  const service = createTelnetTerminalService(
    database,
    secretStore,
    transport,
    tokenStore,
    {
      now: () => FIXED_NOW,
      createId: () => `telnet-terminal-id-${++id}`,
    },
  );
  return { root, database, secretStore, transport, service };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

test('TELNET terminal token issuance does not read the password', async () => {
  const fixture = createFixture();
  try {
    const ready = await fixture.service.issueTerminalToken(TELNET_PROFILE_ID, { cols: 100, rows: 30 });
    assert.deepEqual(ready, {
      status: 'ready',
      token: 'telnet-terminal-token-one',
      expiresAt: '2026-06-02T09:00:30.000Z',
      protocol: 'telnet',
      plaintext: true,
    });
    assert.deepEqual(fixture.secretStore.getCalls, []);
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET terminal opens interactive profiles without reading credentials', async () => {
  const fixture = createFixture();
  try {
    fixture.database.run(
      `
        INSERT INTO connection_profiles
          (id, device_id, name, protocol, host, port, username, auth_method,
           password_credential_ref_id, strict_host_key_checking, sftp_enabled,
           connect_timeout_ms, keepalive_interval_ms, created_at, updated_at)
        VALUES ('interactive-telnet-profile', 'local:one', 'Interactive TELNET', 'telnet', 'host.test', 23,
                '', 'none', NULL, 0, 0, 1000, 0, ?, ?)
      `,
      FIXED_NOW,
      FIXED_NOW,
    );
    const ready = await fixture.service.issueTerminalToken('interactive-telnet-profile', { cols: 100, rows: 30 });
    const opened = await fixture.service.openTerminal(ready.token);

    fixture.service.write(opened.sessionId, 'operator\r\n');
    fixture.transport.terminal.emit('data', 'Password: ');

    assert.deepEqual(fixture.secretStore.getCalls, []);
    assert.equal(fixture.transport.openCalls.length, 1);
    assert.equal(fixture.transport.openCalls[0].credentials, null);
    assert.equal(fixture.transport.openCalls[0].profile.username, '');
    assert.deepEqual(fixture.transport.terminal.writes, ['operator\r\n']);
    const openedAudit = fixture.database.get("SELECT detail_json FROM audit_events WHERE event_type = 'telnet.session.opened'");
    assert.equal(JSON.parse(openedAudit.detail_json).authentication, 'interactive');
  } finally {
    cleanupFixture(fixture);
  }
});

test('TELNET terminal opening and closing records metadata only', async () => {
  const fixture = createFixture();
  try {
    const ready = await fixture.service.issueTerminalToken(TELNET_PROFILE_ID, { cols: 100, rows: 30 });
    const opened = await fixture.service.openTerminal(ready.token);
    const output = [];
    opened.onData((data) => output.push(data));

    fixture.service.write(opened.sessionId, INPUT_MARKER);
    fixture.service.resize(opened.sessionId, { cols: 120, rows: 36 });
    fixture.transport.terminal.emit('data', OUTPUT_MARKER);
    fixture.service.close(opened.sessionId, 'operator_closed');
    fixture.service.close(opened.sessionId, 'duplicate_close');

    assert.deepEqual(fixture.secretStore.getCalls, ['profile:telnet-profile-one:password']);
    assert.equal(fixture.transport.openCalls[0].credentials.password, PASSWORD_MARKER);
    assert.deepEqual(fixture.transport.openCalls[0].dimensions, { cols: 100, rows: 30 });
    assert.deepEqual(fixture.transport.terminal.writes, [INPUT_MARKER]);
    assert.deepEqual(fixture.transport.terminal.resizes, [{ cols: 120, rows: 36 }]);
    assert.deepEqual(output, [OUTPUT_MARKER]);

    const session = fixture.database.get(
      'SELECT state, protocol, host_key_id, transcript_policy, ended_reason FROM remote_sessions',
    );
    assert.deepEqual(session, {
      state: 'closed',
      protocol: 'telnet',
      host_key_id: null,
      transcript_policy: 'metadata_only',
      ended_reason: 'operator_closed',
    });
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM terminal_transcript_chunks').count, 0);
    assert.equal(
      fixture.database.get("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'telnet.session.closed'").count,
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

test('TELNET terminal opening failure stores only a stable error code', async () => {
  const fixture = createFixture();
  try {
    const ready = await fixture.service.issueTerminalToken(TELNET_PROFILE_ID, { cols: 100, rows: 30 });
    const openError = new Error(`transport detail ${PASSWORD_MARKER}`);
    openError.code = 'TELNET_LOGIN_FAILED';
    fixture.transport.openError = openError;

    await assert.rejects(
      fixture.service.openTerminal(ready.token),
      (error) => error.code === 'TELNET_LOGIN_FAILED',
    );
    const session = fixture.database.get('SELECT state, protocol, error_code, error_message FROM remote_sessions');
    assert.deepEqual(session, {
      state: 'failed',
      protocol: 'telnet',
      error_code: 'TELNET_LOGIN_FAILED',
      error_message: null,
    });
    const failedAudit = fixture.database.get("SELECT detail_json FROM audit_events WHERE event_type = 'telnet.session.failed'");
    assert.equal(JSON.parse(failedAudit.detail_json).errorCode, 'TELNET_LOGIN_FAILED');
    assert.equal(failedAudit.detail_json.includes(PASSWORD_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('remote terminal facade dispatches tokens and sessions by profile protocol', async () => {
  const calls = [];
  const makeProtocolService = (protocol) => ({
    async issueTerminalToken(profileId) {
      calls.push(`${protocol}:issue:${profileId}`);
      return { status: 'ready', token: `${protocol}-token` };
    },
    async openTerminal(token) {
      calls.push(`${protocol}:open:${token}`);
      return { sessionId: `${protocol}-session`, onData: () => () => {} };
    },
    write(sessionId, data) {
      calls.push(`${protocol}:write:${sessionId}:${data}`);
    },
    resize(sessionId, dimensions) {
      calls.push(`${protocol}:resize:${sessionId}:${dimensions.cols}x${dimensions.rows}`);
    },
    close(sessionId, reason) {
      calls.push(`${protocol}:close:${sessionId}:${reason}`);
    },
    closeAll(reason) {
      calls.push(`${protocol}:closeAll:${reason}`);
    },
  });
  const service = createRemoteTerminalService({
    profileService: {
      getProfile: (profileId) => ({ id: profileId, protocol: profileId.startsWith('telnet') ? 'telnet' : 'ssh' }),
    },
    sshTerminalService: makeProtocolService('ssh'),
    telnetTerminalService: makeProtocolService('telnet'),
  });

  assert.deepEqual(await service.issueTerminalToken('telnet-one', { cols: 80, rows: 24 }), {
    status: 'ready',
    token: 'telnet-token',
  });
  const opened = await service.openTerminal('telnet-token');
  service.write(opened.sessionId, 'input');
  service.resize(opened.sessionId, { cols: 120, rows: 40 });
  service.close(opened.sessionId, 'operator_closed');
  service.closeAll('server_stopped');

  assert.deepEqual(calls, [
    'telnet:issue:telnet-one',
    'telnet:open:telnet-token',
    'telnet:write:telnet-session:input',
    'telnet:resize:telnet-session:120x40',
    'telnet:close:telnet-session:operator_closed',
    'ssh:closeAll:server_stopped',
    'telnet:closeAll:server_stopped',
  ]);
});
