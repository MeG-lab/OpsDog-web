import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('remote terminal close events are propagated to the browser websocket', async () => {
  const [sshService, telnetService, websocket] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'server/src/remote/sshTerminalService.js'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'server/src/remote/telnetTerminalService.js'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'server/src/remote/terminalWebSocket.js'), 'utf8'),
  ]);

  for (const service of [sshService, telnetService]) {
    assert.match(service, /onClose\(listener\)/);
    assert.match(service, /terminal\.onClose\(listener\)/);
  }

  assert.match(websocket, /removeCloseListener/);
  assert.match(websocket, /terminal\.onClose/);
  assert.match(websocket, /remote_closed/);
  assert.match(websocket, /closeTerminalSocket\('remote_closed'\)/);
});
