import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAppAuthService } from '../../src/appAuthService.js';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

const withAuthFixture = (work, options = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-app-auth-'));
  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  try {
    applyMigrations(database, { now: () => '2026-06-15T00:00:00.000Z' });
    const service = createAppAuthService({
      database,
      authFilePath: path.join(root, 'auth.json'),
      defaultUsername: options.defaultUsername || 'admin',
      defaultPassword: options.defaultPassword || 'opsDog2026!!',
      now: options.now || (() => '2026-06-15T00:00:00.000Z'),
      createId: (() => {
        let next = 0;
        return (prefix) => `${prefix}-${++next}`;
      })(),
      createSessionToken: (() => {
        let next = 0;
        return () => `session-token-${++next}`;
      })(),
      sessionTtlMs: 60 * 60 * 1000,
    });
    return work({ root, database, service });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
};

test('app auth seeds the first admin user and stores only password hashes', () => {
  withAuthFixture(({ database, service }) => {
    service.ensureSeedUser();

    const users = service.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'admin');
    assert.equal(users[0].enabled, true);

    const rawRow = database.get('SELECT username, password_hash, salt FROM users WHERE username = ?', 'admin');
    assert.equal(rawRow.username, 'admin');
    assert.ok(rawRow.password_hash);
    assert.ok(rawRow.salt);
    assert.doesNotMatch(JSON.stringify(rawRow), /opsDog2026!!/);
  });
});

test('app auth imports an existing auth.json record when the user table is empty', () => {
  withAuthFixture(({ root, service }) => {
    const authFilePath = path.join(root, 'auth.json');
    const legacyRecord = {
      username: 'legacy-admin',
      salt: 'legacy-salt',
      passwordHash: 'legacy-hash',
      iterations: 120000,
      digest: 'sha256',
      updatedAt: '2026-06-14T00:00:00.000Z',
    };
    writeFileSync(authFilePath, `${JSON.stringify(legacyRecord, null, 2)}\n`, 'utf8');

    service.ensureSeedUser();

    const raw = readFileSync(authFilePath, 'utf8');
    assert.match(raw, /legacy-admin/);
    const users = service.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'legacy-admin');
  });
});

test('app auth login issues a revocable session token and rejects disabled users', () => {
  withAuthFixture(({ service }) => {
    service.ensureSeedUser();

    const login = service.login({ username: 'admin', password: 'opsDog2026!!' }, {
      userAgent: 'node-test',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(login.ok, true);
    assert.equal(login.sessionToken, 'session-token-1');
    assert.equal(login.user.username, 'admin');

    const session = service.authenticateSessionToken('session-token-1');
    assert.equal(session?.user.username, 'admin');

    service.logout('session-token-1');
    assert.equal(service.authenticateSessionToken('session-token-1'), null);

    const disabled = service.createUser({ username: 'disabled-user', password: 'new-password-2026' });
    service.updateUser(disabled.id, { enabled: false });
    assert.equal(service.login({ username: 'disabled-user', password: 'new-password-2026' }).ok, false);
  });
});

test('app auth manages multiple users and protects the final enabled account', () => {
  withAuthFixture(({ service }) => {
    service.ensureSeedUser();
    const second = service.createUser({ username: 'operator', password: 'operator-password-2026' });

    assert.throws(
      () => service.createUser({ username: 'operator', password: 'another-password-2026' }),
      /用户名已存在/,
    );

    service.updateUser(second.id, { username: 'operator-renamed', enabled: false });
    assert.equal(service.listUsers().find((user) => user.id === second.id)?.username, 'operator-renamed');
    assert.equal(service.login({ username: 'operator-renamed', password: 'operator-password-2026' }).ok, false);

    const admin = service.listUsers().find((user) => user.username === 'admin');
    assert.throws(
      () => service.updateUser(admin.id, { enabled: false }),
      /至少保留一个启用账号/,
    );

    service.resetUserPassword(second.id, { newPassword: 'operator-password-reset' });
    service.updateUser(second.id, { enabled: true });
    assert.equal(service.login({ username: 'operator-renamed', password: 'operator-password-reset' }).ok, true);
  });
});

test('app auth changes the current user password without accepting the old password', () => {
  withAuthFixture(({ service }) => {
    service.ensureSeedUser();
    const admin = service.listUsers()[0];

    assert.deepEqual(
      service.changePassword(admin.id, { currentPassword: 'wrong', newPassword: 'new-password-2026' }),
      { ok: false, statusCode: 401, message: '当前密码不正确。' },
    );

    assert.deepEqual(
      service.changePassword(admin.id, { currentPassword: 'opsDog2026!!', newPassword: 'new-password-2026' }),
      { ok: true },
    );

    assert.equal(service.login({ username: 'admin', password: 'opsDog2026!!' }).ok, false);
    assert.equal(service.login({ username: 'admin', password: 'new-password-2026' }).ok, true);
  });
});
