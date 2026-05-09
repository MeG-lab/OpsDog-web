import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP_ROOT = process.cwd();
const SERVER_DATA_DIR = path.join(APP_ROOT, 'server', 'data', 'servers');
const REPORTS_DATA_DIR = path.join(APP_ROOT, 'server', 'data', 'reports');
const TOOLS_ROOT = path.join(APP_ROOT, 'tools');
const SCRIPT_ROOT = path.join(TOOLS_ROOT, 'script');
const SKILLS_ROOT = path.join(TOOLS_ROOT, 'skills');
const DEFAULT_FILESYSTEM_ROOT = process.env.VITE_OPSDOG_FILESYSTEM_ROOT?.trim() || APP_ROOT;
const DEFAULT_FILESYSTEM_PACKAGE = '@modelcontextprotocol/server-filesystem';
const DEFAULT_FILESYSTEM_ARGS = ['-y', DEFAULT_FILESYSTEM_PACKAGE, DEFAULT_FILESYSTEM_ROOT];
const DEFAULT_REPORTING_ENTRY = path.join(APP_ROOT, 'server', 'src', 'reportingMcp.js');
const DEFAULT_MARKDOWN_PDF_ENTRY = path.join(APP_ROOT, 'server', 'src', 'markdownPdfMcp.js');

const nowIso = () => new Date().toISOString();

const normalizeScriptBasename = (rawName) =>
  String(rawName || '')
    .trim()
    .replace(/\.py$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

const scriptDirectoryForCategory = (category) =>
  path.join(SCRIPT_ROOT, category === 'managed' ? 'managed' : 'instant');

const toPosixRelative = (absolutePath) => path.relative(APP_ROOT, absolutePath).split(path.sep).join(path.posix.sep);

const ensureDirectory = async (directory) => {
  await mkdir(directory, { recursive: true });
};

const DEFAULT_PROTOCOL_BY_CATEGORY = {
  instant: 'json-tool',
  managed: 'json-stream',
  system: 'json-tool',
};

const DEFAULT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
    },
    input: {
      type: 'object',
    },
  },
  additionalProperties: true,
};

const DEFAULT_REPORTING_TOOL = {
  name: 'generate_inspection_report',
  description: '根据巡检结果生成巡检报告文件。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      date: { type: 'string' },
      scope: { type: 'string' },
      summary: { type: 'string' },
      servers: { type: 'array', items: { type: 'object' } },
      alerts: { type: 'array', items: { type: 'object' } },
      recoveries: { type: 'array', items: { type: 'object' } },
      recommendations: { type: 'array', items: { type: 'string' } },
      highlights: { type: 'array', items: { type: 'string' } },
      requestText: { type: 'string' },
      formats: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['md', 'pdf'],
        },
      },
      format: { type: 'string', enum: ['md', 'pdf'] },
    },
    required: ['title', 'date', 'scope', 'summary', 'servers', 'alerts', 'recoveries', 'recommendations'],
    additionalProperties: true,
  },
  outputMode: 'json-object',
  execution: 'oneshot',
  schemaSource: 'server-metadata',
  isDefault: true,
};

const DEFAULT_MARKDOWN_PDF_TOOL = {
  name: 'render_markdown_pdf',
  description: '将 Markdown 内容渲染为 PDF 文件。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      markdown: { type: 'string' },
      outputPath: { type: 'string' },
    },
    required: ['markdown', 'outputPath'],
    additionalProperties: true,
  },
  outputMode: 'json-object',
  execution: 'oneshot',
  schemaSource: 'server-metadata',
  isDefault: true,
};

const stripQuotes = (value) => String(value || '').trim().replace(/^['"]|['"]$/g, '');

const parseSkillScalar = (value) => stripQuotes(value);

const parseSkillStringList = (lines, startIndex) => {
  const values = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith('  - ')) break;
    values.push(parseSkillScalar(line.slice(4)));
    index += 1;
  }
  return { values, nextIndex: index };
};

