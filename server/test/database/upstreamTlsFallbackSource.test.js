import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('upstream TLS fallback includes self-signed certificate chain errors', async () => {
  const [serverSource, ticketingSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'server/src/index.js'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'server/src/ticketingMcp.js'), 'utf8'),
  ]);

  for (const source of [serverSource, ticketingSource]) {
    assert.match(source, /SELF_SIGNED_CERT_IN_CHAIN/);
    assert.match(source, /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
    assert.match(source, /fetchWithTlsFallback/);
    assert.match(source, /curlRequest/);
  }
});
