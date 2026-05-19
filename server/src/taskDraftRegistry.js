import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeServerDefinition } from './serverRegistry.js';

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
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
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

const extractJsonObject = (text) => {
  const trimmed = String(text || '').trim();
  const direct = tryParseJson(trimmed);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParseJson(trimmed.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  return null;
};

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

const normalizeTools = (rawTools, draft) => {
  const kind = draft.kind;
  const tools = Array.isArray(rawTools) && rawTools.length > 0 ? rawTools : [];
  const normalized = tools
    .filter((tool) => tool && typeof tool === 'object')
    .map((tool, index) => ({
      name: normalizeTaskName(tool.name) || defaultToolName(draft.name),
      description: String(tool.description || draft.description || draft.name),
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
        name: defaultToolName(draft.name),
        description: draft.description || draft.name,
        inputSchema: buildFallbackInputSchema(kind),
        outputMode: kind === 'managed' ? 'json-events' : 'json-object',
        execution: kind === 'managed' ? 'managed' : 'oneshot',
        schemaSource: 'server-metadata',
        isDefault: true,
      }];
};

const buildServerDefinition = (draft, rawServerDefinition = {}) => {
  const name = normalizeTaskName(draft.name);
  const kind = draft.kind;
  const scriptPath = path.join(scriptDirectoryForKind(kind), `${name}.py`);
  const capabilities = rawServerDefinition && typeof rawServerDefinition === 'object' && rawServerDefinition.capabilities
    ? rawServerDefinition.capabilities
    : {};
  const tools = normalizeTools(capabilities?.tools, draft);

  return {
    id: name,
    name,
    category: kind,
    type: 'python-script',
    runtime: 'python3',
    transport: 'stdio',
    entry: toPosixRelative(scriptPath),
    description: draft.description,
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
      legacyIntentHints: draft.triggers,
      usageExamples: [
        ...draft.triggers,
        ...draft.validationNotes,
      ].filter(Boolean).slice(0, 12),
      recentLogs: [],
      timeouts: {
        toolCallMs: kind === 'managed' ? 30000 : 15000,
      },
    },
  };
};

const buildSkillYamlPreview = (draft) => [
  '# 旧版 skill.yaml 不会写入磁盘',
  '# AI 任务生成器只创建 .py 和 .server.json。',
  '# 下列自然语言提示会写入 ServerDefinition.capabilities.legacyIntentHints。',
  `name: ${draft.name}`,
  'triggers:',
  ...(draft.triggers.length > 0 ? draft.triggers : [draft.name]).map((trigger) => `  - ${trigger}`),
].join('\n');

const normalizeDraft = (rawDraft, request = {}) => {
  const raw = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};
  const kind = inferKind(raw.kind, request.preferredKind, request.prompt);
  const name = normalizeTaskName(raw.name || (kind === 'managed' ? 'ai_managed_task' : 'ai_instant_task'));
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
    skillYaml: '',
    validationNotes,
    riskLevel: normalizeRiskLevel(raw.riskLevel),
  };
  normalized.serverDefinition = buildServerDefinition(normalized, raw.serverDefinition);
  normalized.skillYaml = buildSkillYamlPreview(normalized);
  return normalized;
};

const buildGenerationPrompt = ({ prompt, preferredKind }) => [
  '你是 OpsDog 的 AI 任务生成器，只能生成 Python 本地任务草案。',
  '必须只返回一个 JSON 对象，不要 Markdown，不要解释。',
  '目标：把用户自然语言需求编译为结构化 AiTaskDraft。',
  '',
  '硬性约束：',
  '- 只支持 kind=instant 或 kind=managed。',
  '- Python 脚本必须兼容 OpsDog stdio 协议：stdin 是 JSON，stdout 只能输出系统可解析的 JSON，诊断日志只能写 stderr。',
  '- instant 脚本必须从 stdin 读取 JSON，stdout 精确输出一个 JSON object，不要输出普通文本、进度日志或多段 JSON。',
  '- instant 输出推荐字段：ok(boolean)、status(success|warning|error|attention)、summary(string)、data(object)、highlights(array)、errors(array)。',
  '- managed 脚本必须从 stdin 读取 JSON 配置，长期运行并逐行输出 JSON event，每行一个完整 JSON object。',
  '- managed 输出推荐字段：time(ISO8601)、level(info|warning|error)、status(running|warning|attention|recovered|error)、message、ok、target、summary、data、errors。',
  '- managed 每次 print(json.dumps(..., ensure_ascii=False), flush=True)，循环应包含 time.sleep(interval)，并支持 KeyboardInterrupt 优雅退出。',
  '- 所有 JSON 输出必须使用 json.dumps(..., ensure_ascii=False)，不要 print("普通文本") 到 stdout。',
  '- 参数读取推荐使用 raw = sys.stdin.read(); payload = json.loads(raw) if raw.strip() else {}，不要依赖命令行参数。',
  '- 端口检测使用 socket.create_connection((host, port), timeout=...)，不要调用 nmap/masscan 或 shell 命令。',
  '- 不要自动运行，不要写文件到平台目录，不要读取 .env、SSH key、系统敏感文件。',
  '- 不要生成删除文件、格式化磁盘、批量扫描网段、外发敏感数据的代码。',
  '- 如需密钥，只使用环境变量占位，不要把密钥写进脚本。',
  '- serverDefinition 必须是 python-script、stdio，并包含 capabilities.tools[].inputSchema。',
  '- serverDefinition.capabilities.tools[].inputSchema.required 必须只包含真正执行必需的参数；缺参由对话层追问。',
  '- 不要生成旧版 skill.yaml；skillYaml 字段只写不落盘说明。',
  '- validationNotes 写运行方式、验收方式、输出字段说明和安全边界。',
  '',
  'JSON Schema 示例：',
  JSON.stringify({
    kind: preferredKind === 'instant' || preferredKind === 'managed' ? preferredKind : 'instant',
    name: 'snake_case_name',
    description: '任务说明',
    triggers: ['自然语言提示'],
    script: '#!/usr/bin/env python3\nimport json\n...',
    serverDefinition: {
      capabilities: {
        tools: [{
          name: 'snake_case_name',
          description: '工具说明',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true },
        }],
      },
    },
    skillYaml: '旧版 skill.yaml 不会写入磁盘',
    validationNotes: ['运行和验收说明'],
    riskLevel: 'read-only',
  }, null, 2),
  '',
  `用户偏好任务类型：${preferredKind || 'auto'}`,
  `用户需求：${String(prompt || '').trim()}`,
].join('\n');

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

