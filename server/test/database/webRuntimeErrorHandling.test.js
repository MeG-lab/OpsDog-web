import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('web runtime hides JSON parser failures when API error bodies are empty', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'src/services/runtime/webRuntime.ts'), 'utf8');

  assert.match(source, /const buildError = async \(response: Response\): Promise<never> =>/);
  assert.match(source, /JSON\.parse\(body\)/);
  assert.match(source, /API returned \$\{response\.status\}/);
  assert.match(source, /error instanceof SyntaxError/);
  assert.doesNotMatch(source, /Unexpected end of JSON input/);
});
