import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBasicAuthService } from '../../src/basicAuthService.js';

const basicHeader = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const createFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-basic-auth-'));
  const authFilePath = path.join(root, 'auth.json');
  const service = createBasicAuthService({
    authFilePath,
    defaultUsername: 'admin',
    defaultPassword: 'opsDog2026!!',
  });

  return {
    root,
    authFilePath,
    service,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test('basic auth service uses the default password before a local password exists', () => {
  const fixture = createFixture();
  try {
    assert.equal(fixture.service.isAuthorizationValid(basicHeader('admin', 'opsDog2026!!')), true);
    assert.equal(fixture.service.isAuthorizationValid(basicHeader('admin', 'wrong-password')), false);
    assert.equal(fixture.service.isAuthorizationValid(basicHeader('operator', 'opsDog2026!!')), false);
  } finally {
    fixture.cleanup();
  }
});

test('basic auth password changes persist a hash and invalidate the previous password', () => {
  const fixture = createFixture();
  try {
    assert.equal(
      fixture.service.changePassword({
        currentPassword: 'wrong-password',
        newPassword: 'new-password-2026',
      }).ok,
      false,
    );

    const result = fixture.service.changePassword({
      currentPassword: 'opsDog2026!!',
      newPassword: 'new-password-2026',
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(fixture.service.isAuthorizationValid(basicHeader('admin', 'opsDog2026!!')), false);
    assert.equal(fixture.service.isAuthorizationValid(basicHeader('admin', 'new-password-2026')), true);

    const stored = readFileSync(fixture.authFilePath, 'utf8');
    assert.doesNotMatch(stored, /opsDog2026!!/);
    assert.doesNotMatch(stored, /new-password-2026/);
    assert.match(stored, /passwordHash/);
    assert.match(stored, /salt/);
  } finally {
    fixture.cleanup();
  }
});

test('basic auth password rejects short replacements', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(
      fixture.service.changePassword({
        currentPassword: 'opsDog2026!!',
        newPassword: 'short',
      }),
      { ok: false, statusCode: 400, message: '新密码至少需要 8 位。' },
    );
  } finally {
    fixture.cleanup();
  }
});