const detectOutputCompatibility = (draft) => {
  const script = String(draft.script || '');
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
  if (!readsJsonStdin) {
    warnings.push('建议从 stdin 读取 JSON 入参，例如 sys.stdin.read() + json.loads()，以便对话层传参。');
  }

  if (draft.kind === 'instant') {
    if (/while\s+True\b/.test(script)) {
      warnings.push('单次任务不建议包含无限循环；如需持续监控请选择托管任务。');
    }
    if (!(/"summary"|'summary'/).test(script) || !(/"status"|'status'/).test(script)) {
      warnings.push('建议单次任务输出包含 status 和 summary 字段，便于系统生成最终回答。');
    }
  }

  if (draft.kind === 'managed') {
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
  }

  return { errors, warnings };
};

const detectRiskLevel = (draft, errors) => {
  if (errors.length > 0) return 'destructive';
  if (/requests\.(post|put|delete)|urllib\.request|socket\.create_connection/.test(draft.script)) {
    return draft.kind === 'managed' ? 'state-change' : draft.riskLevel;
  }
  return draft.riskLevel;
};

const runPythonSyntaxCheck = async (script, name) => {
  const tempDir = path.join(os.tmpdir(), `opsdog-task-draft-${randomUUID()}`);
  const tempPath = path.join(tempDir, `${normalizeTaskName(name) || 'draft'}.py`);
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

export const validateTaskDraft = async ({ draft }, options = {}) => {
  const normalized = normalizeDraft(draft || {}, {});
  const errors = [];
  const warnings = [];

  if (!normalized.name || !/^[a-zA-Z0-9_-]+$/.test(normalized.name)) {
    errors.push('任务名称只能包含字母、数字、下划线或连字符。');
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
  if (server.category !== normalized.kind) errors.push('serverDefinition.category 必须和 draft.kind 一致。');
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
  normalized.skillYaml = buildSkillYamlPreview(normalized);

  return {
    draft: normalized,
    valid: errors.length === 0 && normalized.riskLevel !== 'destructive',
    errors,
    warnings,
  };
};

export const generateTaskDraft = async (request = {}, sendChat) => {
  const prompt = String(request.prompt || '').trim();
  if (!prompt) throw new Error('任务需求不能为空。');
  if (!request.model?.provider || !request.model?.apiKey || !request.model?.modelName) {
    throw new Error('缺少可用模型配置。');
  }

  throwIfAborted(request.signal);
  const response = await sendChat({
    messages: [{ role: 'user', content: buildGenerationPrompt(request) }],
    provider: request.model.provider,
    apiKey: request.model.apiKey,
    baseUrl: request.model.baseUrl,
    modelName: request.model.modelName,
    maxTokens: Math.min(Math.max(Number(request.model.maxTokens || 4096), 1024), 8192),
    temperature: Math.min(Number(request.model.temperature ?? 0.2), 0.3),
    signal: request.signal,
  });
  throwIfAborted(request.signal);
  const parsed = extractJsonObject(response.content || '');
  if (!parsed) {
    throw new Error('模型未返回合法 JSON 任务草案。');
  }

  const normalized = normalizeDraft(parsed, request);
  throwIfAborted(request.signal);
  const validation = await validateTaskDraft({ draft: normalized });
  return {
    draft: {
      ...validation.draft,
      validationNotes: Array.from(new Set([...validation.draft.validationNotes, ...validation.errors])),
    },
  };
};

export const createTaskDraft = async ({ draft }) => {
  const validation = await validateTaskDraft({ draft }, { checkDuplicate: true });
  if (!validation.valid) {
    throw new Error(`任务草案校验失败：${validation.errors.join('；') || '风险等级不允许创建'}`);
  }

  const normalized = validation.draft;
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
