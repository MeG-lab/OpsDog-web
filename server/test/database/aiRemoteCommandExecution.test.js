import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAiRemoteCommands } from '../../src/remote/aiRemoteRoutes.js';

test('AI remote command execution writes commands into the active terminal session', () => {
  const writes = [];
  const terminalService = {
    write(sessionId, data) {
      writes.push({ sessionId, data });
    },
  };

  const result = executeAiRemoteCommands({
    terminalService,
    sessionId: 'session-1',
    commands: ['uname -a', 'pwd\n'],
  });

  assert.deepEqual(writes, [
    { sessionId: 'session-1', data: 'uname -a\r' },
    { sessionId: 'session-1', data: 'pwd\n' },
  ]);
  assert.equal(result.status, 'executed');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.commandCount, 2);
  assert.equal(result.writtenBytes, Buffer.byteLength('uname -a\rpwd\n', 'utf8'));
});

test('AI remote command execution rejects empty or oversized input', () => {
  assert.throws(
    () => executeAiRemoteCommands({ terminalService: { write() {} }, sessionId: '', commands: ['pwd'] }),
    /sessionId/,
  );
  assert.throws(
    () => executeAiRemoteCommands({ terminalService: { write() {} }, sessionId: 'session-1', commands: [] }),
    /command/,
  );
  assert.throws(
    () => executeAiRemoteCommands({
      terminalService: { write() {} },
      sessionId: 'session-1',
      commands: ['x'.repeat(70000)],
    }),
    /too large/,
  );
});
