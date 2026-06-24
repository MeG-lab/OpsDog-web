import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('frontend renders a login gate before the authenticated workspace', async () => {
  const [appSource, loginSource, runtimeTypesSource, runtimeIndexSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/App.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Auth/LoginPage.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/types.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/index.ts'), 'utf8'),
  ]);

  assert.match(appSource, /getAuthSession/);
  assert.match(appSource, /<LoginPage/);
  assert.match(appSource, /authSession\.authenticated/);
  assert.match(loginSource, /用户名/);
  assert.match(loginSource, /密码/);
  assert.match(loginSource, /系统日志/);
  assert.match(loginSource, /后端/);
  assert.match(runtimeTypesSource, /login\(request/);
  assert.match(runtimeTypesSource, /logout\(\)/);
  assert.match(runtimeTypesSource, /getAuthSession\(\)/);
  assert.match(runtimeIndexSource, /export const login/);
  assert.match(runtimeIndexSource, /export const logout/);
  assert.match(runtimeIndexSource, /export const getAuthSession/);
});

test('web runtime persists config and conversations through backend APIs only', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'src/services/runtime/webRuntime.ts'), 'utf8');

  assert.doesNotMatch(source, /aiops_web_runtime_config/);
  assert.doesNotMatch(source, /aiops_web_runtime_conversations/);
  assert.doesNotMatch(source, /STORAGE_KEYS/);
  assert.match(source, /loadConfig:\s*async \(\) =>/);
  assert.match(source, /safeFetch\(apiUrl\('\/config'\)/);
  assert.match(source, /saveConfig:\s*async \(config\) =>/);
  assert.match(source, /safeFetch\(apiUrl\('\/conversations'\)/);
  assert.match(source, /credentials:\s*'include'/);
});

test('system settings account section exposes basic user management', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'src/components/Settings/SystemSettingsWorkspace.tsx'), 'utf8');

  assert.match(source, /listUsers/);
  assert.match(source, /createUser/);
  assert.match(source, /updateUser/);
  assert.match(source, /resetUserPassword/);
  assert.match(source, /新增账号/);
  assert.match(source, /重置密码/);
  assert.match(source, /停用/);
  assert.match(source, /启用/);
  assert.match(source, /至少保留一个启用账号/);
});
