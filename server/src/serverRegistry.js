import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listSkillPackageServerDefinitions } from './skillPackageRegistry.js';

const APP_ROOT = process.cwd();
const SERVER_DATA_DIR = path.join(APP_ROOT, 'server', 'data', 'servers');
const REPORTS_DATA_DIR = path.join(APP_ROOT, 'server', 'data', 'reports');
const TOOLS_ROOT = path.join(APP_ROOT, 'tools');
const SCRIPT_ROOT = path.join(TOOLS_ROOT, 'script');
const DEFAULT_FILESYSTEM_ROOT = process.env.VITE_OPSDOG_FILESYSTEM_ROOT?.trim() || APP_ROOT;
const DEFAULT_FILESYSTEM_PACKAGE = '@modelcontextprotocol/server-filesystem';
const DEFAULT_FILESYSTEM_ARGS = ['-y', DEFAULT_FILESYSTEM_PACKAGE, DEFAULT_FILESYSTEM_ROOT];
const DEFAULT_REPORTING_ENTRY = path.join(APP_ROOT, 'server', 'src', 'reportingMcp.js');
const DEFAULT_MARKDOWN_PDF_ENTRY = path.join(APP_ROOT, 'server', 'src', 'markdownPdfMcp.js');
const DEFAULT_TICKETING_ENTRY = path.join(APP_ROOT, 'server', 'src', 'ticketingMcp.js');

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

const isInsideAppRoot = (targetPath) => {
  if (!targetPath) return false;
  const resolvedTarget = path.resolve(String(targetPath));
  const relative = path.relative(APP_ROOT, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const hasExpectedNodeEntry = (args = [], expectedEntry) =>
  Array.isArray(args) && args.length === 1 && path.resolve(String(args[0] || '')) === path.resolve(expectedEntry);

const hasExpectedFilesystemArgs = (args = []) => {
  if (!Array.isArray(args) || args.length < 3) return false;
  const [first, second, third] = args;
  if (first !== '-y' || second !== DEFAULT_FILESYSTEM_PACKAGE) return false;
  if (!third) return false;
  if (path.isAbsolute(third)) {
    return isInsideAppRoot(third);
  }
  return true;
};

const shouldRepairSystemServer = (existing, fallback) => {
  if (!existing) return true;

  if (existing.id === 'filesystem') {
    return existing.entry !== 'npx'
      || existing.connection?.command !== 'npx'
      || !hasExpectedFilesystemArgs(existing.connection?.args);
  }

  return !isInsideAppRoot(existing.entry)
    || existing.connection?.command !== process.execPath
    || !hasExpectedNodeEntry(existing.connection?.args, fallback.entry);
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
      steps: { type: 'array', items: { type: 'object' } },
      findings: { type: 'array', items: { type: 'string' } },
      artifacts: { type: 'array', items: { type: 'object' } },
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
    required: ['title', 'date', 'scope', 'summary'],
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

const DEFAULT_TICKETING_TOOLS = [
  {
    name: 'preview_ticket_payload',
    description: '根据传入参数预览工单 payload，不调用外部工单系统。',
    inputSchema: {
      type: 'object',
      properties: {
        eventTime: { type: 'string' },
        organizationName: { type: 'string' },
        unitName: { type: 'string' },
        deviceName: { type: 'string' },
        faultInfo: { type: 'string' },
        faultDescription: { type: 'string' },
        faultTime: { type: 'string' },
        ownerName: { type: 'string' },
        personName: { type: 'string' },
        assetId: { type: 'string' },
        contactPhone: { type: 'string' },
        sourceSystem: { type: 'string' },
        sourceNo: { type: 'string' },
        rawPayload: {},
        remark: { type: 'string' },
      },
      required: ['deviceName'],
      additionalProperties: true,
    },
    outputMode: 'json-object',
    execution: 'oneshot',
    schemaSource: 'server-metadata',
    isDefault: false,
  },
  {
    name: 'build_alert_ticket_payload',
    description: '根据告警上下文和资产映射生成推荐工单 payload。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        targetKey: { type: 'string' },
        alertStatus: { type: 'string' },
        alertMessage: { type: 'string' },
        alertDetail: { type: 'string' },
        alertTime: { type: 'string' },
        sourceNo: { type: 'string' },
        rawPayload: {},
        remark: { type: 'string' },
      },
      required: ['serverId', 'targetKey', 'alertMessage'],
      additionalProperties: true,
    },
    outputMode: 'json-object',
    execution: 'oneshot',
    schemaSource: 'server-metadata',
    isDefault: false,
  },
  {
    name: 'create_ticket',
    description: '调用外部工单系统创建工单，并记录返回的工单 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        eventTime: { type: 'string' },
        organizationName: { type: 'string' },
        unitName: { type: 'string' },
        deviceName: { type: 'string' },
        faultInfo: { type: 'string' },
        faultDescription: { type: 'string' },
        faultTime: { type: 'string' },
        ownerName: { type: 'string' },
        personName: { type: 'string' },
        assetId: { type: 'string' },
        contactPhone: { type: 'string' },
        sourceSystem: { type: 'string' },
        sourceNo: { type: 'string' },
        rawPayload: {},
        remark: { type: 'string' },
      },
      required: ['deviceName'],
      additionalProperties: true,
    },
    outputMode: 'json-object',
    execution: 'oneshot',
    schemaSource: 'server-metadata',
    isDefault: true,
  },
  {
    name: 'upsert_asset_mapping',
    description: '新增或更新单位、设备展示名和运维负责人的主数据映射。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        targetKey: { type: 'string' },
        organizationName: { type: 'string' },
        unitName: { type: 'string' },
        deviceDisplayName: { type: 'string' },
        ownerName: { type: 'string' },
        personName: { type: 'string' },
        ownerPhone: { type: 'string' },
        contactPhone: { type: 'string' },
        assetId: { type: 'string' },
      },
      required: ['serverId', 'targetKey'],
      additionalProperties: true,
    },
    outputMode: 'json-object',
    execution: 'oneshot',
    schemaSource: 'server-metadata',
    isDefault: false,
  },
  {
    name: 'get_asset_mapping',
    description: '根据 serverId 和 targetKey 读取一条资产映射。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        targetKey: { type: 'string' },
      },
      required: ['serverId', 'targetKey'],
      additionalProperties: true,
    },
    outputMode: 'json-object',
    execution: 'oneshot',
    schemaSource: 'server-metadata',
    isDefault: false,
  },
  {
    name: 'list_asset_mappings',
    description: '列出当前保存的资产映射。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    outputMode: 'json-object',
    execution: 'oneshot',
    schemaSource: 'server-metadata',
    isDefault: false,
  },
];

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

