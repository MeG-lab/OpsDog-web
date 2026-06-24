import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeServerDefinition } from './serverRegistry.js';
import { generateStructuredObject } from './structuredGenerationService.js';

const APP_ROOT = process.cwd();
const TOOLS_ROOT = path.join(APP_ROOT, 'tools');
const SCRIPT_ROOT = path.join(TOOLS_ROOT, 'script');
const PYTHON_BIN = process.env.PYTHON || process.env.PYTHON3 || 'python3';

const nowIso = () => new Date().toISOString();

const execFileAsync = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

const ensureDirectory = async (directory) => {
  await mkdir(directory, { recursive: true });
};

const pathExists = async (targetPath) => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeTaskName = (rawName) =>
  String(rawName || '')
    .trim()
    .replace(/\.py$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

const scriptDirectoryForKind = (kind) =>
  path.join(SCRIPT_ROOT, kind === 'managed' ? 'managed' : 'instant');

const toPosixRelative = (absolutePath) => path.relative(APP_ROOT, absolutePath).split(path.sep).join(path.posix.sep);

const tryParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  throw error;
};

const TASK_DEFINITION_TOOL_NAME = 'create_task_definition';

const buildTaskDefinitionToolSchema = () => ({
  type: 'function',
  function: {
    name: TASK_DEFINITION_TOOL_NAME,
    description: 'Create a complete OpsDog task definition for a local Python task.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'name',
        'description',
        'triggers',
        'script',
        'serverDefinition',
        'validationNotes',
        'riskLevel',
      ],
      properties: {
        kind: {
          type: 'string',
          enum: ['instant', 'managed'],
          description: 'instant for one-shot JSON object tasks, managed for long-running JSON event stream tasks.',
        },
        name: {
          type: 'string',
          description: 'Safe task name using only letters, digits, underscore or dash.',
        },
        description: {
          type: 'string',
          description: 'One-sentence task purpose.',
        },
        triggers: {
          type: 'array',
          description: 'Natural-language intent hints used by OpsDog intent routing.',
          items: { type: 'string' },
        },
        script: {
          type: 'string',
          description: 'Complete executable Python source code. stdout must only emit valid JSON for the selected task kind.',
        },
        serverDefinition: {
          type: 'object',
          description: 'ServerDefinition metadata. OpsDog will normalize id, entry, protocol, category, runtime and timeouts.',
          additionalProperties: true,
          required: ['capabilities'],
          properties: {
            capabilities: {
              type: 'object',
              additionalProperties: true,
              required: ['tools'],
              properties: {
                tools: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    required: ['name', 'description', 'inputSchema'],
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' },
                      inputSchema: {
                        type: 'object',
                        description: 'JSON Schema object for task arguments.',
                        additionalProperties: true,
                      },
                    },
                  },
                },
                inputSchema: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
        },
        validationNotes: {
          type: 'array',
          description: 'Run instructions, acceptance checks, output fields and safety notes.',
          items: { type: 'string' },
        },
        riskLevel: {
          type: 'string',
          enum: ['read-only', 'state-change', 'destructive'],
        },
      },
    },
  },
});

const normalizeRiskLevel = (value) => {
  if (value === 'read-only' || value === 'state-change' || value === 'destructive') return value;
  return 'read-only';
};

const inferKind = (rawKind, preferredKind, prompt) => {
  if (rawKind === 'instant' || rawKind === 'managed') return rawKind;
  if (preferredKind === 'instant' || preferredKind === 'managed') return preferredKind;
  return /(每\s*\d+|间隔|持续|监控|监测|轮询|恢复|告警|连续失败|守护|托管)/.test(String(prompt || ''))
    ? 'managed'
    : 'instant';
};

const defaultToolName = (name) => normalizeTaskName(name) || 'generated_task';

