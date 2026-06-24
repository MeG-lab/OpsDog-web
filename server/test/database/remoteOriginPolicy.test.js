import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteOriginPolicy } from '../../src/remote/remoteOriginPolicy.js';

const requestWithOrigin = (origin) => ({
  headers: origin ? { origin } : {},
});

const requestWithOriginAndHost = (origin, host) => ({
  headers: { origin, host },
});

test('remote origin policy allows configured browser origins and local non-browser clients', () => {
  const policy = createRemoteOriginPolicy({
    allowedOrigins: ['http://127.0.0.1:4175', 'http://127.0.0.1:8788'],
  });

  const web = policy.checkRequest(requestWithOrigin('http://127.0.0.1:4175'));
  assert.equal(web.allowed, true);
  assert.deepEqual(web.corsHeaders, {
    'Access-Control-Allow-Origin': 'http://127.0.0.1:4175',
    Vary: 'Origin',
  });

  const server = policy.checkRequest(requestWithOrigin('http://127.0.0.1:8788'));
  assert.equal(server.allowed, true);
  assert.equal(server.corsHeaders['Access-Control-Allow-Origin'], 'http://127.0.0.1:8788');

  const localClient = policy.checkRequest(requestWithOrigin(null));
  assert.equal(localClient.allowed, true);
  assert.deepEqual(localClient.corsHeaders, {});
});

test('remote origin policy rejects unrelated browser origins with a stable code', () => {
  const policy = createRemoteOriginPolicy({
    allowedOrigins: ['http://127.0.0.1:4175'],
  });

  const rejected = policy.checkRequest(requestWithOrigin('https://example.invalid'));
  assert.deepEqual(rejected, {
    allowed: false,
    code: 'REMOTE_ORIGIN_FORBIDDEN',
    corsHeaders: {},
  });

  assert.throws(
    () => policy.assertRequestAllowed(requestWithOrigin('https://example.invalid')),
    (error) => error.statusCode === 403 && error.code === 'REMOTE_ORIGIN_FORBIDDEN',
  );
});

test('remote origin policy allows same-host browser origin even when server binds 0.0.0.0', () => {
  const policy = createRemoteOriginPolicy({
    allowedOrigins: ['http://0.0.0.0:8788'],
  });

  const result = policy.checkRequest(requestWithOriginAndHost(
    'http://172.16.250.111:8788',
    '172.16.250.111:8788',
  ));

  assert.equal(result.allowed, true);
  assert.equal(result.corsHeaders['Access-Control-Allow-Origin'], 'http://172.16.250.111:8788');
  assert.equal(result.corsHeaders.Vary, 'Origin');
});