const parseSkillArgsSchema = (content) => {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'));

  const result = {
    argsSchema: [],
    defaultArgs: [],
  };

  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();

    if (trimmed === 'default_args:') {
      const { values, nextIndex } = parseSkillStringList(lines, index + 1);
      result.defaultArgs = values;
      index = nextIndex;
      continue;
    }

    if (trimmed === 'args_schema:') {
      const schemaItems = [];
      let nextIndex = index + 1;

      while (nextIndex < lines.length) {
        const line = lines[nextIndex];
        if (!line.startsWith('  - ')) break;

        const item = {
          flag: '',
          type: 'string',
          required: false,
        };

        const firstField = line.slice(4);
        const [firstKeyRaw, ...firstValueParts] = firstField.split(':');
        const firstKey = firstKeyRaw?.trim();
        const firstValue = firstValueParts.join(':').trim();
        if (firstKey) {
          if (firstKey === 'flag') item.flag = parseSkillScalar(firstValue);
          if (firstKey === 'type') item.type = parseSkillScalar(firstValue) || 'string';
          if (firstKey === 'required') item.required = parseSkillScalar(firstValue) === 'true';
          if (firstKey === 'multiple') item.multiple = parseSkillScalar(firstValue) === 'true';
          if (firstKey === 'min') item.min = Number.parseInt(parseSkillScalar(firstValue), 10);
          if (firstKey === 'max') item.max = Number.parseInt(parseSkillScalar(firstValue), 10);
          if (firstKey === 'pattern') item.pattern = parseSkillScalar(firstValue);
        }

        nextIndex += 1;
        while (nextIndex < lines.length && lines[nextIndex].startsWith('    ')) {
          const nested = lines[nextIndex].trim();
          const [nestedKeyRaw, ...nestedValueParts] = nested.split(':');
          const nestedKey = nestedKeyRaw?.trim();
          const nestedValue = nestedValueParts.join(':').trim();
          if (nestedKey === 'flag') item.flag = parseSkillScalar(nestedValue);
          if (nestedKey === 'type') item.type = parseSkillScalar(nestedValue) || 'string';
          if (nestedKey === 'required') item.required = parseSkillScalar(nestedValue) === 'true';
          if (nestedKey === 'multiple') item.multiple = parseSkillScalar(nestedValue) === 'true';
          if (nestedKey === 'min') item.min = Number.parseInt(parseSkillScalar(nestedValue), 10);
          if (nestedKey === 'max') item.max = Number.parseInt(parseSkillScalar(nestedValue), 10);
          if (nestedKey === 'pattern') item.pattern = parseSkillScalar(nestedValue);
          nextIndex += 1;
        }

        if (item.flag) {
          schemaItems.push(item);
        }
      }

      result.argsSchema = schemaItems;
      index = nextIndex;
      continue;
    }

    index += 1;
  }

  return result;
};

const skillArgsSchemaItemToProperty = (item) => {
  const key = String(item.flag || '').replace(/^--?/, '').replace(/-/g, '_');
  if (!key) return null;

  const base = item.type === 'integer'
    ? { type: 'integer' }
    : { type: 'string' };

  if (typeof item.min === 'number') {
    if (base.type === 'integer') {
      base.minimum = item.min;
    } else {
      base.minLength = item.min;
    }
  }
  if (typeof item.max === 'number') {
    if (base.type === 'integer') {
      base.maximum = item.max;
    } else {
      base.maxLength = item.max;
    }
  }
  if (item.pattern) {
    base.pattern = item.pattern;
  }

  return {
    key,
    schema: item.multiple
      ? {
          type: 'array',
          items: base,
        }
      : base,
    required: item.required === true,
  };
};

