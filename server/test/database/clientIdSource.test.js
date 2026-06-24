import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('frontend client ids work on non-secure HTTP origins without crypto.randomUUID', async () => {
  const [idSource, serversSource, storeSource, persistenceSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/utils/createClientId.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Servers/ServersWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/stores/index.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/persistence.ts'), 'utf8'),
  ]);

  assert.match(idSource, /globalThis\.crypto\?\.randomUUID/);
  assert.match(idSource, /Math\.random\(\)\.toString\(36\)/);
  assert.match(serversSource, /createClientId\('asset-device'\)/);
  assert.match(serversSource, /createClientId\('remote-tab'\)/);
  assert.match(storeSource, /createClientId\('conversation'\)/);
  assert.match(persistenceSource, /createClientId\('asset-device'\)/);
  assert.doesNotMatch(serversSource, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(storeSource, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(persistenceSource, /crypto\.randomUUID\(\)/);
});
