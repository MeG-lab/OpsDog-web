import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';
import { createHostKeyChallengeStore } from '../../src/remote/hostKeyChallengeStore.js';
import { createHostKeyService } from '../../src/remote/hostKeyService.js';
import { createSftpService } from '../../src/remote/sftpService.js';

const FIXED_NOW = '2026-06-01T08:00:00.000Z';
const PROFILE_ID = 'profile-one';
const PROFILE = {
  id: PROFILE_ID,
  deviceId: 'local:one',
  host: 'host.test',
  port: 22,
};
const PASSWORD_MARKER = 'sensitive-sftp-password-marker';
const FILE_CONTENT_MARKER = 'sensitive-downloaded-file-content-marker';
const FIRST_KEY = {
  host: PROFILE.host,
  port: PROFILE.port,
  keyType: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:first-sftp-fingerprint',
  publicKeyBase64: Buffer.from('sftp-public-key').toString('base64'),
};
const CHANGED_KEY = {
  ...FIRST_KEY,
  fingerprintSha256: 'SHA256:changed-sftp-fingerprint',
  publicKeyBase64: Buffer.from('changed-sftp-public-key').toString('base64'),
};

class FakeSecretStore {
  getCalls = [];

  async getSecret(account) {
    this.getCalls.push(account);
    return PASSWORD_MARKER;
  }
}

class FakeSftpAdapter {
  closed = false;
  listCalls = [];
  statCalls = [];
  streamCalls = [];
  attrsByPath = new Map();
  statErrorsByPath = new Map();
  stream = new EventEmitter();

  async list(remotePath) {
    this.listCalls.push(remotePath);
    return [{
      filename: 'app.log',
      attrs: {
        size: 1204,
        mode: 0o100644,
        mtime: 1770000000,
        isDirectory: () => false,
        isFile: () => true,
      },
    }];
  }

  async stat(remotePath) {
    this.statCalls.push(remotePath);
    if (this.statErrorsByPath.has(remotePath)) throw this.statErrorsByPath.get(remotePath);
    if (this.attrsByPath.has(remotePath)) return this.attrsByPath.get(remotePath);
    return {
      size: 1204,
      mode: 0o100644,
      mtime: 1770000000,
      isDirectory: () => false,
      isFile: () => true,
    };
  }

  createReadStream(remotePath) {
    this.streamCalls.push(remotePath);
    return this.stream;
  }

  close() {
    this.closed = true;
  }
}

class FakeSftpMutationAdapter {
  closed = false;
  uploadCalls = [];
  mkdirCalls = [];
  renameCalls = [];
  deleteFileCalls = [];
  recursiveDeleteCalled = false;
  rmdirCalled = false;
  nextError = null;

  async uploadStream(remotePath, stream, options) {
    if (this.nextError) throw this.nextError;
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    this.uploadCalls.push({ remotePath, options, body: Buffer.concat(chunks).toString('utf8') });
  }

  async mkdir(remotePath) {
    if (this.nextError) throw this.nextError;
    this.mkdirCalls.push(remotePath);
  }

  async rename(fromPath, toPath) {
    if (this.nextError) throw this.nextError;
    this.renameCalls.push([fromPath, toPath]);
  }

  async deleteFile(remotePath) {
    if (this.nextError) throw this.nextError;
    this.deleteFileCalls.push(remotePath);
  }

  close() {
    this.closed = true;
  }
}

class FakeTransport {
  observedKey = FIRST_KEY;
  probeCalls = [];
  openCalls = [];
  mutationOpenCalls = [];
  sftp = new FakeSftpAdapter();
  mutations = new FakeSftpMutationAdapter();
  openError = null;

  async probeHostKey(profile) {
    this.probeCalls.push(profile);
    return this.observedKey;
  }

  async openSftp(profile, password, hostKey) {
    this.openCalls.push({ profile, password, hostKey });
    if (this.openError) throw this.openError;
    return this.sftp;
  }

  async openSftpMutations(profile, password, hostKey) {
    this.mutationOpenCalls.push({ profile, password, hostKey });
    if (this.openError) throw this.openError;
    return this.mutations;
  }
}

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-sftp-service-'));
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
  const service = createSftpService(database, secretStore, transport, hostKeyService, {
    now: () => FIXED_NOW,
    createId: () => `id-${++id}`,
  });
  return { root, database, secretStore, transport, hostKeyService, service };
};

const cleanupFixture = (fixture) => {
  fixture.database.close();
  rmSync(fixture.root, { recursive: true, force: true });
};

