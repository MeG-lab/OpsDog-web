import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('frontend config normalization keeps empty runtime config safe for startup', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'src/services/persistence.ts'), 'utf8');

  assert.match(source, /const rawLlmConfigs = raw\.llmConfigs \?\? raw\.llm_configs/);
  assert.match(source, /llmConfigs:\s*Array\.isArray\(rawLlmConfigs\)\s*\?\s*rawLlmConfigs\s*:\s*\[\]/);
  assert.match(source, /managedTaskConfigs:\s*isRecord\(rawManagedTaskConfigs\)\s*\?\s*rawManagedTaskConfigs\s*:\s*\{\}/);
  assert.match(source, /activeWorkspace:\s*normalizeActiveWorkspace\(rawActiveWorkspace\)/);
  assert.match(source, /value === 'settings'/);
  assert.match(source, /value === 'more'/);
  assert.doesNotMatch(source, /llmConfigs:\s*raw\.llmConfigs \?\? raw\.llm_configs/);
});
