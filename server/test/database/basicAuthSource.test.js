import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath) => readFileSync(
  path.resolve(import.meta.dirname, '../../..', relativePath),
  'utf8',
);

test('server protects APIs with HttpOnly cookie sessions instead of Basic Auth', () => {
  const source = readSource('server/src/index.js');
  const authBlock = source.slice(
    source.indexOf('const authCookieName'),
    source.indexOf('const getOpenAIBaseUrl'),
  );
  const serverBlock = source.slice(
    source.indexOf('const server = createServer'),
    source.indexOf('await ensureMergedAssetsReady'),
  );
  const upgradeBlock = source.slice(source.indexOf("server.on('upgrade'"));

  assert.match(source, /createAppAuthService/);
  assert.match(authBlock, /opsdog_session/);
  assert.match(authBlock, /HttpOnly/);
  assert.match(authBlock, /SameSite=Lax/);
  assert.doesNotMatch(authBlock, /WWW-Authenticate/);
  assert.doesNotMatch(authBlock, /Basic realm/);
  assert.doesNotMatch(authBlock, /isAuthorizationValid/);
  assert.match(authBlock, /\/api\/health/);
  assert.match(serverBlock, /if \(!authorizeSessionRequest\(req, res\)\) \{/);
  assert.match(serverBlock, /req\.method === 'POST' && req\.url === '\/api\/auth\/login'/);
  assert.match(serverBlock, /req\.method === 'POST' && req\.url === '\/api\/auth\/logout'/);
  assert.match(serverBlock, /req\.method === 'GET' && req\.url === '\/api\/auth\/session'/);
  assert.match(serverBlock, /req\.method === 'PATCH' && req\.url === '\/api\/auth\/password'/);
  assert.match(upgradeBlock, /authorizeSessionUpgrade/);
});
