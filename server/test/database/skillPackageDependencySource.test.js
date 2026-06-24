import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('Skill package dependency installer falls back when python venv is unavailable', async () => {
  const registrySource = await readFile(path.join(PROJECT_ROOT, 'server/src/skillPackageRegistry.js'), 'utf8');

  assert.match(registrySource, /installDependenciesWithVenv/);
  assert.match(registrySource, /installDependenciesWithTarget/);
  assert.match(registrySource, /pip',\s*'install',\s*'--target'/);
  assert.match(registrySource, /dependencyInstallMode/);
});

test('Python runner exposes target-installed Skill dependencies through PYTHONPATH', async () => {
  const runnerSource = await readFile(path.join(PROJECT_ROOT, 'server/src/pythonServerRunner.js'), 'utf8');

  assert.match(runnerSource, /capabilities\?\.pythonPath/);
  assert.match(runnerSource, /PYTHONPATH/);
  assert.match(runnerSource, /path\.delimiter/);
  assert.match(runnerSource, /getExecutionEnv\(payload,\s*server\)/);
});

test('Python runner forces UTF-8 output for CentOS ASCII locales', async () => {
  const [runnerSource, installScript, compatSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'server/src/pythonServerRunner.js'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'deploy/linux/install-linux.sh'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'server/src/pythonCompat/sitecustomize.py'), 'utf8'),
  ]);

  assert.match(runnerSource, /PYTHONIOENCODING:\s*'utf-8'/);
  assert.match(runnerSource, /PYTHONUTF8:\s*'1'/);
  assert.match(runnerSource, /pythonCompat/);
  assert.match(runnerSource, /PYTHONPATH/);
  assert.match(installScript, /export PYTHONIOENCODING=utf-8/);
  assert.match(installScript, /export PYTHONUTF8=1/);
  assert.match(compatSource, /subprocess\.run/);
  assert.match(compatSource, /capture_output/);
  assert.match(compatSource, /universal_newlines/);
});
