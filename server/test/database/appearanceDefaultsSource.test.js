import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('first launch defaults to the light white appearance without following the OS theme', async () => {
  const [html, appearance, persistence, store] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'index.html'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/stores/appearance.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/persistence.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/stores/index.ts'), 'utf8'),
  ]);

  assert.match(html, /localStorage\.getItem\('aiops_theme'\) \|\| 'light'/);
  assert.match(html, /applyAppearance\('light', 'white'\)/);
  assert.doesNotMatch(html, /prefers-color-scheme/);

  assert.match(appearance, /if \(typeof window === 'undefined'\) return 'light'/);
  assert.match(appearance, /return savedTheme === 'dark' \? 'dark' : 'light'/);

  assert.match(persistence, /theme: 'light'/);
  assert.match(store, /applyAppearance\(config\.theme \?\? 'light', config\.backgroundPreset \?\? DEFAULT_BACKGROUND_PRESET\)/);
});
