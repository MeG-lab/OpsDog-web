import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('local script server updates can rename to Chinese and persist script source', async () => {
  const originalCwd = process.cwd();
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-script-rename-'));
  try {
    process.chdir(root);
    const instantDir = path.join(root, 'tools', 'script', 'instant');
    await mkdir(instantDir, { recursive: true });
    await writeFile(path.join(instantDir, 'old_task.py'), 'print("old")\n', 'utf8');

    const moduleUrl = `${pathToFileURL(path.join(PROJECT_ROOT, 'server/src/serverRegistry.js')).href}?rename=${Date.now()}`;
    const {
      getServerDefinition,
      updateServerDefinition,
      writeServerDefinition,
    } = await import(moduleUrl);

    await writeServerDefinition({
      id: 'old_task',
      name: 'old_task',
      category: 'instant',
      type: 'python-script',
      runtime: 'python3',
      transport: 'stdio',
      entry: 'tools/script/instant/old_task.py',
      description: 'old description',
      enabled: true,
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
      connection: {},
      capabilities: {
        tools: [{
          name: 'old_task',
          description: 'old description',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
          outputMode: 'json-object',
          execution: 'oneshot',
          schemaSource: 'server-metadata',
          isDefault: true,
        }],
      },
    });

    const updated = await updateServerDefinition('old_task', {
      name: '中文任务',
      script: 'print("new")',
      capabilities: {
        tools: [{
          name: '中文任务',
          description: 'updated description',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
          outputMode: 'json-object',
          execution: 'oneshot',
          schemaSource: 'server-metadata',
          isDefault: true,
        }],
      },
    });

    assert.equal(updated.id, '中文任务');
    assert.equal(updated.name, '中文任务');
    assert.equal(updated.entry, 'tools/script/instant/中文任务.py');
    assert.equal(updated.capabilities.tools[0].name, '中文任务');
    assert.equal(await readFile(path.join(instantDir, '中文任务.py'), 'utf8'), 'print("new")\n');

    await assert.rejects(readFile(path.join(instantDir, 'old_task.server.json'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(instantDir, 'old_task.py'), 'utf8'), { code: 'ENOENT' });

    const reloaded = await getServerDefinition('中文任务');
    assert.equal(reloaded.name, '中文任务');
    assert.equal(reloaded.entry, 'tools/script/instant/中文任务.py');
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