const buildFallbackInputSchema = (kind) => ({
  type: 'object',
  properties: kind === 'managed'
    ? {
        target: { type: 'string', description: '监控目标，例如 IP、主机名、URL 或文件路径。' },
        host: { type: 'string', description: '目标主机或 IP。' },
        port: { type: 'integer', description: '目标端口。' },
        interval: { type: 'integer', description: '轮询间隔秒数。' },
        max_failures: { type: 'integer', description: '连续失败次数阈值。' },
      }
    : {
        input: { type: 'string', description: '任务输入或目标。' },
        path: { type: 'string', description: '需要读取或统计的文件路径。' },
      },
  required: [],
  additionalProperties: true,
});

const normalizeTools = (rawTools, task) => {
  const kind = task.kind;
  const tools = Array.isArray(rawTools) && rawTools.length > 0 ? rawTools : [];
  const normalized = tools
    .filter((tool) => tool && typeof tool === 'object')
    .map((tool, index) => ({
      name: index === 0 ? defaultToolName(task.name) : normalizeTaskName(tool.name) || defaultToolName(task.name),
      description: String(tool.description || task.description || task.name),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : buildFallbackInputSchema(kind),
      outputMode: kind === 'managed' ? 'json-events' : 'json-object',
      execution: kind === 'managed' ? 'managed' : 'oneshot',
      schemaSource: 'server-metadata',
      isDefault: index === 0,
    }));

  return normalized.length > 0
    ? normalized.map((tool, index) => ({ ...tool, isDefault: index === 0 }))
    : [{
        name: defaultToolName(task.name),
        description: task.description || task.name,
        inputSchema: buildFallbackInputSchema(kind),
        outputMode: kind === 'managed' ? 'json-events' : 'json-object',
        execution: kind === 'managed' ? 'managed' : 'oneshot',
        schemaSource: 'server-metadata',
        isDefault: true,
      }];
};

const buildServerDefinition = (task, rawServerDefinition = {}) => {
  const name = normalizeTaskName(task.name);
  const kind = task.kind;
  const scriptPath = path.join(scriptDirectoryForKind(kind), `${name}.py`);
  const capabilities = rawServerDefinition && typeof rawServerDefinition === 'object' && rawServerDefinition.capabilities
    ? rawServerDefinition.capabilities
    : {};
  const tools = normalizeTools(capabilities?.tools, task);

  return {
    id: name,
    name,
    category: kind,
    type: 'python-script',
    runtime: 'python3',
    transport: 'stdio',
    entry: toPosixRelative(scriptPath),
    description: task.description,
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    connection: {},
    capabilities: {
      tools,
      inputSchema: capabilities?.inputSchema && typeof capabilities.inputSchema === 'object'
        ? capabilities.inputSchema
        : tools[0].inputSchema,
      protocol: {
        mode: kind === 'managed' ? 'json-stream' : 'json-tool',
        version: 1,
        io: {
          stdin: 'json',
          stdout: kind === 'managed' ? 'json-events' : 'json-object',
          stderr: 'text',
        },
      },
      schemaSource: 'server-metadata',
      intentHints: task.triggers,
      usageExamples: [
        ...task.triggers,
        ...task.validationNotes,
      ].filter(Boolean).slice(0, 12),
      recentLogs: [],
      timeouts: {
        toolCallMs: kind === 'managed' ? 30000 : 15000,
      },
    },
  };
};

const normalizeGeneratedTask = (rawTask, request = {}) => {
  const raw = rawTask && typeof rawTask === 'object' ? rawTask : {};
  const kind = inferKind(raw.kind, request.preferredKind, request.prompt);
  const name = normalizeTaskName(request.scriptName || raw.name || (kind === 'managed' ? 'ai_managed_task' : 'ai_instant_task'));
  const description = String(raw.description || request.prompt || `${name} task`).trim().slice(0, 500);
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  const validationNotes = Array.isArray(raw.validationNotes)
    ? raw.validationNotes.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : [];
  const normalized = {
    kind,
    name,
    description,
    triggers,
    script: String(raw.script || '').trim(),
    serverDefinition: {},
    validationNotes,
    riskLevel: normalizeRiskLevel(raw.riskLevel),
  };
  normalized.serverDefinition = buildServerDefinition(normalized, raw.serverDefinition);
  return normalized;
};

