import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildMcpToolCatalog, normalizeMcpTools } from './mcpToolCatalog.js';

const DATA_DIR = path.resolve(process.cwd(), 'server/data');
const MCP_DIR = path.join(DATA_DIR, 'mcp');
const MARKET_FILE = path.join(DATA_DIR, 'mcp-market.json');
const TMP_PREFIX = 'opsdog-mcp-import-';

const DEFAULT_RISK_LEVEL = 'read-only';

const execFileAsync = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr || error.message));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'mcp-server';

const ensureDir = async () => {
  await mkdir(MCP_DIR, { recursive: true });
};

const recordPath = (name) => path.join(MCP_DIR, `${slugify(name)}.json`);

const normalizeStringMap = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), String(item)]));
};

const normalizeBooleanMap = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), Boolean(item)]));
};

const normalizeRiskLevel = (value) => (
  value === 'state-change' || value === 'destructive' ? value : DEFAULT_RISK_LEVEL
);

const buildValidationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const normalizeMcpRecord = (input, previous = null) => {
  const now = new Date().toISOString();
  const name = String(input.name || previous?.name || '').trim();
  if (!name) {
    throw buildValidationError('MCP 服务名称不能为空。');
  }

  const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const command = typeof input.command === 'string' ? input.command.trim() : String(previous?.command || '').trim();
  const url = typeof input.url === 'string' ? input.url.trim() : String(previous?.url || '').trim();
  const args = Array.isArray(input.args)
    ? input.args.map((item) => String(item)).filter(Boolean)
    : Array.isArray(previous?.args)
      ? previous.args.map((item) => String(item)).filter(Boolean)
      : [];

  if (transport === 'stdio' && !command) {
    throw buildValidationError('stdio MCP 服务需要填写命令。');
  }
  if (transport === 'streamable-http' && !url) {
    throw buildValidationError('streamable-http MCP 服务需要填写 URL。');
  }

  return {
    name,
    description: typeof input.description === 'string' ? input.description.trim() : String(previous?.description || '').trim(),
    transport,
    command: transport === 'stdio' ? command : '',
    args,
    env: normalizeStringMap(input.env ?? previous?.env),
    url: transport === 'streamable-http' ? url : '',
    headers: normalizeStringMap(input.headers ?? previous?.headers),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled !== false,
    autoConnect: typeof input.autoConnect === 'boolean' ? input.autoConnect : previous?.autoConnect !== false,
    capabilityEnabled: typeof input.capabilityEnabled === 'boolean' ? input.capabilityEnabled : previous?.capabilityEnabled !== false,
    connectionStatus: typeof input.connectionStatus === 'string' ? input.connectionStatus : previous?.connectionStatus || 'disconnected',
    lastConnectedAt: input.lastConnectedAt === undefined ? (previous?.lastConnectedAt || null) : (input.lastConnectedAt || null),
    lastToolRefreshAt: input.lastToolRefreshAt === undefined ? (previous?.lastToolRefreshAt || null) : (input.lastToolRefreshAt || null),
    recentLogs: Array.isArray(previous?.recentLogs) ? previous.recentLogs.slice(-30) : [],
    lastError: input.lastError === undefined ? (previous?.lastError || null) : (input.lastError || null),
    riskLevel: normalizeRiskLevel(input.riskLevel ?? previous?.riskLevel),
    toolRiskOverrides: normalizeStringMap(input.toolRiskOverrides ?? previous?.toolRiskOverrides),
    toolEnabledOverrides: normalizeBooleanMap(input.toolEnabledOverrides ?? previous?.toolEnabledOverrides),
    tools: normalizeMcpTools({
      name,
      transport,
      riskLevel: normalizeRiskLevel(input.riskLevel ?? previous?.riskLevel),
      toolRiskOverrides: normalizeStringMap(input.toolRiskOverrides ?? previous?.toolRiskOverrides),
      toolEnabledOverrides: normalizeBooleanMap(input.toolEnabledOverrides ?? previous?.toolEnabledOverrides),
    }, Array.isArray(input.tools) ? input.tools : previous?.tools || []),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
};

const hydrateMcpRecord = (raw) => {
  const normalized = normalizeMcpRecord(raw, raw);
  return {
    ...normalized,
    createdAt: raw.createdAt || normalized.createdAt,
    updatedAt: raw.updatedAt || normalized.updatedAt,
  };
};

const withRuntime = (record, runtime = null) => {
  const connected = Boolean(runtime?.connected);
  const tools = connected && Array.isArray(runtime?.tools)
    ? normalizeMcpTools(record, runtime.tools)
    : (record.tools || []);

  return {
    ...record,
    connected,
    connectionStatus: connected ? 'connected' : record.connectionStatus || 'disconnected',
    toolCount: Number((connected ? tools.length : record.tools?.length) || 0),
    tools,
  };
};

export const listMcpServerRecords = async (runtimeMap = new Map()) => {
  await ensureDir();
  const entries = await readdir(MCP_DIR, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(MCP_DIR, entry.name);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const record = hydrateMcpRecord(raw);
    records.push(withRuntime(record, runtimeMap.get(record.name)));
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
};

export const getMcpServerRecord = async (name, runtimeMap = new Map()) => {
  await ensureDir();
  const file = recordPath(name);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const record = hydrateMcpRecord(raw);
    return withRuntime(record, runtimeMap.get(record.name));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const createMcpServerRecord = async (input, runtimeMap = new Map()) => {
  await ensureDir();
  const file = recordPath(input.name);
  try {
    await stat(file);
    throw buildValidationError(`已存在同名 MCP 服务：${input.name}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const record = normalizeMcpRecord(input, null);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return withRuntime(record, runtimeMap.get(record.name));
};

export const updateMcpServerRecord = async (name, updates, runtimeMap = new Map()) => {
  const existing = await getMcpServerRecord(name);
  if (!existing) {
    throw buildValidationError(`MCP 服务未找到：${name}`);
  }
  const next = normalizeMcpRecord({ ...existing, ...updates, name: existing.name }, existing);
  await writeFile(recordPath(existing.name), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return withRuntime(next, runtimeMap.get(next.name));
};

export const appendMcpServerLog = async (name, line) => {
  const existing = await getMcpServerRecord(name);
  if (!existing) return null;
  const recentLogs = [...(existing.recentLogs || []), String(line)].slice(-30);
  const next = normalizeMcpRecord({ ...existing, recentLogs, lastError: existing.lastError }, existing);
  next.recentLogs = recentLogs;
  await writeFile(recordPath(existing.name), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
};

export const updateMcpServerConnectionState = async (name, updates = {}, runtimeMap = new Map()) => {
  const existing = await getMcpServerRecord(name);
  if (!existing) return null;
  const next = normalizeMcpRecord({ ...existing, ...updates }, existing);
  await writeFile(recordPath(existing.name), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return withRuntime(next, runtimeMap.get(next.name));
};

export const setMcpServerError = async (name, message) => {
  const existing = await getMcpServerRecord(name);
  if (!existing) return null;
  const recentLogs = message
    ? [...(existing.recentLogs || []), `ERROR: ${String(message)}`].slice(-30)
    : existing.recentLogs || [];
  const next = normalizeMcpRecord({
    ...existing,
    lastError: message || null,
    connectionStatus: message ? 'error' : existing.connectionStatus,
  }, existing);
  next.recentLogs = recentLogs;
  next.lastError = message || null;
  await writeFile(recordPath(existing.name), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
};

export const listMcpToolCatalogFromRecords = async (runtimeMap = new Map()) => {
  const records = await listMcpServerRecords(runtimeMap);
  return buildMcpToolCatalog(records);
};

export const deleteMcpServerRecord = async (name) => {
  const existing = await getMcpServerRecord(name);
  if (!existing) {
    throw buildValidationError(`MCP 服务未找到：${name}`);
  }
  await unlink(recordPath(existing.name));
  return existing;
};

export const listMcpMarketItems = async () => {
  try {
    const raw = JSON.parse(await readFile(MARKET_FILE, 'utf8'));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

const parseImportedConfig = (name, config) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw buildValidationError(`MCP 配置 ${name} 不是合法对象。`);
  }
  const transport = config.type === 'streamable-http' || config.type === 'sse'
    ? 'streamable-http'
    : (config.transport === 'streamable-http' ? 'streamable-http' : 'stdio');
  return normalizeMcpRecord({
    name,
    description: config.description || '',
    transport,
    command: config.command,
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env,
    url: config.url,
    headers: config.headers,
    enabled: true,
    autoConnect: config.autoConnect,
    capabilityEnabled: config.capabilityEnabled,
    riskLevel: config.riskLevel,
    toolRiskOverrides: config.toolRiskOverrides,
    toolEnabledOverrides: config.toolEnabledOverrides,
  });
};

export const importMcpServersFromJson = async (content, runtimeMap = new Map()) => {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw buildValidationError('导入 JSON 解析失败。');
  }

  const source = parsed?.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : parsed;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw buildValidationError('JSON 中未找到 mcpServers 配置。');
  }

  const created = [];
  const errors = [];
  for (const [name, config] of Object.entries(source)) {
    try {
      const normalized = parseImportedConfig(name, config);
      const record = await createMcpServerRecord(normalized, runtimeMap);
      created.push(record);
    } catch (error) {
      errors.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { created, errors };
};

const parseDxtManifest = async (fileName, fileContentBase64) => {
  const lower = String(fileName || '').toLowerCase();
  if (!lower.endsWith('.dxt') && !lower.endsWith('.mcpb')) {
    throw buildValidationError('仅支持导入 .dxt 或 .mcpb 文件。');
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const archivePath = path.join(tmpDir, fileName);
  try {
    await writeFile(archivePath, Buffer.from(fileContentBase64, 'base64'));
    const { stdout } = await execFileAsync('unzip', ['-p', archivePath, 'manifest.json']);
    const manifest = JSON.parse(stdout);
    return manifest;
  } catch (error) {
    throw buildValidationError(`DXT 包解析失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
};

const extractConfigFromManifest = (manifest) => {
  const name = manifest?.name || manifest?.displayName || 'mcp-server';
  const mcpConfig = manifest?.mcpServers || manifest?.mcp_servers || manifest?.servers;
  if (mcpConfig && typeof mcpConfig === 'object' && !Array.isArray(mcpConfig)) {
    return Object.entries(mcpConfig).map(([serverName, config]) => ({
      name: serverName,
      config,
    }));
  }

  const launch = manifest?.launch || manifest?.server || manifest?.mcp;
  if (launch?.command || launch?.url) {
    return [{
      name: slugify(name),
      config: launch,
    }];
  }

  throw buildValidationError('该 DXT 包不包含可直接导入的 MCP 启动配置。');
};

export const importMcpServersFromDxt = async (fileName, fileContentBase64, runtimeMap = new Map()) => {
  const manifest = await parseDxtManifest(fileName, fileContentBase64);
  const configs = extractConfigFromManifest(manifest);
  const created = [];
  for (const item of configs) {
    const normalized = parseImportedConfig(item.name, item.config);
    created.push(await createMcpServerRecord(normalized, runtimeMap));
  }
  return {
    created,
    manifestName: manifest?.name || manifest?.displayName || undefined,
  };
};

export const installMcpMarketItem = async (itemId, runtimeMap = new Map()) => {
  const items = await listMcpMarketItems();
  const item = items.find((entry) => entry.id === itemId);
  if (!item) {
    throw buildValidationError(`市场项未找到：${itemId}`);
  }

  if (item.sourceType === 'dxt') {
    if (!item.config?.dxtFileName || !item.config?.dxtBase64) {
      throw buildValidationError('该市场项缺少 DXT 包内容。');
    }
    const result = await importMcpServersFromDxt(item.config.dxtFileName, item.config.dxtBase64, runtimeMap);
    return result.created[0];
  }

  if (item.sourceType === 'json') {
    const result = await importMcpServersFromJson(JSON.stringify({ mcpServers: { [item.name]: item.config || {} } }), runtimeMap);
    if (result.created[0]) return result.created[0];
    throw buildValidationError(result.errors[0]?.error || '市场项导入失败。');
  }

  return await createMcpServerRecord({
    name: item.config?.name || item.name,
    description: item.description,
    transport: item.transport,
    command: item.config?.command,
    args: item.config?.args || [],
    env: item.config?.env || {},
    url: item.config?.url,
    headers: item.config?.headers || {},
    enabled: true,
    autoConnect: item.config?.autoConnect,
    capabilityEnabled: item.config?.capabilityEnabled,
    riskLevel: item.config?.riskLevel,
    toolRiskOverrides: item.config?.toolRiskOverrides,
    toolEnabledOverrides: item.config?.toolEnabledOverrides,
  }, runtimeMap);
};