const trustAndOpen = async (fixture) => {
  const pending = await fixture.service.openSession(PROFILE_ID);
  fixture.hostKeyService.approveFirstSeen(PROFILE, pending.challengeToken);
  return await fixture.service.openSession(PROFILE_ID);
};

test('SFTP session opening requires trusted host keys before reading credentials', async () => {
  const fixture = createFixture();
  try {
    const pending = await fixture.service.openSession(PROFILE_ID);
    assert.equal(pending.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
    assert.equal(fixture.secretStore.getCalls.length, 0);
    assert.equal(fixture.transport.openCalls.length, 0);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM remote_sessions').count, 0);

    fixture.hostKeyService.approveFirstSeen(PROFILE, pending.challengeToken);
    const ready = await fixture.service.openSession(PROFILE_ID);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.session.profileId, PROFILE_ID);
    assert.deepEqual(fixture.secretStore.getCalls, ['profile:profile-one:password']);
    assert.equal(fixture.transport.openCalls[0].password, PASSWORD_MARKER);
    assert.equal(fixture.transport.mutationOpenCalls[0].password, PASSWORD_MARKER);

    const session = fixture.database.get(
      'SELECT id, session_kind, state, transcript_policy, error_code FROM remote_sessions',
    );
    assert.deepEqual(session, {
      id: ready.session.id,
      session_kind: 'sftp',
      state: 'active',
      transcript_policy: 'metadata_only',
      error_code: null,
    });

    fixture.service.closeSession(ready.session.id, 'operator_closed');
    assert.equal(fixture.transport.sftp.closed, true);
    assert.equal(fixture.transport.mutations.closed, true);
    assert.equal(fixture.database.get('SELECT state, ended_reason FROM remote_sessions').state, 'closed');
    assert.equal(fixture.database.get('SELECT state, ended_reason FROM remote_sessions').ended_reason, 'operator_closed');
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP session opening refuses disabled SFTP and changed host keys', async () => {
  const fixture = createFixture();
  try {
    fixture.database.run('UPDATE connection_profiles SET sftp_enabled = 0 WHERE id = ?', PROFILE_ID);
    await assert.rejects(
      fixture.service.openSession(PROFILE_ID),
      (error) => error.code === 'SFTP_DISABLED',
    );
    fixture.database.run('UPDATE connection_profiles SET sftp_enabled = 1 WHERE id = ?', PROFILE_ID);

    const pending = await fixture.service.openSession(PROFILE_ID);
    fixture.hostKeyService.approveFirstSeen(PROFILE, pending.challengeToken);
    fixture.transport.observedKey = CHANGED_KEY;
    const mismatch = await fixture.service.openSession(PROFILE_ID);
    assert.equal(mismatch.code, 'HOST_KEY_MISMATCH');
    assert.equal(fixture.secretStore.getCalls.length, 0);
    assert.equal(fixture.transport.openCalls.length, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP list and stat record metadata-only operations', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndOpen(fixture);

    const listed = await fixture.service.list(ready.session.id, '/var/log');
    const stat = await fixture.service.stat(ready.session.id, '/var/log/app.log');

    assert.equal(listed.path, '/var/log');
    assert.equal(listed.entries[0].name, 'app.log');
    assert.equal(listed.entries[0].kind, 'file');
    assert.equal(stat.entry.size, 1204);
    assert.deepEqual(fixture.transport.sftp.listCalls, ['/var/log']);
    assert.deepEqual(fixture.transport.sftp.statCalls, ['/var/log/app.log']);

    const operations = fixture.database.all(
      'SELECT operation_type, remote_path, status, error_message FROM sftp_operations ORDER BY started_at, id',
    );
    assert.deepEqual(operations, [
      { operation_type: 'list', remote_path: '/var/log', status: 'succeeded', error_message: null },
      { operation_type: 'stat', remote_path: '/var/log/app.log', status: 'succeeded', error_message: null },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP downloads track transfer status and never persist file content', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndOpen(fixture);
    const transfer = await fixture.service.download(ready.session.id, '/var/log/app.log');

    assert.equal(transfer.displayFileName, 'app.log');
    assert.equal(transfer.remotePath, '/var/log/app.log');
    assert.equal(transfer.stream, fixture.transport.sftp.stream);
    fixture.transport.sftp.stream.emit('data', Buffer.from(FILE_CONTENT_MARKER));
    fixture.transport.sftp.stream.emit('end');

    const row = fixture.database.get(
      'SELECT direction, remote_path, display_file_name, transferred_bytes, status FROM sftp_transfers',
    );
    assert.deepEqual(row, {
      direction: 'download',
      remote_path: '/var/log/app.log',
      display_file_name: 'app.log',
      transferred_bytes: Buffer.byteLength(FILE_CONTENT_MARKER),
      status: 'succeeded',
    });
    const persisted = JSON.stringify({
      sessions: fixture.database.all('SELECT * FROM remote_sessions'),
      transfers: fixture.database.all('SELECT * FROM sftp_transfers'),
      audit: fixture.database.all('SELECT * FROM audit_events'),
    });
    assert.equal(persisted.includes(FILE_CONTENT_MARKER), false);
    assert.equal(persisted.includes(PASSWORD_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP upload requires overwrite confirmation and records metadata only', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndOpen(fixture);

    await assert.rejects(
      fixture.service.upload(ready.session.id, {
        remotePath: '/tmp/existing.txt',
        fileName: 'local-secret-marker.txt',
        stream: Readable.from([FILE_CONTENT_MARKER]),
        sizeBytes: Buffer.byteLength(FILE_CONTENT_MARKER),
        confirmOverwrite: false,
      }),
      (error) => error.code === 'SFTP_OVERWRITE_CONFIRMATION_REQUIRED',
    );
    assert.equal(fixture.transport.mutations.uploadCalls.length, 0);

    const result = await fixture.service.upload(ready.session.id, {
      remotePath: '/tmp/existing.txt',
      fileName: 'local-secret-marker.txt',
      stream: Readable.from([FILE_CONTENT_MARKER]),
      sizeBytes: Buffer.byteLength(FILE_CONTENT_MARKER),
      confirmOverwrite: true,
    });

    assert.equal(result.remotePath, '/tmp/existing.txt');
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(fixture.transport.mutations.uploadCalls, [{
      remotePath: '/tmp/existing.txt',
      options: { overwrite: true },
      body: FILE_CONTENT_MARKER,
    }]);
    const transfers = fixture.database.all(
      'SELECT direction, remote_path, display_file_name, size_bytes, transferred_bytes, overwrite_confirmed, status, error_message FROM sftp_transfers ORDER BY started_at, id',
    );
    assert.deepEqual(transfers, [
      {
        direction: 'upload',
        remote_path: '/tmp/existing.txt',
        display_file_name: 'local-secret-marker.txt',
        size_bytes: Buffer.byteLength(FILE_CONTENT_MARKER),
        transferred_bytes: Buffer.byteLength(FILE_CONTENT_MARKER),
        overwrite_confirmed: 1,
        status: 'succeeded',
        error_message: null,
      },
    ]);
    const persisted = JSON.stringify({
      transfers: fixture.database.all('SELECT * FROM sftp_transfers'),
      audit: fixture.database.all('SELECT * FROM audit_events'),
    });
    assert.equal(persisted.includes(FILE_CONTENT_MARKER), false);
    assert.equal(persisted.includes(PASSWORD_MARKER), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP upload passes non-overwrite intent to the mutation adapter for new files', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndOpen(fixture);
    fixture.transport.sftp.statErrorsByPath.set(
      '/tmp/new-file.txt',
      Object.assign(new Error('missing'), { code: 'SFTP_STAT_FAILED' }),
    );

    await fixture.service.upload(ready.session.id, {
      remotePath: '/tmp/new-file.txt',
      fileName: 'new-file.txt',
      stream: Readable.from(['new-body']),
      sizeBytes: 8,
      confirmOverwrite: false,
    });

    assert.deepEqual(fixture.transport.mutations.uploadCalls, [{
      remotePath: '/tmp/new-file.txt',
      options: { overwrite: false },
      body: 'new-body',
    }]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP mkdir and rename normalize paths and record metadata-only operations', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndOpen(fixture);

    const mkdir = await fixture.service.mkdir(ready.session.id, '/tmp//opsdog');
    const rename = await fixture.service.rename(ready.session.id, '/tmp/opsdog/a.txt', '/tmp/opsdog/b.txt');

    assert.deepEqual(mkdir, { path: '/tmp/opsdog', status: 'succeeded' });
    assert.deepEqual(rename, { fromPath: '/tmp/opsdog/a.txt', toPath: '/tmp/opsdog/b.txt', status: 'succeeded' });
    assert.deepEqual(fixture.transport.mutations.mkdirCalls, ['/tmp/opsdog']);
    assert.deepEqual(fixture.transport.mutations.renameCalls, [['/tmp/opsdog/a.txt', '/tmp/opsdog/b.txt']]);

    await assert.rejects(
      fixture.service.rename(ready.session.id, '', '/tmp/opsdog/c.txt'),
      (error) => error.code === 'SFTP_PATH_INVALID',
    );

    const operations = fixture.database.all(
      `SELECT operation_type, remote_path, destination_path, confirmation_required,
              confirmation_received, status, error_message
         FROM sftp_operations
        WHERE operation_type IN ('mkdir', 'rename')
        ORDER BY started_at, id`,
    );
    assert.deepEqual(operations, [
      {
        operation_type: 'mkdir',
        remote_path: '/tmp/opsdog',
        destination_path: null,
        confirmation_required: 1,
        confirmation_received: 1,
        status: 'succeeded',
        error_message: null,
      },
      {
        operation_type: 'rename',
        remote_path: '/tmp/opsdog/a.txt',
        destination_path: '/tmp/opsdog/b.txt',
        confirmation_required: 1,
        confirmation_received: 1,
        status: 'succeeded',
        error_message: null,
      },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP delete is file-only and never calls recursive deletion helpers', async () => {
  const fixture = createFixture();
  try {
    const ready = await trustAndOpen(fixture);
    fixture.transport.sftp.attrsByPath.set('/tmp/folder', {
      size: 0,
      mode: 0o040755,
      mtime: 1770000000,
      isDirectory: () => true,
      isFile: () => false,
    });

    await assert.rejects(
      fixture.service.deleteFile(ready.session.id, '/tmp/folder'),
      (error) => error.code === 'SFTP_DELETE_DIRECTORY_UNSUPPORTED',
    );
    assert.equal(fixture.transport.mutations.recursiveDeleteCalled, false);
    assert.equal(fixture.transport.mutations.rmdirCalled, false);
    assert.deepEqual(fixture.transport.mutations.deleteFileCalls, []);

    const deleted = await fixture.service.deleteFile(ready.session.id, '/tmp/file.txt');

    assert.deepEqual(deleted, { path: '/tmp/file.txt', status: 'succeeded' });
    assert.deepEqual(fixture.transport.mutations.deleteFileCalls, ['/tmp/file.txt']);
    const operations = fixture.database.all(
      `SELECT operation_type, remote_path, confirmation_required, confirmation_received, status, error_message
         FROM sftp_operations
        WHERE operation_type = 'delete'
        ORDER BY started_at, id`,
    );
    assert.deepEqual(operations, [
      {
        operation_type: 'delete',
        remote_path: '/tmp/folder',
        confirmation_required: 1,
        confirmation_received: 1,
        status: 'failed',
        error_message: 'SFTP_DELETE_DIRECTORY_UNSUPPORTED',
      },
      {
        operation_type: 'delete',
        remote_path: '/tmp/file.txt',
        confirmation_required: 1,
        confirmation_received: 1,
        status: 'succeeded',
        error_message: null,
      },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SFTP mutation methods require an active session and hide raw remote errors', async () => {
  const fixture = createFixture();
  try {
    for (const operation of [
      () => fixture.service.upload('missing-session', {
        remotePath: '/tmp/file.txt',
        fileName: 'file.txt',
        stream: Readable.from(['body']),
        sizeBytes: 4,
        confirmOverwrite: true,
      }),
      () => fixture.service.mkdir('missing-session', '/tmp/new-dir'),
      () => fixture.service.rename('missing-session', '/tmp/a', '/tmp/b'),
      () => fixture.service.deleteFile('missing-session', '/tmp/a'),
    ]) {
      await assert.rejects(operation(), (error) => error.code === 'SFTP_SESSION_CLOSED');
    }

    const ready = await trustAndOpen(fixture);
    fixture.transport.mutations.nextError = new Error('raw server output with secret details');
    await assert.rejects(
      fixture.service.mkdir(ready.session.id, '/tmp/raw-error'),
      (error) => error.code === 'SFTP_MKDIR_FAILED' && !error.message.includes('raw server output'),
    );
    const persisted = JSON.stringify({
      operations: fixture.database.all('SELECT * FROM sftp_operations'),
      audit: fixture.database.all('SELECT * FROM audit_events'),
    });
    assert.equal(persisted.includes('raw server output'), false);
  } finally {
    cleanupFixture(fixture);
  }
});