const buildDefaultTicketingSystemServer = () =>
  normalizeServerRecord({
    id: 'ticketing',
    name: 'ticketing',
    category: 'system',
    type: 'mcp-system',
    runtime: 'node',
    transport: 'stdio',
    entry: DEFAULT_TICKETING_ENTRY,
    description: '工单与资产映射内置 MCP Server',
    enabled: true,
    connection: {
      command: process.execPath,
      args: [DEFAULT_TICKETING_ENTRY],
      headers: {},
      riskLevel: 'state-change',
      toolRiskOverrides: {
        preview_ticket_payload: 'read-only',
        build_alert_ticket_payload: 'read-only',
        create_ticket: 'state-change',
        upsert_asset_mapping: 'state-change',
        get_asset_mapping: 'read-only',
        list_asset_mappings: 'read-only',
      },
    },
    capabilities: {
      tools: DEFAULT_TICKETING_TOOLS,
      recentLogs: [],
    },
    metadataPath: path.join(SERVER_DATA_DIR, 'ticketing.server.json'),
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
  const category = path.basename(directory) === 'managed' ? 'managed' : 'instant';
  const createdAt = serverMeta?.createdAt || legacyMeta?.uploadedAt || nowIso();
  const usageExamples = Array.isArray(serverMeta?.capabilities?.usageExamples)
    ? serverMeta.capabilities.usageExamples
    : [];
  const intentHints = Array.isArray(serverMeta?.capabilities?.intentHints)
    ? serverMeta.capabilities.intentHints
    : [];
  const metadataInputSchema = serverMeta?.capabilities?.inputSchema;
  const schemaSource = metadataInputSchema || (Array.isArray(serverMeta?.capabilities?.tools) && serverMeta.capabilities.tools.some((tool) => tool?.inputSchema))
    ? 'server-metadata'
    : 'generated-default';
  const inputSchema = metadataInputSchema || undefined;
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
      usageExamples,
      intentHints,
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
  const [pythonServers, storedSystemServers, skillPackageServers] = await Promise.all([
    listPythonServers(),
    listSystemServerFiles(),
    listSkillPackageServerDefinitions(),
  ]);

  const systemMap = new Map(storedSystemServers.map((server) => [server.id, server]));
  const defaultSystemServers = [
    buildDefaultSystemServer(),
    buildDefaultReportingSystemServer(),
    buildDefaultMarkdownPdfSystemServer(),
    buildDefaultTicketingSystemServer(),
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
      !existing.connection?.args?.length ||
      shouldRepairSystemServer(existing, systemServer);

    if (needsRepair) {
      const repaired = normalizeServerRecord({
        ...existing,
        entry: systemServer.entry,
        connection: {
          ...(existing.connection || {}),
          ...(systemServer.connection || {}),
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

  return [...pythonServers, ...skillPackageServers.map(normalizeServerRecord), ...Array.from(systemMap.values())].sort((left, right) =>
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

export const uploadScriptServer = async ({ kind, fileName, description, fileContentBase64, usageExamples = [] }) => {
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

  const normalizedUsageExamples = Array.isArray(usageExamples)
    ? usageExamples.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
    : [];

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
      usageExamples: normalizedUsageExamples,
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
