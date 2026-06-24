import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('scripts workspace requires a custom AI script name and sends it to generation', async () => {
  const [workspaceSource, contractsSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Scripts/ScriptsWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/contracts.ts'), 'utf8'),
  ]);

  assert.match(workspaceSource, /aiTaskName/);
  assert.match(workspaceSource, />脚本名称</);
  assert.match(workspaceSource, /scriptName:\s*name/);
  assert.match(workspaceSource, /脚本名称不能为空|请填写脚本名称/);
  assert.match(contractsSource, /scriptName\??:\s*string/);
});

test('scripts workspace can edit Python source while configuring invocation', async () => {
  const [workspaceSource, runtimeTypesSource, webRuntimeSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Scripts/ScriptsWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/types.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/webRuntime.ts'), 'utf8'),
  ]);

  assert.match(workspaceSource, /scriptText/);
  assert.match(workspaceSource, /Python 脚本内容/);
  assert.match(workspaceSource, /getServerScript/);
  assert.match(workspaceSource, /script:\s*capabilityDraft\.scriptText/);
  assert.match(runtimeTypesSource, /getServerScript/);
  assert.match(webRuntimeSource, /\/script/);
});

test('scripts workspace can rename local tasks while configuring invocation', async () => {
  const workspaceSource = await readFile(path.join(PROJECT_ROOT, 'src/components/Scripts/ScriptsWorkspace.tsx'), 'utf8');

  assert.match(workspaceSource, /name:\s*server\.name/);
  assert.match(workspaceSource, />任务名称</);
  assert.match(workspaceSource, /name:\s*capabilityDraft\.name\.trim\(\)/);
  assert.match(workspaceSource, /setSelectedId\(updated\.id\)/);
  assert.match(workspaceSource, /setSelectedSnapshot\(updated\)/);
});

test('scripts workspace exposes duplicate action for local task servers', async () => {
  const [workspaceSource, runtimeTypesSource, webRuntimeSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Scripts/ScriptsWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/types.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/webRuntime.ts'), 'utf8'),
  ]);

  assert.match(workspaceSource, /duplicateServer/);
  assert.match(workspaceSource, />复制</);
  assert.match(workspaceSource, /Copy size=\{14\}/);
  assert.match(runtimeTypesSource, /duplicateServer/);
  assert.match(webRuntimeSource, /\/duplicate/);
});
