import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('message list jumps to latest message without smooth scroll animation', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'src/components/Chat/MessageList.tsx'), 'utf8');

  assert.match(source, /scrollIntoView/);
  assert.match(source, /behavior:\s*'auto'/);
  assert.doesNotMatch(source, /behavior:\s*['"]smooth['"]/);
});
