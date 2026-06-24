import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalTokenStore } from '../../src/remote/terminalTokenStore.js';

test('terminal token is bound to one profile and consumed once before expiry', () => {
  let now = Date.parse('2026-05-27T08:00:00.000Z');
  const store = createTerminalTokenStore({
    now: () => now,
    createToken: () => 'terminal-token-one',
    ttlMs: 30_000,
  });

  const issued = store.issue({ profileId: 'profile-one', cols: 120, rows: 32 });
  assert.equal(issued.token, 'terminal-token-one');
  assert.equal(issued.expiresAt, '2026-05-27T08:00:30.000Z');
  assert.deepEqual(store.consume(issued.token), {
    profileId: 'profile-one',
    cols: 120,
    rows: 32,
  });
  assert.throws(
    () => store.consume(issued.token),
    (error) => error.code === 'TERMINAL_TOKEN_INVALID' && error.statusCode === 401,
  );

  now += 1;
});

test('terminal token rejects expired values and normalizes bounded initial dimensions', () => {
  let now = 0;
  let sequence = 0;
  const store = createTerminalTokenStore({
    now: () => now,
    createToken: () => `terminal-token-${++sequence}`,
    ttlMs: 100,
  });

  const defaultToken = store.issue({ profileId: 'profile-one' });
  assert.deepEqual(store.consume(defaultToken.token), {
    profileId: 'profile-one',
    cols: 80,
    rows: 24,
  });

  const boundedToken = store.issue({ profileId: 'profile-one', cols: 1000, rows: 1 });
  assert.deepEqual(store.consume(boundedToken.token), {
    profileId: 'profile-one',
    cols: 500,
    rows: 5,
  });

  const expiringToken = store.issue({ profileId: 'profile-one', cols: 20, rows: 200 });
  now = 101;
  assert.throws(
    () => store.consume(expiringToken.token),
    (error) => error.code === 'TERMINAL_TOKEN_INVALID',
  );
});