const buildGenerationSystemPrompt = () => [
  '你是 OpsDog 的 AI 任务生成器。',
  '你必须生成一个完整、可校验、可创建的任务定义，字段为 kind/name/description/triggers/script/serverDefinition/validationNotes/riskLevel。',
  '如果当前模型通道支持结构化输出，按结构化 schema 返回；如果使用工具调用，调用 create_task_definition；如果只能输出 JSON，正文只能是同结构 JSON object。',
  '如果需求不完整，也要返回可预览的任务定义，并把疑问写入 validationNotes。',
  '',
  '托管任务（managed）输出规范 —— 这是最关键的约束，必须严格遵守：',
  '',
  '系统通过读取 stdout 每一行 JSON 的 status 字段来驱动 UI 状态。字段映射关系：',
  '  "status":"running"   → UI 显示"运行中"',
  '  "status":"warning"   → UI 显示"告警中"，触发系统公告和语音通知',
  '  "status":"attention" → UI 显示"需关注"',
  '  "status":"recovered" → UI 显示"已恢复"，触发恢复通知',
  '  "status":"error"     → UI 显示"异常"，触发系统公告',
  '如果 status 字段缺失或值不在上述列表中，UI 状态将永远停留在"运行中"，告警机制完全失效。',
  '',
  '托管任务每行 JSON event 必须包含以下字段：',
  '  time    (string, 必须) ISO8601 格式，如 "2026-05-20T10:30:00Z"',
  '  status  (string, 必须) 取值仅限 running | warning | attention | recovered | error',
  '  level   (string, 必须) 取值仅限 info | warning | error',
  '  message (string, 必须) 人类可读的描述',
  '可选字段：ok(boolean)、target(string)、summary(string)、data(object)、errors(array)',
  '',
  '托管任务完整示例 —— 请严格参照此模板：',
  '',
  '```python',
  'import sys, json, time, subprocess',
  '',
  'payload = {}',
  'raw = sys.stdin.read()',
  'if raw.strip():',
  '    payload = json.loads(raw)',
  'target = payload.get("target", "127.0.0.1")',
  'interval = int(payload.get("interval", 5))',
  'max_failures = int(payload.get("max_failures", 3))',
  'fail_count = 0',
  '',
  'try:',
  '    while True:',
  '        # 执行实际检测逻辑',
  '        ok = True  # 替换为真实检测',
  '        event = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}',
  '        if ok:',
  '            fail_count = 0',
  '            event["status"] = "running"',
  '            event["level"] = "info"',
  '            event["message"] = f"{target} 检测正常"',
  '        else:',
  '            fail_count += 1',
  '            if fail_count >= max_failures:',
  '                event["status"] = "error"',
  '                event["level"] = "error"',
  '                event["message"] = f"{target} 连续失败 {fail_count} 次"',
  '            else:',
  '                event["status"] = "warning"',
  '                event["level"] = "warning"',
  '                event["message"] = f"{target} 检测失败 ({fail_count}/{max_failures})"',
  '        event["target"] = target',
  '        print(json.dumps(event, ensure_ascii=False), flush=True)',
  '        time.sleep(interval)',
  'except KeyboardInterrupt:',
  '    pass',
  '```',
  '',
  '单次任务（instant）输出规范：',
  '- 从 stdin 读取 JSON 入参，stdout 精确输出一个 JSON object。',
  '- 必须字段：ok(boolean)、status(success|warning|error)、summary(string)',
  '- 可选字段：data(object)、highlights(array)、errors(array)',
  '- 示例输出：{"ok":true,"status":"success","summary":"检查通过","data":{...}}',
  '',
  '通用硬性约束：',
  '- 只支持 kind=instant 或 kind=managed。',
  '- 如果用户要求一次性执行、统计、生成报告前的数据采集，选择 instant。',
  '- 只有用户明确要求持续监控、每 N 秒轮询、恢复通知、长期运行时，才选择 managed。',
  '- stdout 只能输出 JSON，不要 print 普通文本、日志或进度信息。诊断日志必须写 stderr。',
  '- 所有 JSON 输出必须使用 json.dumps(..., ensure_ascii=False)，每行 print 必须带 flush=True。',
  '- 脚本必须显式 import 所有使用到的模块（json、sys、time、subprocess 等），不允许遗漏。',
  '- 参数读取：raw = sys.stdin.read(); payload = json.loads(raw) if raw.strip() else {}',
  '- 目标安装环境包含 CentOS 7 / Python 3.6，脚本必须兼容 Python 3.6 语法和标准库参数。',
  '- 不要使用 subprocess.run(..., capture_output=True) 或 text=True；Python 3.6 不支持这些参数。',
  '- 如需捕获命令输出，请使用 subprocess.run([...], shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)。',
  '- 如用户说"不用传参"或"数据写死在脚本里"，inputSchema 必须 properties={}、required=[]、additionalProperties=false。',
  '- 如果用户标注某些目标需要跳过、禁止检测、只记录不执行，脚本必须尊重该语义并在结构化结果中标记 skipped。',
  '- 面向报告生成的任务，data 中必须包含结构化列表和汇总统计。',
  '- 可以使用 Python 标准库；如必须调用外部命令，只能用 subprocess.run([...], shell=False)，并遵守 Python 3.6 参数限制。',
  '- 网络连通性、HTTP/HTTPS 可用性、端口探测任务优先使用 Python 标准库 urllib.request 或 socket.create_connection；不要依赖系统命令 ping 或 curl，因为服务器容器可能没有这些组件。',
  '- 只有用户明确要求 ICMP ping、curl 命令或系统命令行为时，才允许调用 ping/curl；此时脚本必须在命令不存在时输出明确错误 summary/message。',
  '- 不要自动运行，不要写文件到平台目录，不要读取 .env、SSH key、系统敏感文件。',
  '- 不要生成删除文件、格式化磁盘、批量扫描网段、外发敏感数据的代码。',
  '- 如需密钥，只使用环境变量占位，不要把密钥写进脚本。',
  '- serverDefinition 必须是 python-script、stdio，并包含 capabilities.tools[].inputSchema。',
  '- serverDefinition.capabilities.tools[].inputSchema.required 必须只包含真正执行必需的参数。',
  '- 如果某个参数在脚本中用 payload.get("key", defaultValue) 提供了默认值，则该参数不应出现在 required 数组中，且必须在 properties[key] 中添加 "default": defaultValue。',
  '- 不要在 required 中包含有默认值的参数，否则系统会误报"参数缺失"导致任务不可用。',
  '- 不要生成额外绑定文件；自然语言提示只写入 ServerDefinition.capabilities.intentHints 和 usageExamples。',
  '- validationNotes 写运行方式、验收方式、输出字段说明和安全边界。',
].join('\n');