const buildInputSchemaFromSkillArgsSchema = (argsSchema) => {
  if (!Array.isArray(argsSchema) || argsSchema.length === 0) {
    return null;
  }

  const properties = {};
  const required = [];
  for (const item of argsSchema) {
    const property = skillArgsSchemaItemToProperty(item);
    if (!property) continue;
    properties[property.key] = property.schema;
    if (property.required) {
      required.push(property.key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: true,
  };
};

const findSkillYamlPath = (serverId) => path.join(SKILLS_ROOT, serverId, 'skill.yaml');

const readSkillCompatMetadata = async (serverId) => {
  const skillYamlPath = findSkillYamlPath(serverId);
  try {
    const content = await readFile(skillYamlPath, 'utf8');
    return parseSkillArgsSchema(content);
  } catch {
    return null;
  }
};

const normalizeProtocol = (server, rawProtocol = {}) => {
  const mode = rawProtocol.mode || DEFAULT_PROTOCOL_BY_CATEGORY[server.category] || 'json-tool';
  return {
    mode,
    version: 1,
    io: {
      stdin: rawProtocol.io?.stdin || (mode === 'cli-adapter' ? 'optional-json' : 'json'),
      stdout: rawProtocol.io?.stdout || (mode === 'json-stream' ? 'json-events' : mode === 'cli-adapter' ? 'plain-text-or-json' : 'json-object'),
      stderr: rawProtocol.io?.stderr || 'text',
    },
  };
};

const normalizeToolDefinition = (tool, server, defaults = {}) => ({
  ...tool,
  name: tool?.name || defaults.name || server.id,
  description: tool?.description || defaults.description || server.description || `${server.name} tool`,
  inputSchema: tool?.inputSchema || defaults.inputSchema || DEFAULT_INPUT_SCHEMA,
  outputMode: tool?.outputMode || defaults.outputMode || (server.category === 'managed' ? 'json-events' : 'json-object'),
  execution: tool?.execution || defaults.execution || (server.category === 'managed' ? 'managed' : 'oneshot'),
  schemaSource: tool?.schemaSource || defaults.schemaSource || 'generated-default',
  isDefault: tool?.isDefault === true || defaults.isDefault === true,
  adapter: tool?.adapter || defaults.adapter,
});

const getDefaultPythonTool = (server, options = {}) => normalizeToolDefinition({
  name: server.id,
  description: server.description || `${server.name} Python Server tool`,
}, server, {
  inputSchema: options.inputSchema || server.capabilities?.inputSchema || DEFAULT_INPUT_SCHEMA,
  outputMode: options.outputMode || (server.category === 'managed' ? 'json-events' : 'json-object'),
  execution: options.execution || (server.category === 'managed' ? 'managed' : 'oneshot'),
  schemaSource: options.schemaSource || 'generated-default',
  isDefault: true,
  adapter: options.adapter || server.capabilities?.adapter,
});

const normalizeServerCapabilities = (server) => {
  const rawCapabilities = server.capabilities || {};
  const normalizedProtocol = server.type === 'python-script'
    ? normalizeProtocol(server, rawCapabilities.protocol)
    : rawCapabilities.protocol;
  const schemaSource = rawCapabilities.schemaSource || 'generated-default';
  const adapter = rawCapabilities.adapter || undefined;
  const fallbackTools = server.type === 'python-script'
    ? [getDefaultPythonTool(server, {
        inputSchema: rawCapabilities.inputSchema,
        schemaSource,
        adapter,
        outputMode: normalizedProtocol?.mode === 'cli-adapter'
          ? 'plain-text'
          : normalizedProtocol?.mode === 'json-stream'
            ? 'json-events'
            : 'json-object',
        execution: server.category === 'managed' ? 'managed' : 'oneshot',
      })]
    : [];
  const tools = Array.isArray(rawCapabilities.tools) && rawCapabilities.tools.length > 0
    ? rawCapabilities.tools.map((tool) => normalizeToolDefinition(tool, server, {
        inputSchema: rawCapabilities.inputSchema,
        schemaSource,
        adapter,
        outputMode: normalizedProtocol?.mode === 'cli-adapter'
          ? 'plain-text'
          : normalizedProtocol?.mode === 'json-stream'
            ? 'json-events'
            : 'json-object',
        execution: server.category === 'managed' ? 'managed' : 'oneshot',
      }))
    : fallbackTools;

  return {
    ...rawCapabilities,
    tools,
    inputSchema: rawCapabilities.inputSchema,
    protocol: normalizedProtocol,
    schemaSource,
    adapter,
    timeouts: rawCapabilities.timeouts || {},
    recentLogs: Array.isArray(rawCapabilities.recentLogs) ? rawCapabilities.recentLogs : [],
  };
};

const normalizeServerRecord = (server) => {
  const createdAt = server.createdAt || nowIso();
  const updatedAt = server.updatedAt || createdAt;
  const status = server.status || (server.category === 'system' ? 'idle' : 'stopped');
  const normalizedCore = {
    id: server.id || normalizeScriptBasename(server.name) || randomUUID(),
    name: server.name || server.id,
    category: server.category || 'instant',
    type: server.type || 'python-script',
    runtime: server.runtime || (server.type === 'mcp-system' ? 'node' : 'python3'),
    transport: server.transport || 'stdio',
    entry: server.entry || '',
    description: server.description || '',
    status,
    enabled: server.enabled !== false,
    createdAt,
    updatedAt,
    connection: server.connection || {},
    capabilities: server.capabilities || {},
  };

  return {
    ...normalizedCore,
    capabilities: normalizeServerCapabilities(normalizedCore),
    metadataPath: server.metadataPath,
  };
};

const buildDefaultSystemServer = () =>
  normalizeServerRecord({
    id: 'filesystem',
    name: 'filesystem',
    category: 'system',
    type: 'mcp-system',
    runtime: 'node',
    transport: 'stdio',
    entry: 'npx',
    description: 'Filesystem MCP Server',
    enabled: true,
    connection: {
      command: 'npx',
      args: DEFAULT_FILESYSTEM_ARGS,
      headers: {},
      riskLevel: 'read-only',
      toolRiskOverrides: {
        read_file: 'read-only',
        read_text_file: 'read-only',
        read_media_file: 'read-only',
        read_multiple_files: 'read-only',
        get_file_info: 'read-only',
        list_directory: 'read-only',
        list_directory_with_sizes: 'read-only',
        directory_tree: 'read-only',
        list_allowed_directories: 'read-only',
        search_files: 'read-only',
        write_file: 'destructive',
        edit_file: 'destructive',
        move_file: 'destructive',
        create_directory: 'state-change',
      },
    },
    capabilities: {
      tools: [],
      recentLogs: [],
    },
    metadataPath: path.join(SERVER_DATA_DIR, 'filesystem.server.json'),
  });

const buildDefaultReportingSystemServer = () =>
  normalizeServerRecord({
    id: 'reporting',
    name: 'reporting',
    category: 'system',
    type: 'mcp-system',
    runtime: 'node',
    transport: 'stdio',
    entry: DEFAULT_REPORTING_ENTRY,
    description: '巡检报告生成 MCP Server',
    enabled: true,
    connection: {
      command: process.execPath,
      args: [DEFAULT_REPORTING_ENTRY],
      headers: {},
      riskLevel: 'read-only',
      toolRiskOverrides: {
        generate_inspection_report: 'read-only',
      },
    },
    capabilities: {
      tools: [DEFAULT_REPORTING_TOOL],
      recentLogs: [],
    },
    metadataPath: path.join(SERVER_DATA_DIR, 'reporting.server.json'),
  });

const buildDefaultMarkdownPdfSystemServer = () =>
  normalizeServerRecord({
    id: 'markdown_pdf',
    name: 'markdown_pdf',
    category: 'system',
    type: 'mcp-system',
    runtime: 'node',
    transport: 'stdio',
    entry: DEFAULT_MARKDOWN_PDF_ENTRY,
    description: 'Markdown 转 PDF MCP Server',
    enabled: true,
    connection: {
      command: process.execPath,
      args: [DEFAULT_MARKDOWN_PDF_ENTRY],
      headers: {},
      riskLevel: 'state-change',
      toolRiskOverrides: {
        render_markdown_pdf: 'state-change',
      },
    },
    capabilities: {
      tools: [DEFAULT_MARKDOWN_PDF_TOOL],
      recentLogs: [],
    },
    metadataPath: path.join(SERVER_DATA_DIR, 'markdown_pdf.server.json'),
  });

const tryReadJson = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const buildPythonServerFromFile = async (directory, fileName) => {
  const name = normalizeScriptBasename(fileName);
  if (!name) return null;

  const scriptPath = path.join(directory, `${name}.py`);
  const serverMetaPath = path.join(directory, `${name}.server.json`);
  const legacyMetaPath = path.join(directory, `${name}.meta.json`);
  const serverMeta = await tryReadJson(serverMetaPath);
  const legacyMeta = serverMeta ? null : await tryReadJson(legacyMetaPath);
  const skillCompat = await readSkillCompatMetadata(name);
  const category = path.basename(directory) === 'managed' ? 'managed' : 'instant';
  const createdAt = serverMeta?.createdAt || legacyMeta?.uploadedAt || nowIso();
  const skillInputSchema = buildInputSchemaFromSkillArgsSchema(skillCompat?.argsSchema);
  const metadataInputSchema = serverMeta?.capabilities?.inputSchema;
  const schemaSource = metadataInputSchema || (Array.isArray(serverMeta?.capabilities?.tools) && serverMeta.capabilities.tools.some((tool) => tool?.inputSchema))
    ? 'server-metadata'
    : skillInputSchema
      ? 'skill-compat'
      : 'generated-default';
  const inputSchema = metadataInputSchema || skillInputSchema || undefined;
  const protocolMode = serverMeta?.protocol?.mode
    || serverMeta?.capabilities?.protocol?.mode
    || legacyMeta?.protocol?.mode
    || DEFAULT_PROTOCOL_BY_CATEGORY[category];
  const adapter = serverMeta?.adapter
    || serverMeta?.capabilities?.adapter
    || (protocolMode === 'cli-adapter'
      ? {
          stdinMode: 'none',
          stdoutMode: 'plain-text',
          stderrMode: 'text',
          passthroughArgs: true,
        }
      : undefined);
  const metadataTools = Array.isArray(serverMeta?.capabilities?.tools)
    ? serverMeta.capabilities.tools
    : [];
  const resolvedTools = metadataTools.length > 0
    ? metadataTools.map((tool) => normalizeToolDefinition(tool, {
        id: serverMeta?.id || name,
        name: serverMeta?.name || legacyMeta?.name || name,
        category: serverMeta?.category || legacyMeta?.kind || category,
        description: serverMeta?.description || legacyMeta?.description || '',
      }, {
        inputSchema,
        schemaSource,
        adapter: tool?.adapter || adapter,
        outputMode: protocolMode === 'cli-adapter' ? 'plain-text' : protocolMode === 'json-stream' ? 'json-events' : 'json-object',
        execution: category === 'managed' ? 'managed' : 'oneshot',
      }))
    : undefined;

  return normalizeServerRecord({
    id: serverMeta?.id || name,
    name: serverMeta?.name || legacyMeta?.name || name,
    category: serverMeta?.category || legacyMeta?.kind || category,
    type: 'python-script',
    runtime: serverMeta?.runtime || 'python3',
    transport: serverMeta?.transport || 'stdio',
    entry: toPosixRelative(scriptPath),
    description: serverMeta?.description || legacyMeta?.description || '',
    enabled: serverMeta?.enabled ?? true,
    createdAt,
    updatedAt: serverMeta?.updatedAt || legacyMeta?.uploadedAt || createdAt,
    connection: serverMeta?.connection || {},
    capabilities: {
      tools: resolvedTools,
      inputSchema,
      protocol: normalizeProtocol({ category }, serverMeta?.protocol || serverMeta?.capabilities?.protocol || { mode: protocolMode }),
      schemaSource,
      adapter,
      timeouts: serverMeta?.timeouts || serverMeta?.capabilities?.timeouts || {},
      recentLogs: [],
    },
    metadataPath: serverMetaPath,
  });
};

const listPythonServers = async () => {
  const directories = [scriptDirectoryForCategory('instant'), scriptDirectoryForCategory('managed')];
  const discovered = [];

  for (const directory of directories) {
    await ensureDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
      const server = await buildPythonServerFromFile(directory, entry.name);
      if (server) discovered.push(server);
    }
  }

  return discovered;
};

const listSystemServerFiles = async () => {
  await ensureDirectory(SERVER_DATA_DIR);
  const entries = await readdir(SERVER_DATA_DIR, { withFileTypes: true });
  const servers = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.server.json')) continue;
    const filePath = path.join(SERVER_DATA_DIR, entry.name);
    const parsed = await tryReadJson(filePath);
    if (!parsed) continue;
    servers.push(normalizeServerRecord({
      ...parsed,
      metadataPath: filePath,
    }));
  }

  return servers;
};

