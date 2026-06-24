import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

const fakeMcpServerSource = `
let buffer = Buffer.alloc(0);

const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(Buffer.concat([
    Buffer.from(\`Content-Length: \${body.length}\\r\\n\\r\\n\`, 'ascii'),
    body,
  ]));
};

const handleMessage = (message) => {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-filesystem', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') {
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'read_file',
          description: 'Read a file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        }],
      },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not found' },
  });
};

const pump = () => {
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline === -1) return;

    const body = buffer.slice(0, newline).toString('utf8').replace(/\\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!body.trim()) continue;
    handleMessage(JSON.parse(body));
  }
};

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
`;

test('stdio MCP connection parses Content-Length responses from MCP servers', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opsdog-mcp-stdio-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const serverPath = path.join(tempDir, 'fake-mcp-server.mjs');
  await writeFile(serverPath, fakeMcpServerSource, 'utf8');

  const moduleUrl = pathToFileURL(path.join(PROJECT_ROOT, 'server/src/mcpStdio.js')).href;
  const { createStdioMcpConnection } = await import(moduleUrl);

  const connection = await createStdioMcpConnection({
    name: 'fake-filesystem',
    command: process.execPath,
    args: [serverPath],
    timeoutMs: 500,
  });
  t.after(() => connection.close());

  assert.equal(connection.connected, true);
  assert.equal(connection.toolCount, 1);
  assert.equal(connection.tools[0].name, 'read_file');
  assert.equal(connection.tools[0].riskLevel, 'read-only');
});