const buildGenerationUserPrompt = ({ prompt, preferredKind, scriptName }) => [
  '请根据下面的用户需求生成完整任务定义。',
  `用户偏好任务类型：${preferredKind || 'auto'}`,
  `用户指定脚本名称：${String(scriptName || '').trim() || '未指定'}`,
  '',
  '参数填写要求：',
  '- name 必须采用“用户指定脚本名称”；如果用户未指定，生成简短名称。',
  '- 允许中文、字母、数字、下划线和连字符；不要把中文名称翻译成英文。',
  '- description 用一句话说明任务目的。',
  '- triggers 生成 3 到 6 条中文自然语言触发提示。',
  '- serverDefinition 只需提供 capabilities.tools，系统会补齐 entry/protocol 等运行字段。',
  '- 代码必须完整可运行，且 stdout 只输出 JSON。',
  '- 不要输出解释文字；结构化通道按 schema 返回，JSON 通道只输出 JSON object。',
  '',
  `用户需求：${String(prompt || '').trim()}`,
].join('\n');

const generateTaskDefinitionWithModel = async (request, sendChat) => {
  const result = await generateStructuredObject({
    schemaName: TASK_DEFINITION_TOOL_NAME,
    schema: buildTaskDefinitionToolSchema().function.parameters,
    description: 'Create a complete OpsDog task definition with Python script and ServerDefinition metadata.',
    systemPrompt: buildGenerationSystemPrompt(),
    userPrompt: buildGenerationUserPrompt(request),
    model: request.model,
    sendChat,
    signal: request.signal,
    maxTokens: Math.min(Math.max(Number(request.model.maxTokens || 4096), 4096), 12000),
    temperature: Math.min(Number(request.model.temperature ?? 0.1), 0.1),
  });
  return {
    task: normalizeGeneratedTask(result.object, request),
    strategy: result.strategy,
    attempts: result.attempts,
  };
};