export const listServerDefinitions = async () => {
  const [pythonServers, storedSystemServers] = await Promise.all([
    listPythonServers(),
    listSystemServerFiles(),
  ]);

  const systemMap = new Map(storedSystemServers.map((server) => [server.id, server]));
  const defaultSystemServers = [
    buildDefaultSystemServer(),
    buildDefaultReportingSystemServer(),
    buildDefaultMarkdownPdfSystemServer(),
  ];

  for (const systemServer of defaultSystemServers) {
    const existing = systemMap.get(systemServer.id);
    if (!existing) {
      await writeServerDefinition(systemServer);
      systemMap.set(systemServer.id, systemServer);
      continue;
    }

    const existingTools = Array.isArray(existing.capabilities?.tools) ? existing.capabilities.tools : [];
    const defaultTools = Array.isArray(systemServer.capabilities?.tools) ? systemServer.capabilities.tools : [];
    const needsRepair =
      (defaultTools.length > 0 && existingTools.length === 0) ||
      !existing.connection?.command ||
      !existing.connection?.args?.length;

    if (needsRepair) {
      const repaired = normalizeServerRecord({
        ...existing,
        connection: {
          ...(systemServer.connection || {}),
          ...(existing.connection || {}),
        },
        capabilities: {
          ...(systemServer.capabilities || {}),
          ...(existing.capabilities || {}),
          tools: existingTools.length > 0 ? existingTools : defaultTools,
        },
        updatedAt: nowIso(),
        metadataPath: existing.metadataPath,
      });
      const saved = await writeServerDefinition(repaired);
      systemMap.set(saved.id, saved);
    }
  }

  return [...pythonServers, ...Array.from(systemMap.values())].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );
};

