import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('AI task generation prefers Python standard-library connectivity checks over external ping or curl', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'server/src/aiTaskRegistry.js'), 'utf8');

  assert.match(source, /连通性|HTTP/);
  assert.match(source, /urllib\.request|socket\.create_connection/);
  assert.match(source, /不要依赖系统命令\s+ping\s+或\s+curl|避免依赖系统命令\s+ping\s+\/\s+curl/);
});

test('AI task generation avoids Python 3.7-only subprocess arguments for CentOS 7', async () => {
  const source = await readFile(path.join(PROJECT_ROOT, 'server/src/aiTaskRegistry.js'), 'utf8');
  const moduleUrl = pathToFileURL(path.join(PROJECT_ROOT, 'server/src/aiTaskRegistry.js')).href;
  const { validateAiTask } = await import(moduleUrl);

  assert.match(source, /CentOS 7/);
  assert.match(source, /Python 3\.6/);
  assert.match(source, /不要使用 subprocess\.run\([^)]*capture_output=True/);
  assert.match(source, /stdout=subprocess\.PIPE/);
  assert.match(source, /stderr=subprocess\.PIPE/);
  assert.match(source, /universal_newlines=True/);

  const validation = await validateAiTask({
    task: {
      kind: 'instant',
      name: 'capture_output_test',
      description: '验证不兼容 subprocess 参数。',
      triggers: ['测试不兼容参数'],
      script: [
        'import json',
        'import subprocess',
        'result = subprocess.run(["echo", "ok"], capture_output=True, text=True)',
        'print(json.dumps({"ok": True, "status": "success", "summary": result.stdout}, ensure_ascii=False))',
      ].join('\n'),
      serverDefinition: {
        capabilities: {
          tools: [{
            name: 'capture_output_test',
            description: '验证不兼容 subprocess 参数。',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          }],
        },
      },
      validationNotes: ['输出 JSON。'],
      riskLevel: 'read-only',
    },
  });

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /capture_output|text=True|Python 3\.6/);
});

test('AI task validation supports Chinese script and tool names', async () => {
  const moduleUrl = pathToFileURL(path.join(PROJECT_ROOT, 'server/src/aiTaskRegistry.js')).href;
  const { validateAiTask } = await import(moduleUrl);

  const validation = await validateAiTask({
    task: {
      kind: 'instant',
      name: '百度连通性检查',
      description: '检查百度连通性。',
      triggers: ['测试百度连通性'],
      script: [
        'import json',
        'import sys',
        'raw = sys.stdin.read()',
        'payload = json.loads(raw) if raw.strip() else {}',
        'print(json.dumps({"ok": True, "status": "success", "summary": "正常"}, ensure_ascii=False))',
      ].join('\n'),
      serverDefinition: {
        capabilities: {
          tools: [{
            name: '百度连通性检查',
            description: '检查百度连通性。',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          }],
        },
      },
      validationNotes: ['输出 JSON。'],
      riskLevel: 'read-only',
    },
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.task.name, '百度连通性检查');
  assert.equal(validation.task.serverDefinition.id, '百度连通性检查');
  assert.equal(validation.task.serverDefinition.capabilities.tools[0].name, '百度连通性检查');
});