const detectDangerousScript = (script) => {
  const text = String(script || '');
  const issues = [];
  const destructivePatterns = [
    [/rm\s+-rf\b/, '禁止生成 rm -rf。'],
    [/shutil\.rmtree\s*\(/, '禁止递归删除目录。'],
    [/os\.(remove|unlink|rmdir)\s*\(/, '禁止删除文件或目录。'],
    [/subprocess\.[^(]+\([^)]*shell\s*=\s*True/s, '禁止 subprocess shell=True。'],
    [/\beval\s*\(/, '禁止 eval。'],
    [/\bexec\s*\(/, '禁止 exec。'],
    [/(^|[/'"`])(?:\.env|id_rsa|id_dsa|\.ssh)([/'"`]|\b)/, '禁止读取敏感凭据路径。'],
    [/\/etc\/(shadow|passwd|sudoers)/, '禁止读取系统敏感文件。'],
    [/(masscan|nmap)\b/, '禁止调用批量扫描工具。'],
    [/ip_network\s*\([^)]*\/\d{1,2}/, '禁止生成网段扫描任务。'],
  ];

  for (const [pattern, message] of destructivePatterns) {
    if (pattern.test(text)) issues.push(message);
  }
  return issues;
};

const detectOutputCompatibility = (task) => {
  const script = String(task.script || '');
  const errors = [];
  const warnings = [];
  if (!script) return { errors, warnings };

  const importsJsonDumps = /from\s+json\s+import[^\n;]*\bdumps\b/.test(script);
  const hasJsonOutput = /\bjson\.dump[s]?\s*\(/.test(script) || (importsJsonDumps && /\bdumps\s*\(/.test(script));
  const readsJsonStdin = /json\.load\s*\(\s*sys\.stdin\s*\)/.test(script) || /sys\.stdin\.read\s*\(/.test(script);
  const hasPlainTextPrint = /print\s*\(\s*(?:[frFR]{0,2}["'])/.test(script)
    && !/print\s*\(\s*(?:json\.dumps|dumps)\s*\(/.test(script);
  const logsToStdout = /logging\.basicConfig\s*\([^)]*stream\s*=\s*sys\.stdout/s.test(script);

  if (!hasJsonOutput) {
    errors.push('脚本必须使用 json.dumps/json.dump 输出系统可解析的 JSON。');
  }
  if (hasPlainTextPrint) {
    errors.push('stdout 只能输出 JSON，不允许 print 普通文本或未序列化对象。');
  }
  if (logsToStdout) {
    errors.push('日志不能写入 stdout，请写入 stderr，避免破坏 JSON 解析。');
  }
  if (/subprocess\.run\s*\([^)]*\bcapture_output\s*=/s.test(script)) {
    errors.push('CentOS 7 / Python 3.6 不支持 subprocess.run(capture_output=...)；请改用 stdout=subprocess.PIPE 和 stderr=subprocess.PIPE。');
  }
  if (/subprocess\.run\s*\([^)]*\btext\s*=\s*True/s.test(script)) {
    errors.push('CentOS 7 / Python 3.6 不支持 subprocess.run(text=True)；请改用 universal_newlines=True。');
  }
  if (!readsJsonStdin) {
    warnings.push('建议从 stdin 读取 JSON 入参，例如 sys.stdin.read() + json.loads()，以便对话层传参。');
  }

  if (task.kind === 'instant') {
    if (/while\s+True\b/.test(script)) {
      warnings.push('单次任务不建议包含无限循环；如需持续监控请选择托管任务。');
    }
    if (!(/"summary"|'summary'/).test(script) || !(/"status"|'status'/).test(script)) {
      warnings.push('建议单次任务输出包含 status 和 summary 字段，便于系统生成最终回答。');
    }
  }

  if (task.kind === 'managed') {
    if (!/while\s+/.test(script)) {
      warnings.push('托管任务通常需要循环输出 JSON event，请确认脚本会持续运行。');
    }
    if (!/flush\s*=\s*True/.test(script) && !/sys\.stdout\.flush\s*\(/.test(script)) {
      errors.push('托管任务必须 flush stdout，确保系统实时接收 json-stream 事件。');
    }
    if (!/time\.sleep\s*\(/.test(script)) {
      warnings.push('托管任务建议使用 time.sleep(interval) 控制轮询间隔。');
    }
    if (!/KeyboardInterrupt/.test(script)) {
      warnings.push('托管任务建议捕获 KeyboardInterrupt，便于用户停止任务。');
    }
    if (!(/"time"|'time'/).test(script) || !(/"message"|'message'/).test(script)) {
      warnings.push('建议托管任务事件包含 time 和 message 字段，便于日志面板展示。');
    }
    if (!(/"level"|'level'/).test(script)) {
      errors.push('托管任务事件必须包含 level 字段（info|warning|error），缺失会导致 UI 无法正确展示事件级别。');
    }
  }

  return { errors, warnings };
};

const detectRiskLevel = (task, errors) => {
  if (errors.length > 0) return 'destructive';
  if (/requests\.(post|put|delete)|urllib\.request|socket\.create_connection/.test(task.script)) {
    return task.kind === 'managed' ? 'state-change' : task.riskLevel;
  }
  return task.riskLevel;
};

const runPythonSyntaxCheck = async (script, name) => {
  const tempDir = path.join(os.tmpdir(), `opsdog-ai-task-${randomUUID()}`);
  const tempPath = path.join(tempDir, `${normalizeTaskName(name) || 'generated_task'}.py`);
  await ensureDirectory(tempDir);
  try {
    await writeFile(tempPath, script, 'utf8');
    await execFileAsync(PYTHON_BIN, [
      '-c',
      'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
      tempPath,
    ], { cwd: tempDir });
    return null;
  } catch (error) {
    return String(error.stderr || error.message || error);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

export const validateAiTask = async ({ task }, options = {}) => {
  const normalized = normalizeGeneratedTask(task || {}, {});
  const errors = [];
  const warnings = [];

  if (!normalized.name || !/^[\p{L}\p{N}_-]+$/u.test(normalized.name)) {
    errors.push('任务名称只能包含中文、字母、数字、下划线或连字符。');
  }
  if (!normalized.description) errors.push('任务说明不能为空。');
  if (!normalized.script) errors.push('Python 脚本不能为空。');

  const dangerIssues = detectDangerousScript(normalized.script);
  errors.push(...dangerIssues);

  const compatibilityIssues = detectOutputCompatibility(normalized);
  errors.push(...compatibilityIssues.errors);
  warnings.push(...compatibilityIssues.warnings);

  if (normalized.script) {
    const syntaxError = await runPythonSyntaxCheck(normalized.script, normalized.name);
    if (syntaxError) {
      errors.push(`Python 语法校验失败：${syntaxError}`);
    }
  }

  const server = normalized.serverDefinition;
  if (server.type !== 'python-script') errors.push('serverDefinition.type 必须是 python-script。');
  if (server.category !== normalized.kind) errors.push('serverDefinition.category 必须和任务类型一致。');
  if (server.transport !== 'stdio') errors.push('serverDefinition.transport 必须是 stdio。');
  if (!server.entry.endsWith(`${normalized.name}.py`)) errors.push('serverDefinition.entry 必须指向生成的 Python 脚本。');
  if (!Array.isArray(server.capabilities?.tools) || server.capabilities.tools.length === 0) {
    errors.push('serverDefinition.capabilities.tools 至少需要一个工具。');
  }
  const protocolMode = server.capabilities?.protocol?.mode;
  const firstTool = server.capabilities?.tools?.[0] || {};
  if (normalized.kind === 'managed' && (protocolMode !== 'json-stream' || firstTool.outputMode !== 'json-events')) {
    errors.push('托管任务必须使用 json-stream/json-events。');
  }
  if (normalized.kind === 'instant' && (protocolMode !== 'json-tool' || firstTool.outputMode !== 'json-object')) {
    errors.push('单次任务必须使用 json-tool/json-object。');
  }

  if (options.checkDuplicate && normalized.name) {
    const directory = scriptDirectoryForKind(normalized.kind);
    if (await pathExists(path.join(directory, `${normalized.name}.py`))) {
      errors.push(`已存在同名脚本：${normalized.name}.py。`);
    }
    if (await pathExists(path.join(directory, `${normalized.name}.server.json`))) {
      errors.push(`已存在同名 ServerDefinition：${normalized.name}.server.json。`);
    }
  }

  if (!normalized.triggers.length) warnings.push('未生成自然语言提示，意图识别可能不够明确。');
  if (!normalized.validationNotes.length) warnings.push('未生成运行或验收说明。');

  normalized.riskLevel = detectRiskLevel(normalized, dangerIssues);
  normalized.validationNotes = Array.from(new Set([...normalized.validationNotes, ...warnings]));
  normalized.serverDefinition = buildServerDefinition(normalized, normalized.serverDefinition);

  return {
    task: normalized,
    valid: errors.length === 0 && normalized.riskLevel !== 'destructive',
    errors,
    warnings,
  };
};

export const generateAiTask = async (request = {}, sendChat) => {
  const prompt = String(request.prompt || '').trim();
  const scriptName = normalizeTaskName(request.scriptName || '');
  if (!prompt) throw new Error('任务需求不能为空。');
  if (request.scriptName !== undefined && !scriptName) throw new Error('脚本名称不能为空。');
  if (!request.model?.provider || !request.model?.apiKey || !request.model?.modelName) {
    throw new Error('缺少可用模型配置。');
  }

  throwIfAborted(request.signal);
  const generated = await generateTaskDefinitionWithModel({ ...request, scriptName }, sendChat);
  throwIfAborted(request.signal);

  const validation = await validateAiTask({ task: generated.task });
  const generationNotes = [
    `结构化生成策略：${generated.strategy}`,
  ];

  return {
    task: {
      ...validation.task,
      validationNotes: Array.from(new Set([
        ...validation.task.validationNotes,
        ...generationNotes,
        ...validation.errors,
      ])),
    },
  };
};

export const createAiTask = async ({ task }) => {
  const validation = await validateAiTask({ task }, { checkDuplicate: true });
  if (!validation.valid) {
    throw new Error(`任务定义校验失败：${validation.errors.join('；') || '风险等级不允许创建'}`);
  }

  const normalized = validation.task;
  const directory = scriptDirectoryForKind(normalized.kind);
  await ensureDirectory(directory);
  const scriptPath = path.join(directory, `${normalized.name}.py`);
  await writeFile(scriptPath, normalized.script.endsWith('\n') ? normalized.script : `${normalized.script}\n`, 'utf8');
  return await writeServerDefinition({
    ...normalized.serverDefinition,
    entry: toPosixRelative(scriptPath),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
};