export const getServerDefinition = async (serverId) => {
  const servers = await listServerDefinitions();
  return servers.find((server) => server.id === serverId) || null;
};

export const writeServerDefinition = async (server) => {
  const normalized = normalizeServerRecord(server);
  const metadataPath = normalized.metadataPath
    || (normalized.category === 'system'
      ? path.join(SERVER_DATA_DIR, `${normalized.id}.server.json`)
      : path.join(scriptDirectoryForCategory(normalized.category), `${normalizeScriptBasename(normalized.name)}.server.json`));

  await ensureDirectory(path.dirname(metadataPath));
  const payload = {
    ...normalized,
    metadataPath: undefined,
  };
  await writeFile(metadataPath, JSON.stringify(payload, null, 2));
  return {
    ...normalized,
    metadataPath,
  };
};

export const uploadScriptServer = async ({ kind, fileName, description, fileContentBase64 }) => {
  const category = kind === 'managed' ? 'managed' : 'instant';
  const trimmedDescription = String(description || '').trim();
  if (!trimmedDescription) {
    throw new Error('描述不能为空。');
  }

  const extension = path.extname(fileName || '').toLowerCase();
  if (extension !== '.py') {
    throw new Error('当前仅支持上传 .py 脚本文件。');
  }

  const normalizedName = normalizeScriptBasename(fileName || '');
  if (!normalizedName) {
    throw new Error('脚本文件名不合法，请使用字母、数字、下划线或连字符。');
  }

  const directory = scriptDirectoryForCategory(category);
  await ensureDirectory(directory);
  const scriptPath = path.join(directory, `${normalizedName}.py`);

  try {
    await access(scriptPath);
    throw new Error(`已存在同名脚本：${normalizedName}.py，请改名后重试。`);
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  let scriptBuffer;
  try {
    scriptBuffer = Buffer.from(String(fileContentBase64 || ''), 'base64');
  } catch {
    throw new Error('脚本内容解析失败，请重新选择文件。');
  }

  if (!scriptBuffer.length) {
    throw new Error('脚本内容为空，无法上传。');
  }

  await writeFile(scriptPath, scriptBuffer);
  return await writeServerDefinition({
    id: normalizedName,
    name: normalizedName,
    category,
    type: 'python-script',
    runtime: 'python3',
    transport: 'stdio',
    entry: toPosixRelative(scriptPath),
    description: trimmedDescription,
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    connection: {},
    capabilities: {
      tools: [{
        name: normalizedName,
        description: trimmedDescription,
        inputSchema: {
          ...DEFAULT_INPUT_SCHEMA,
        },
        outputMode: category === 'managed' ? 'json-events' : 'json-object',
        execution: category === 'managed' ? 'managed' : 'oneshot',
        schemaSource: 'generated-default',
        isDefault: true,
      }],
      protocol: normalizeProtocol({ category }, {}),
      schemaSource: 'generated-default',
      recentLogs: [],
    },
  });
};

export const updateServerDefinition = async (serverId, updates) => {
  const current = await getServerDefinition(serverId);
  if (!current) {
    throw new Error(`Server 未找到：${serverId}`);
  }
  if (current.category !== 'system' && current.type !== 'python-script') {
    throw new Error(`暂不支持更新该类型 Server：${serverId}`);
  }

  const nextDescription = updates.description ?? current.description;
  const currentTools = Array.isArray(current.capabilities?.tools) ? current.capabilities.tools : [];
  const nextTools = current.type === 'python-script'
    ? (currentTools.length > 0 ? currentTools : [getDefaultPythonTool(current)]).map((tool, index) =>
        normalizeToolDefinition({
          ...tool,
          description: index === 0 && tool?.isDefault
            ? nextDescription || tool?.description || `${current.name} tool`
            : tool?.description || '',
        }, current, {
          inputSchema: tool?.inputSchema || current.capabilities?.inputSchema,
          schemaSource: tool?.schemaSource || current.capabilities?.schemaSource || 'generated-default',
          adapter: tool?.adapter || current.capabilities?.adapter,
          outputMode: tool?.outputMode,
          execution: tool?.execution,
          isDefault: tool?.isDefault,
        }))
    : currentTools;

  const next = normalizeServerRecord({
    ...current,
    ...updates,
    connection: {
      ...(current.connection || {}),
      ...(updates.connection || {}),
    },
    capabilities: {
      ...(current.capabilities || {}),
      ...(updates.capabilities || {}),
      tools: Array.isArray(updates.capabilities?.tools) ? updates.capabilities.tools : nextTools,
    },
    updatedAt: nowIso(),
    metadataPath: current.metadataPath,
  });
  return await writeServerDefinition(next);
};

export const deleteServerDefinition = async (serverId) => {
  const current = await getServerDefinition(serverId);
  if (!current) {
    throw new Error(`Server 未找到：${serverId}`);
  }
  if (current.category === 'system') {
    throw new Error('系统 Server 不支持删除。');
  }

  const absoluteEntry = path.join(APP_ROOT, current.entry);
  const metadataPath = current.metadataPath || path.join(path.dirname(absoluteEntry), `${normalizeScriptBasename(current.name)}.server.json`);
  await Promise.allSettled([
    rm(absoluteEntry, { force: true }),
    rm(metadataPath, { force: true }),
    rm(path.join(path.dirname(absoluteEntry), `${normalizeScriptBasename(current.name)}.meta.json`), { force: true }),
  ]);
  return current;
};

export const getDefaultFilesystemArgs = () => [...DEFAULT_FILESYSTEM_ARGS];
export const getDefaultReportsDir = () => REPORTS_DATA_DIR;
