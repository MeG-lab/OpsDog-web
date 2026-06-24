import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAppConfig } from '../../appConfig.js';
import { loadDotEnv } from './envLoader.js';
import { createStdioMcpConnection } from './mcpStdio.js';
import {
  appendMcpServerLog,
  createMcpServerRecord,
  deleteMcpServerRecord,
  getMcpServerRecord,
  importMcpServersFromDxt,
  importMcpServersFromJson,
  installMcpMarketItem,
  listMcpMarketItems,
  listMcpServerRecords,
  listMcpToolCatalogFromRecords,
  setMcpServerError,
  updateMcpServerConnectionState,
  updateMcpServerRecord,
} from './mcpRegistry.js';
import { normalizeMcpTools as normalizeMcpToolList } from './mcpToolCatalog.js';
import {
  deleteServerDefinition,
  duplicateServerDefinition,
  getDefaultFilesystemArgs,
  getDefaultReportsDir,
  getServerDefinition,
  listServerDefinitions,
  readServerScript,
  updateServerDefinition,
  uploadScriptServer,
} from './serverRegistry.js';
import {
  deleteSkillPackage,
  installSkillPackage,
  installSkillPackageDependencies,
  listSkillPackages,
  previewSkillPackage,
  updateSkillPackage,
} from './skillPackageRegistry.js';
import {
  executePythonServerTool,
  getPythonRuntimeState,
  restartManagedPythonServer,
  startInstantPythonServer,
  startManagedPythonServer,
  stopManagedPythonServer,
} from './pythonServerRunner.js';
import { executeWorkflowById } from './workflowRegistry.js';
import { listMergedDevices, rebuildMergedDevices } from './deviceMergedStore.js';
import { readDeviceStatus, removeLocalDeviceMonitorEntries, syncLocalDevicesMonitorDefaults, upsertLocalDeviceMonitorDefaults } from './deviceMonitorStore.js';
import { configureDeviceWatcherStore, startDeviceWatcher } from './deviceWatcher.js';
import { createSqliteAssetMonitorStore } from './database/assetMonitorStore.js';
import { initializeFoundationDatabase } from './database/index.js';
import { createConnectionProfileService } from './remote/connectionProfileService.js';
import { createHostKeyChallengeStore } from './remote/hostKeyChallengeStore.js';
import { createHostKeyService } from './remote/hostKeyService.js';
import { createKeyringSecretStore, createUnavailableSecretStore } from './remote/secretStore.js';
import { createRemoteOriginPolicy } from './remote/remoteOriginPolicy.js';
import { createRemoteTerminalService } from './remote/remoteTerminalService.js';
import { handleAiRemoteRoute } from './remote/aiRemoteRoutes.js';
import { handleSftpHttpRoute } from './remote/sftpHttpApi.js';
import { createSftpService } from './remote/sftpService.js';
import { createSshConnectionTestService } from './remote/sshConnectionTestService.js';
import { createSshTerminalService } from './remote/sshTerminalService.js';
import { createSshTransport } from './remote/sshTransport.js';
import { createTelnetConnectionTestService } from './remote/telnetConnectionTestService.js';
import { createTelnetTerminalService } from './remote/telnetTerminalService.js';
import { createTelnetTransport } from './remote/telnetTransport.js';
import { createTerminalTokenStore } from './remote/terminalTokenStore.js';
import { createTerminalWebSocket } from './remote/terminalWebSocket.js';
import { createAiTask, generateAiTask, validateAiTask } from './aiTaskRegistry.js';
import { createReportDraft, exportReportDraft } from './reportDraftService.js';
import { createAppAuthService } from './appAuthService.js';
import { createUserDataStore } from './userDataStore.js';
import { init as initScheduleEngine } from './scheduleEngine.js';

loadDotEnv();

const appConfig = getAppConfig(process.env);
const {
  serverHost: HOST,
  serverPort: PORT,
  webOrigin: WEB_ORIGIN,
  serverOrigin: SERVER_ORIGIN,
} = appConfig;

const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'openai',
  'custom',
  'aliyun',
  'deepseek',
  'siliconflow',
  'volcengine',
  'zhipu',
  'moonshot',
]);

const MCP_SESSION_HEADER = 'mcp-session-id';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const mcpConnections = new Map();
const CURL_STATUS_MARKER = '__OPSDOG_CURL_STATUS__';
const REPORTS_DIR = getDefaultReportsDir();
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const ASSETS_DIR = String(process.env.OPSDOG_ASSETS_DIR || '').trim()
  || path.resolve(process.cwd(), 'server/data/assets');
const DATABASE_PATH = String(process.env.OPSDOG_DATABASE_PATH || '').trim() || undefined;
const LOCAL_ASSET_DEVICES_PATH = path.join(ASSETS_DIR, 'devices.local.json');
const LOCAL_DEVICE_JSON_PATH = path.resolve(process.cwd(), 'device.json');
const ASSET_API_MODE = String(process.env.ASSET_API_MODE || 'local').trim().toLowerCase();
const ASSET_API_BASE_URL = String(process.env.ASSET_API_BASE_URL || '').trim();
const ASSET_API_LIST_PATH = String(process.env.ASSET_API_LIST_PATH || '').trim();
const ASSET_API_TOKEN = String(process.env.ASSET_API_TOKEN || '').trim();
const authCookieName = 'opsdog_session';

const getRequestPathname = (req) => {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`).pathname;
  } catch {
    return req.url || '/';
  }
};

const parseCookies = (cookieHeader = '') => {
  const cookies = {};
  for (const segment of String(cookieHeader || '').split(';')) {
    const separatorIndex = segment.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = segment.slice(0, separatorIndex).trim();
    const rawValue = segment.slice(separatorIndex + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
};

const getSessionToken = (req) => parseCookies(req.headers.cookie || '')[authCookieName] || '';

const buildAuthCookie = (value, { maxAgeSeconds } = {}) => [
  `${authCookieName}=${encodeURIComponent(value || '')}`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  Number.isFinite(maxAgeSeconds) ? `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}` : null,
].filter(Boolean).join('; ');

const isPublicAuthRoute = (req) => {
  const pathname = getRequestPathname(req);
  return (
    pathname === '/api/health'
    || (req.method === 'POST' && pathname === '/api/auth/login')
    || (req.method === 'GET' && pathname === '/api/auth/session')
    || (req.method === 'POST' && pathname === '/api/auth/logout')
  );
};

const writeAuthJson = (res, statusCode, payload, headers = {}) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
};

const authorizeSessionRequest = (req, res) => {
  const pathname = getRequestPathname(req);
  if (req.method === 'OPTIONS' || !pathname.startsWith('/api/') || isPublicAuthRoute(req)) return true;
  if (!activeAuthService) {
    writeAuthJson(res, 503, { error: 'Authentication service unavailable.' });
    return false;
  }
  const context = activeAuthService.authenticateSessionToken(getSessionToken(req));
  if (!context) {
    writeAuthJson(res, 401, { error: 'Authentication required.' });
    return false;
  }
  req.authContext = context;
  return true;
};

const authorizeSessionUpgrade = (request, socket) => {
  const context = activeAuthService?.authenticateSessionToken(getSessionToken(request));
  if (context) {
    request.authContext = context;
    return true;
  }
  const body = JSON.stringify({ error: 'Authentication required.' });
  socket.write([
    'HTTP/1.1 401 Unauthorized',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'));
  socket.destroy();
  return false;
};

const getOpenAIBaseUrl = (request) => request.baseUrl?.trim() || 'https://api.openai.com/v1';
const getGoogleBaseUrl = (request) => request.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const REMOTE_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const remoteOriginPolicy = createRemoteOriginPolicy({
  allowedOrigins: [WEB_ORIGIN, SERVER_ORIGIN],
});

const writeJsonResponse = (res, statusCode, payload, headers = DEFAULT_CORS_HEADERS) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
};

const sendJson = (res, statusCode, payload, headers) => {
  writeJsonResponse(res, statusCode, payload, headers ? { ...DEFAULT_CORS_HEADERS, ...headers } : DEFAULT_CORS_HEADERS);
};

const sendBinary = (res, statusCode, body, headers = {}) => {
  res.writeHead(statusCode, {
    ...DEFAULT_CORS_HEADERS,
    ...headers,
  });
  res.end(body);
};

const WEB_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

const resolveDistPath = (pathname) => {
  const relativePath = pathname === '/'
    ? 'index.html'
    : decodeURIComponent(pathname).replace(/^\/+/, '');
  const absolutePath = path.resolve(DIST_DIR, relativePath);
  const relativeToDist = path.relative(DIST_DIR, absolutePath);
  if (relativeToDist.startsWith('..') || path.isAbsolute(relativeToDist)) return null;
  return absolutePath;
};

const trySendDistFile = async (res, absolutePath) => {
  if (!absolutePath) return false;
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return false;
    sendBinary(res, 200, await readFile(absolutePath), {
      'Content-Type': WEB_CONTENT_TYPES.get(path.extname(absolutePath).toLowerCase()) || 'application/octet-stream',
    });
    return true;
  } catch {
    return false;
  }
};

const tryServeBuiltWeb = async (req, res) => {
  if (req.method !== 'GET' || !req.url) return false;
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname.startsWith('/api/')) return false;
  if (await trySendDistFile(res, resolveDistPath(url.pathname))) return true;
  if (!path.extname(url.pathname)) {
    return await trySendDistFile(res, path.join(DIST_DIR, 'index.html'));
  }
  return false;
};

const sendError = (res, statusCode, message, details) => {
  sendJson(res, statusCode, { error: message, details });
};

const isAbortError = (error) =>
  error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

const sendSseHeaders = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
};

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
};

const buildUpstreamError = async (response) => {
  const body = await response.text().catch(() => '');
  throw new Error(`API returned ${response.status}: ${body || response.statusText}`);
};

const getReportMimeType = (fileName) => {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.md') return 'text/markdown; charset=utf-8';
  if (extension === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
};

const ensureSafeReportPath = (fileName) => {
  const baseName = path.basename(String(fileName || ''));
  if (!baseName) {
    throw new Error('报告文件名不能为空。');
  }
  return path.join(REPORTS_DIR, baseName);
};

const listReports = async () => {
  const entries = await readdir(REPORTS_DIR, { withFileTypes: true }).catch(() => []);
  const reports = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const absolutePath = path.join(REPORTS_DIR, entry.name);
      const info = await stat(absolutePath);
      return {
        fileName: entry.name,
        mimeType: getReportMimeType(entry.name),
        size: info.size,
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
        path: absolutePath,
      };
    }));
  return reports.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

const readReportContent = async (fileName) => {
  const absolutePath = ensureSafeReportPath(fileName);
  const mimeType = getReportMimeType(fileName);
  if (!mimeType.startsWith('text/markdown')) {
    throw new Error('当前仅支持查看 Markdown 报告内容。');
  }
  const content = await readFile(absolutePath, 'utf8');
  return {
    fileName,
    mimeType,
    content,
    path: absolutePath,
  };
};

const readReportDownload = async (fileName) => {
  const absolutePath = ensureSafeReportPath(fileName);
  const body = await readFile(absolutePath);
  return {
    fileName,
    mimeType: getReportMimeType(fileName),
    body,
  };
};

const deleteReport = async (fileName) => {
  const absolutePath = ensureSafeReportPath(fileName);
  await unlink(absolutePath);
};

const clearReports = async () => {
  await rm(REPORTS_DIR, { recursive: true, force: true });
};

const safeUpstreamFetch = async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Upstream request failed: ${message}`);
    wrapped.cause = error;
    throw wrapped;
  }
};

const isLocalIssuerCertError = (error) => {
  let current = error;
  while (current) {
    if (
      current?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
      current?.code === 'SELF_SIGNED_CERT_IN_CHAIN'
    ) {
      return true;
    }
    current = current?.cause;
  }
  return false;
};

const execFileAsync = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr || error.message));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const curlRequest = async (url, init = {}) => {
  const method = init.method || 'GET';
  const headers = init.headers || {};
  const args = ['-sS', '-L', '-X', method, url];

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }

  if (init.body) {
    args.push('--data-raw', String(init.body));
  }

  args.push('-w', `\n${CURL_STATUS_MARKER}:%{http_code}`);

  const { stdout } = await execFileAsync('curl', args);
  const markerIndex = stdout.lastIndexOf(`\n${CURL_STATUS_MARKER}:`);
  if (markerIndex === -1) {
    throw new Error('curl fallback did not return an HTTP status marker');
  }

  const body = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + `\n${CURL_STATUS_MARKER}:`.length).trim());

  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
};

const fetchWithTlsFallback = async (url, init) => {
  try {
    return await safeUpstreamFetch(url, init);
  } catch (error) {
    if (isLocalIssuerCertError(error)) {
      return await curlRequest(url, init);
    }
    throw error;
  }
};

const buildAssetListUrl = (query) => {
  if (!ASSET_API_BASE_URL) {
    throw new Error('缺少 ASSET_API_BASE_URL 配置，无法请求资产列表接口。');
  }
  if (!ASSET_API_LIST_PATH) {
    throw new Error('缺少 ASSET_API_LIST_PATH 配置，无法请求资产列表接口。');
  }

  const url = new URL(ASSET_API_LIST_PATH, ASSET_API_BASE_URL);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    url.searchParams.set(key, text);
  }
  return url;
};

const mapRemoteAssetType = (assetType) => {
  if (assetType === 1) return 'server';
  if (assetType === 2) return 'storage';
  if (assetType === 3) return 'security';
  return 'network';
};

const mapRemoteUseStatus = (useStatus) => {
  if (useStatus === 1 || useStatus === 10) return 'healthy';
  if (useStatus === 13) return 'attention';
  return 'critical';
};

const mapRemoteAssetToDevice = (item) => {
  const now = new Date().toISOString();
  return {
    id: String(item?.id || randomUUID()),
    name: String(item?.name || ''),
    assetId: String(item?.id || ''),
    ipAddress: String(item?.ipAddr || ''),
    deviceType: mapRemoteAssetType(item?.assetType),
    status: mapRemoteUseStatus(item?.useStatus),
    location: String(item?.jfName || ''),
    model: String(item?.deviceModel || ''),
    manufacturer: String(item?.deviceBrand || ''),
    serialNumber: String(item?.productSn || ''),
    organization: String(item?.customerName || ''),
    owner: String(item?.manageUser || ''),
    remark: String(item?.providerName || ''),
    createdAt: now,
    updatedAt: now,
  };
};

const normalizeLocalAssetDevice = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const deviceType = source.deviceType === 'storage'
    ? 'storage'
    : source.deviceType === 'security'
      ? 'security'
      : source.deviceType === 'network'
        ? 'network'
        : 'server';
  const status = source.status === 'attention'
    ? 'attention'
    : source.status === 'critical'
      ? 'critical'
      : 'healthy';
  const now = new Date().toISOString();

  return {
    id: String(source.id || randomUUID()),
    name: String(source.name || ''),
    assetId: String(source.assetId || ''),
    ipAddress: String(source.ipAddress || ''),
    deviceType,
    status,
    location: String(source.location || ''),
    model: String(source.model || ''),
    manufacturer: String(source.manufacturer || ''),
    serialNumber: String(source.serialNumber || ''),
    organization: String(source.organization || ''),
    owner: String(source.owner || ''),
    remark: String(source.remark || ''),
    createdAt: String(source.createdAt || now),
    updatedAt: String(source.updatedAt || now),
  };
};

const buildGeneratedLocalAssetId = (deviceId, date = new Date()) => {
  const compactDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
  const suffix = String(deviceId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `LOCAL-ASSET-${compactDate}-${suffix}`;
};

const ensureLocalAssetDevicesFile = async () => {
  try {
    await stat(LOCAL_ASSET_DEVICES_PATH);
  } catch {
    await mkdir(path.dirname(LOCAL_ASSET_DEVICES_PATH), { recursive: true });
    await writeFile(LOCAL_ASSET_DEVICES_PATH, JSON.stringify({ devices: [] }, null, 2), 'utf8');
  }
};

const readLocalManagedAssetDevices = async () => {
  await ensureLocalAssetDevicesFile();
  const raw = await readFile(LOCAL_ASSET_DEVICES_PATH, 'utf8');
  const payload = JSON.parse(raw);
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  return devices.map((item) => normalizeLocalAssetDevice(item));
};

const writeLocalManagedAssetDevices = async (devices) => {
  await mkdir(path.dirname(LOCAL_ASSET_DEVICES_PATH), { recursive: true });
  await writeFile(LOCAL_ASSET_DEVICES_PATH, JSON.stringify({ devices }, null, 2), 'utf8');
};

const resolveLocalManagedDeviceId = (deviceId) => {
  const normalized = String(deviceId || '').trim();
  if (!normalized) {
    throw new Error('设备 ID 不能为空。');
  }
  if (normalized.startsWith('remote:')) {
    throw new Error('远端资产当前为只读，暂不支持直接编辑或删除。');
  }
  return normalized.startsWith('local:') ? normalized.slice('local:'.length) : normalized;
};

const filterLocalManagedAssets = (devices, query = {}) => {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (entries.length === 0) return devices;

  return devices.filter((item) => entries.every(([key, value]) => {
    const expected = String(value).trim().toLowerCase();
    if (!expected) return true;

    if (key === 'name') {
      return item.name.toLowerCase().includes(expected);
    }
    if (key === 'ipAddr') {
      return item.ipAddress.toLowerCase().includes(expected);
    }
    if (key === 'assetType') {
      const typeLookup = {
        server: '1',
        storage: '2',
        security: '3',
        network: '4',
      };
      return typeLookup[item.deviceType] === expected;
    }
    return true;
  }));
};

const listLocalManagedAssetDevices = async (query = {}) => {
  const devices = await readLocalManagedAssetDevices();
  const filtered = filterLocalManagedAssets(devices, query);
  return {
    code: 0,
    msg: '',
    data: filtered,
    items: filtered,
  };
};

const createLocalManagedAssetDevice = async (payload = {}) => {
  const devices = await readLocalManagedAssetDevices();
  const now = new Date().toISOString();
  const nextId = payload.id || randomUUID();
  const nextDevice = normalizeLocalAssetDevice({
    ...payload,
    id: nextId,
    assetId: payload.assetId || buildGeneratedLocalAssetId(nextId, new Date(now)),
    createdAt: payload.createdAt || now,
    updatedAt: now,
  });
  devices.unshift(nextDevice);
  await writeLocalManagedAssetDevices(devices);
  await upsertLocalDeviceMonitorDefaults(nextDevice);
  await rebuildMergedDevices();
  return {
    ...nextDevice,
    id: `local:${nextDevice.id}`,
  };
};

const updateLocalManagedAssetDevice = async (deviceId, payload = {}) => {
  const resolvedDeviceId = resolveLocalManagedDeviceId(deviceId);
  const devices = await readLocalManagedAssetDevices();
  const index = devices.findIndex((item) => item.id === resolvedDeviceId);
  if (index === -1) {
    throw new Error(`设备未找到：${deviceId}`);
  }
  const existing = devices[index];
  const updated = normalizeLocalAssetDevice({
    ...existing,
    ...payload,
    id: existing.id,
    assetId: payload.assetId || existing.assetId || buildGeneratedLocalAssetId(existing.id),
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  devices[index] = updated;
  await writeLocalManagedAssetDevices(devices);
  await upsertLocalDeviceMonitorDefaults(updated);
  await rebuildMergedDevices();
  return {
    ...updated,
    id: `local:${updated.id}`,
  };
};

const deleteLocalManagedAssetDevice = async (deviceId) => {
  const resolvedDeviceId = resolveLocalManagedDeviceId(deviceId);
  const devices = await readLocalManagedAssetDevices();
  const nextDevices = devices.filter((item) => item.id !== resolvedDeviceId);
  if (nextDevices.length === devices.length) {
    throw new Error(`设备未找到：${deviceId}`);
  }
  await writeLocalManagedAssetDevices(nextDevices);
  await removeLocalDeviceMonitorEntries(resolvedDeviceId);
  await rebuildMergedDevices();
  return { ok: true, deviceId };
};

const legacyAssetStore = {
  listMergedDevices,
  rebuildMergedDevices,
  readDeviceStatus,
  syncLocalDevicesMonitorDefaults,
  createLocalManagedAssetDevice,
  updateLocalManagedAssetDevice,
  deleteLocalManagedAssetDevice,
};
let activeAssetStore = legacyAssetStore;
let activeConnectionProfileService = null;
let activeSshConnectionTestService = null;
let activeSshTerminalService = null;
let activeTelnetConnectionTestService = null;
let activeRemoteTerminalService = null;
let activeSftpService = null;
let activeAuthService = null;
let activeUserDataStore = null;

const requireConnectionProfileService = () => {
  if (!activeConnectionProfileService) {
    const error = new Error('远程连接配置服务不可用。');
    error.code = 'REMOTE_PROFILE_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeConnectionProfileService;
};

const requireAuthService = () => {
  if (!activeAuthService) {
    const error = new Error('认证服务不可用。');
    error.code = 'AUTH_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeAuthService;
};

const requireUserDataStore = () => {
  if (!activeUserDataStore) {
    const error = new Error('用户数据服务不可用。');
    error.code = 'USER_DATA_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeUserDataStore;
};

const requireSshConnectionTestService = () => {
  if (!activeSshConnectionTestService) {
    const error = new Error('SSH 连接测试服务不可用。');
    error.code = 'SSH_CONNECTION_TEST_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeSshConnectionTestService;
};

const requireSshTerminalService = () => {
  if (!activeSshTerminalService) {
    const error = new Error('SSH 终端服务不可用。');
    error.code = 'SSH_TERMINAL_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeSshTerminalService;
};

const requireRemoteTerminalService = () => {
  if (!activeRemoteTerminalService) {
    const error = new Error('远程终端服务不可用。');
    error.code = 'REMOTE_TERMINAL_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeRemoteTerminalService;
};

const requireTelnetConnectionTestService = () => {
  if (!activeTelnetConnectionTestService) {
    const error = new Error('TELNET 连接测试服务不可用。');
    error.code = 'TELNET_CONNECTION_TEST_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeTelnetConnectionTestService;
};

const requireSftpService = () => {
  if (!activeSftpService) {
    const error = new Error('SFTP 服务不可用。');
    error.code = 'SFTP_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return activeSftpService;
};

const readLocalAssetDeviceData = async () => {
  const raw = await readFile(LOCAL_DEVICE_JSON_PATH, 'utf8');
  const payload = JSON.parse(raw);
  return Array.isArray(payload?.data) ? payload.data : [];
};

const filterMockAssets = (query = {}) => {
  const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (entries.length === 0) return [];

  return entries;
};

const applyAssetFilters = (data, query = {}) => {
  const entries = filterMockAssets(query);
  if (entries.length === 0) return data;

  return data.filter((item) => entries.every(([key, value]) => {
    const expected = String(value).trim();
    if (!expected) return true;

    if (['name', 'providerName', 'jfName'].includes(key)) {
      return String(item[key] || '').includes(expected);
    }

    return String(item[key] ?? '') === expected;
  }));
};

const listAssetDevices = async (query = {}) => {
  if (ASSET_API_MODE === 'local' || ASSET_API_MODE === 'merged') {
    const result = await activeAssetStore.listMergedDevices(query);
    return {
      code: 0,
      msg: '',
      data: result.items,
      items: result.items.map((item) => ({
        id: item.id,
        name: item.name,
        assetId: item.assetId,
        ipAddress: item.ipAddress,
        deviceType: item.deviceType,
        status: item.status,
        location: item.location,
        model: item.deviceModel,
        manufacturer: item.deviceBrand,
        serialNumber: item.productSn,
        organization: item.customerName || item.organization,
        owner: item.owner,
        remark: item.remark,
        createdAt: item.createdAt || item.mergedUpdatedAt,
        updatedAt: item.updatedAt || item.mergedUpdatedAt,
      })),
    };
  }

  if (ASSET_API_MODE !== 'remote') {
    const localData = await readLocalAssetDeviceData();
    const data = applyAssetFilters(localData, query);
    return {
      code: 0,
      msg: '',
      data,
      items: data.map(mapRemoteAssetToDevice),
    };
  }

  const url = buildAssetListUrl(query);
  const headers = {
    Accept: 'application/json',
  };

  if (ASSET_API_TOKEN) {
    headers.Authorization = `Bearer ${ASSET_API_TOKEN}`;
  }

  const response = await fetchWithTlsFallback(url, { headers });
  if (!response.ok) await buildUpstreamError(response);

  const payload = await response.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];

  return {
    code: Number(payload?.code ?? 0),
    msg: String(payload?.msg || ''),
    data,
    items: data.map(mapRemoteAssetToDevice),
  };
};

const sendOpenAICompatible = async (request) => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: request.modelName,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stream: false,
  };

  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = request.toolChoice || 'auto';
  }
  if (request.responseFormat && typeof request.responseFormat === 'object') {
    body.response_format = request.responseFormat;
  }

  const finalResponse = await fetchWithTlsFallback(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!finalResponse.ok) await buildUpstreamError(finalResponse);
  const data = await finalResponse.json();
  const choice = data.choices?.[0]?.message;
  return {
    content: choice?.content ?? '',
    toolCalls: choice?.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })),
  };
};

const sendAnthropic = async (request) => {
  const baseUrl = request.baseUrl?.trim() || 'https://api.anthropic.com';
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const system = request.messages.find((message) => message.role === 'system')?.content;
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const requestInit = {
    method: 'POST',
    headers: {
      'x-api-key': request.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.modelName,
      messages,
      max_tokens: request.maxTokens,
      system,
      stream: false,
    }),
    signal: request.signal,
  };

  const response = await fetchWithTlsFallback(url, requestInit);
  if (!response.ok) await buildUpstreamError(response);
  const data = await response.json();
  return {
    content: (data.content ?? []).map((item) => item.text ?? '').join(''),
  };
};

const sendGoogle = async (request) => {
  const url = `${getGoogleBaseUrl(request).replace(/\/$/, '')}/models/${request.modelName}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
  const contents = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  const response = await fetchWithTlsFallback(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
      },
    }),
    signal: request.signal,
  });

  if (!response.ok) await buildUpstreamError(response);
  const data = await response.json();
  return {
    content: data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
  };
};

const THINK_TAG_RE = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi;
const UNFINISHED_THINK_TAG_RE = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*$/i;
const FINAL_ANSWER_MARKER_RE = /(?:最终答案|最终回答|正式回答|回答|Final answer|Answer)\s*[：:]\s*/i;
const LEADING_REASONING_MARKER_RE = /^\s*(?:思考过程|推理过程|分析过程|内部思考|Reasoning|Thought process|Thinking)\s*[：:]/i;

const sanitizeModelContent = (content = '') => {
  const text = String(content || '');
  if (!text) return text;

  const markerMatch = text.match(FINAL_ANSWER_MARKER_RE);
  const startsWithReasoning = LEADING_REASONING_MARKER_RE.test(text);
  const markerIndex = markerMatch?.index ?? -1;
  const markerEnd = markerIndex >= 0 ? markerIndex + markerMatch[0].length : -1;
  const source = startsWithReasoning && markerEnd >= 0 ? text.slice(markerEnd) : text;

  return source
    .replace(THINK_TAG_RE, '')
    .replace(UNFINISHED_THINK_TAG_RE, '')
    .trim();
};

const sendChat = async (request) => {
  if (
    request.toolChoice &&
    request.toolChoice !== 'auto' &&
    request.toolChoice !== 'none' &&
    !OPENAI_COMPATIBLE_PROVIDERS.has(request.provider)
  ) {
    throw new Error('当前模型通道不支持结构化任务生成，请使用 OpenAI-compatible 模型配置。');
  }

  const response = OPENAI_COMPATIBLE_PROVIDERS.has(request.provider)
    ? await sendOpenAICompatible(request)
    : request.provider === 'anthropic'
      ? await sendAnthropic(request)
      : request.provider === 'google'
        ? await sendGoogle(request)
        : null;
  if (response) {
    return {
      ...response,
      content: sanitizeModelContent(response.content || ''),
    };
  }
  throw new Error(`Unsupported provider: ${request.provider}`);
};

const createStreamingThoughtFilter = () => {
  const openTagRe = /<(think|thinking|reasoning)\b[^>]*>/i;
  const closeTagRe = /<\/(think|thinking|reasoning)>/i;
  const tailSize = 48;
  let pending = '';
  let insideThought = false;

  return (chunk = '', final = false) => {
    let text = `${pending}${chunk}`;
    let output = '';
    pending = '';

    while (text) {
      if (insideThought) {
        const closeIndex = text.search(closeTagRe);
        if (closeIndex === -1) {
          pending = final ? '' : text.slice(-tailSize);
          text = '';
          continue;
        }
        const closeMatch = text.slice(closeIndex).match(closeTagRe);
        text = text.slice(closeIndex + (closeMatch?.[0].length || 0));
        insideThought = false;
        continue;
      }

      const openIndex = text.search(openTagRe);
      if (openIndex === -1) {
        if (final || text.length <= tailSize) {
          pending = final ? '' : text;
          output += final ? text : '';
        } else {
          output += text.slice(0, -tailSize);
          pending = text.slice(-tailSize);
        }
        text = '';
        continue;
      }

      output += text.slice(0, openIndex);
      const openMatch = text.slice(openIndex).match(openTagRe);
      text = text.slice(openIndex + (openMatch?.[0].length || 0));
      insideThought = true;
    }

    return output;
  };
};

const writeSanitizedSsePayload = (res, payload, thoughtFilter) => {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  let wrote = false;

  for (const choice of choices) {
    const delta = choice?.delta || {};
    const rawContent = typeof delta.content === 'string' ? delta.content : '';
    const content = rawContent ? thoughtFilter(rawContent) : '';
    if (!content) continue;

    res.write(`data: ${JSON.stringify({
      choices: [{
        index: choice.index ?? 0,
        delta: { content },
        finish_reason: choice.finish_reason ?? null,
      }],
    })}\n\n`);
    wrote = true;
  }

  return wrote;
};

const streamOpenAICompatible = async (request, res) => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/chat/completions`;
  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify((() => {
      const body = {
        model: request.modelName,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: true,
      };
      if (request.tools?.length) {
        body.tools = request.tools;
        body.tool_choice = request.toolChoice || 'auto';
      }
      if (request.responseFormat && typeof request.responseFormat === 'object') {
        body.response_format = request.responseFormat;
      }
      return body;
    })()),
  };

  let response;
  try {
    response = await safeUpstreamFetch(url, requestInit);
  } catch (error) {
    if (isLocalIssuerCertError(error)) {
      await streamFromFullResponse(request, res);
      return;
    }
    throw error;
  }

  if (!response.ok) await buildUpstreamError(response);
  if (!response.body) throw new Error('Streaming response body is empty');

  sendSseHeaders(res);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const thoughtFilter = createStreamingThoughtFilter();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let eventEnd = buffer.indexOf('\n\n');
    while (eventEnd !== -1) {
      const event = buffer.slice(0, eventEnd).trim();
      buffer = buffer.slice(eventEnd + 2);

      const dataLines = event
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      const data = dataLines.join('\n');

      if (data === '[DONE]') {
        const tail = thoughtFilter('', true);
        if (tail) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tail } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (data) {
        try {
          writeSanitizedSsePayload(res, JSON.parse(data), thoughtFilter);
        } catch {
          // Ignore malformed upstream events; the client will continue reading valid chunks.
        }
      }

      eventEnd = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  const tail = thoughtFilter('', true);
  if (tail) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tail } }] })}\n\n`);
  }
  res.end();
};

const streamFromFullResponse = async (request, res) => {
  const response = await sendChat(request);
  sendSseHeaders(res);
  if (response.content) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: response.content } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
};

const fetchOpenAICompatibleModels = async (request) => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/models`;
  const response = await fetchWithTlsFallback(url, {
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
    },
  });
  if (!response.ok) await buildUpstreamError(response);
  const data = await response.json();
  return (data.data ?? []).map((item) => item.id).filter(Boolean).sort();
};

const fetchGoogleModels = async (request) => {
  const url = `${getGoogleBaseUrl(request).replace(/\/$/, '')}/models?key=${encodeURIComponent(request.apiKey)}`;
  const response = await fetchWithTlsFallback(url);
  if (!response.ok) await buildUpstreamError(response);
  const data = await response.json();
  return (data.models ?? [])
    .map((model) => model.name.replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
};

const fetchModels = async (request) => {
  if (OPENAI_COMPATIBLE_PROVIDERS.has(request.provider)) return fetchOpenAICompatibleModels(request);
  if (request.provider === 'google') return fetchGoogleModels(request);
  if (request.provider === 'anthropic') {
    throw new Error('Anthropic 当前未接入模型列表拉取，请手动填写模型名称');
  }
  throw new Error(`Unsupported provider: ${request.provider}`);
};

const parseSsePayloads = (raw) => {
  const events = raw.split(/\n\n+/).map((chunk) => chunk.trim()).filter(Boolean);
  const payloads = [];

  for (const event of events) {
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) continue;
    const body = dataLines.join('\n');
    if (body === '[DONE]') continue;

    try {
      payloads.push(JSON.parse(body));
    } catch {
      // ignore malformed event chunks
    }
  }

  return payloads;
};

const normalizeHeaders = (headers) => Object.fromEntries(
  Object.entries(headers || {}).map(([key, value]) => [key, String(value)])
);

const assertMcpConfig = (config) => {
  const transport = config.transport || 'stdio';
  if (transport === 'streamable-http' && !config.url?.trim()) {
    throw new Error('streamable-http MCP Server 需要填写 URL。');
  }
  if (transport === 'stdio' && !config.command?.trim()) {
    throw new Error('stdio MCP Server 需要填写 command。');
  }
};

const parseMcpResponse = async (response, expectedId) => {
  const sessionId = response.headers.get(MCP_SESSION_HEADER) || undefined;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    const raw = await response.text();
    const payloads = parseSsePayloads(raw);
    const matched = payloads.find((payload) => payload.id === expectedId) || payloads.find((payload) => payload.result || payload.error) || {};
    return { payload: matched, sessionId };
  }

  const payload = await response.json().catch(() => ({}));
  return { payload, sessionId };
};

const sendMcpRequest = async (connection, method, params, options = {}) => {
  const requestId = options.notification ? undefined : randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...connection.headers,
  };

  if (connection.sessionId) {
    headers[MCP_SESSION_HEADER] = connection.sessionId;
  }

  const response = await safeUpstreamFetch(connection.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(requestId ? { id: requestId } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  });

  if (!response.ok) await buildUpstreamError(response);
  const { payload, sessionId } = await parseMcpResponse(response, requestId);
  if (sessionId) {
    connection.sessionId = sessionId;
  }
  if (options.notification) return null;
  if (payload?.error) {
    throw new Error(payload.error.message || `MCP request failed: ${method}`);
  }
  return payload?.result ?? null;
};

const connectMcpServer = async (config, options = {}) => {
  const persistConnection = options.persist !== false;
  assertMcpConfig(config);
  if (persistConnection && mcpConnections.has(config.name)) {
    await disconnectMcpServer(config.name);
  }

  if ((config.transport || 'stdio') === 'stdio') {
    const connection = await createStdioMcpConnection(config);
    if (persistConnection) {
      mcpConnections.set(connection.name, connection);
    } else {
      await connection.close?.();
    }
    return connection.tools;
  }

  const connection = {
    id: randomUUID(),
    name: config.name,
    transport: config.transport,
    url: config.url.trim(),
    headers: normalizeHeaders(config.headers),
    riskLevel: config.riskLevel || 'read-only',
    toolRiskOverrides: config.toolRiskOverrides || {},
    toolEnabledOverrides: config.toolEnabledOverrides || {},
    connected: false,
    toolCount: 0,
    tools: [],
    sessionId: undefined,
  };

  const initializeResult = await sendMcpRequest(connection, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: {},
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
    },
    clientInfo: {
      name: 'opsdog-web',
      version: '0.1.0',
    },
  });

  if (!initializeResult) {
    throw new Error('MCP initialize 没有返回结果');
  }

  await sendMcpRequest(connection, 'notifications/initialized', {}, { notification: true });
  const toolsResult = await sendMcpRequest(connection, 'tools/list', {});
  connection.tools = normalizeMcpToolList(connection, toolsResult?.tools);
  connection.toolCount = connection.tools.length;

  // Resources
  connection.resources = [];
  connection.resourceCount = 0;
  if (initializeResult?.capabilities?.resources) {
    try {
      const resourcesResult = await sendMcpRequest(connection, 'resources/list', {});
      connection.resources = resourcesResult?.resources || [];
      connection.resourceCount = connection.resources.length;
    } catch {
      // non-fatal
    }
  }

  // Prompts
  connection.prompts = [];
  connection.promptCount = 0;
  if (initializeResult?.capabilities?.prompts) {
    try {
      const promptsResult = await sendMcpRequest(connection, 'prompts/list', {});
      connection.prompts = promptsResult?.prompts || [];
      connection.promptCount = connection.prompts.length;
    } catch {
      // non-fatal
    }
  }
  connection.connected = true;
  if (persistConnection) {
    mcpConnections.set(connection.name, connection);
  } else if (connection.sessionId) {
    await safeUpstreamFetch(connection.url, {
      method: 'DELETE',
      headers: {
        ...connection.headers,
        [MCP_SESSION_HEADER]: connection.sessionId,
      },
    }).catch(() => {});
  }
  return connection.tools;
};

const connectStoredMcpServer = async (name) => {
  const record = await getMcpServerRecord(name);
  if (!record) {
    throw new Error(`MCP 服务未找到：${name}`);
  }

  try {
    const tools = await connectMcpServer({
      name: record.name,
      transport: record.transport,
      command: record.command,
      args: record.args,
      env: record.env,
      url: record.url,
      headers: record.headers,
      riskLevel: record.riskLevel,
      toolRiskOverrides: record.toolRiskOverrides,
      toolEnabledOverrides: record.toolEnabledOverrides,
    });
    const now = new Date().toISOString();
    const runtime = mcpConnections.get(record.name);
    await updateMcpServerConnectionState(record.name, {
      tools,
      resources: runtime?.resources || [],
      resourceCount: runtime?.resourceCount || 0,
      prompts: runtime?.prompts || [],
      promptCount: runtime?.promptCount || 0,
      connectionStatus: 'connected',
      lastConnectedAt: now,
      lastToolRefreshAt: now,
      lastError: null,
    }, mcpConnections);
    const resCount = runtime?.resourceCount || 0;
    const prCount = runtime?.promptCount || 0;
    await appendMcpServerLog(record.name, `已连接，发现 ${tools.length} 个工具${resCount ? `、${resCount} 个资源` : ''}${prCount ? `、${prCount} 个提示` : ''}。`);
    await setMcpServerError(record.name, null);
    return await getMcpServerRecord(name, mcpConnections);
  } catch (error) {
    await updateMcpServerConnectionState(record.name, { connectionStatus: 'error' }, mcpConnections);
    await setMcpServerError(record.name, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

const disconnectMcpServer = async (name) => {
  const connection = mcpConnections.get(name);
  if (!connection) return;

  if (connection.transport === 'stdio') {
    await connection.close?.();
    mcpConnections.delete(name);
    return;
  }

  if (connection.sessionId) {
    try {
      await safeUpstreamFetch(connection.url, {
        method: 'DELETE',
        headers: {
          ...connection.headers,
          [MCP_SESSION_HEADER]: connection.sessionId,
        },
      });
    } catch {
      // best effort cleanup
    }
  }

  mcpConnections.delete(name);
};

const refreshMcpServerTools = async (name) => {
  const connection = mcpConnections.get(name);
  if (!connection?.connected) {
    throw new Error(`MCP Server 未连接：${name}`);
  }
  const toolsResult = connection.transport === 'stdio'
    ? await connection.request('tools/list', {})
    : await sendMcpRequest(connection, 'tools/list', {});
  connection.tools = normalizeMcpToolList(connection, toolsResult?.tools || []);
  connection.toolCount = connection.tools.length;

  // Refresh resources
  if (connection.readResource || connection.url) {
    try {
      const resourcesResult = connection.transport === 'stdio'
        ? await connection.request('resources/list', {})
        : await sendMcpRequest(connection, 'resources/list', {});
      connection.resources = resourcesResult?.resources || [];
      connection.resourceCount = connection.resources.length;
    } catch {
      // server may not support resources
    }
  }

  // Refresh prompts
  if (connection.getPrompt || connection.url) {
    try {
      const promptsResult = connection.transport === 'stdio'
        ? await connection.request('prompts/list', {})
        : await sendMcpRequest(connection, 'prompts/list', {});
      connection.prompts = promptsResult?.prompts || [];
      connection.promptCount = connection.prompts.length;
    } catch {
      // server may not support prompts
    }
  }

  await updateMcpServerConnectionState(name, {
    tools: connection.tools,
    resources: connection.resources || [],
    resourceCount: connection.resourceCount || 0,
    prompts: connection.prompts || [],
    promptCount: connection.promptCount || 0,
    connectionStatus: 'connected',
    lastToolRefreshAt: new Date().toISOString(),
    lastError: null,
  }, mcpConnections);
  const resCount = connection.resourceCount || 0;
  const prCount = connection.promptCount || 0;
  await appendMcpServerLog(name, `已刷新工具目录，发现 ${connection.tools.length} 个工具${resCount ? `、${resCount} 个资源` : ''}${prCount ? `、${prCount} 个提示` : ''}。`);
  await setMcpServerError(name, null);
  return await getMcpServerRecord(name, mcpConnections);
};

const testStoredMcpServer = async (name) => {
  const record = await getMcpServerRecord(name);
  if (!record) {
    throw new Error(`MCP 服务未找到：${name}`);
  }
  const tools = await connectMcpServer({
    name: record.name,
    transport: record.transport,
    command: record.command,
    args: record.args,
    env: record.env,
    url: record.url,
    headers: record.headers,
    riskLevel: record.riskLevel,
    toolRiskOverrides: record.toolRiskOverrides,
    toolEnabledOverrides: record.toolEnabledOverrides,
  }, { persist: false });
  await appendMcpServerLog(record.name, `测试连接成功，发现 ${tools.length} 个工具。`);
  return {
    ok: true,
    serverName: record.name,
    toolCount: tools.length,
    tools,
  };
};

const callMcpTool = async ({ serverName, toolName, argumentsValue }) => {
  const connection = mcpConnections.get(serverName);
  if (!connection) {
    throw new Error(`MCP Server 未连接：${serverName}`);
  }

  try {
    const matchedTool = (connection.tools || []).find((tool) => tool.name === toolName);
    const riskLevel = matchedTool?.riskLevel || connection.riskLevel || 'read-only';
    let result;
    if (connection.transport === 'stdio') {
      result = await connection.request('tools/call', {
        name: toolName,
        arguments: argumentsValue,
      });
    } else {
      result = await sendMcpRequest(connection, 'tools/call', {
        name: toolName,
        arguments: argumentsValue,
      });
    }
    await appendMcpServerLog(serverName, `调用 ${toolName} 成功。risk=${riskLevel} args=${JSON.stringify(argumentsValue || {}).slice(0, 500)}`);
    await setMcpServerError(serverName, null);
    return {
      content: result?.content || [],
      isError: result?.isError || false,
    };
  } catch (error) {
    await appendMcpServerLog(serverName, `调用 ${toolName} 失败。args=${JSON.stringify(argumentsValue || {}).slice(0, 500)} error=${error instanceof Error ? error.message : String(error)}`);
    await setMcpServerError(serverName, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

const readMcpResource = async (serverName, uri) => {
  const connection = mcpConnections.get(serverName);
  if (!connection) {
    throw new Error(`MCP Server 未连接：${serverName}`);
  }
  if (connection.transport === 'stdio') {
    const contents = await connection.readResource(uri);
    return { contents };
  }
  const result = await sendMcpRequest(connection, 'resources/read', { uri });
  return { contents: result?.contents || [] };
};

const getMcpPrompt = async (serverName, name, promptArgs) => {
  const connection = mcpConnections.get(serverName);
  if (!connection) {
    throw new Error(`MCP Server 未连接：${serverName}`);
  }
  if (connection.transport === 'stdio') {
    return await connection.getPrompt(name, promptArgs || {});
  }
  return await sendMcpRequest(connection, 'prompts/get', { name, arguments: promptArgs || {} });
};

const buildServerStatus = (server) => {
  if (server.type === 'python-script') {
    const runtime = getPythonRuntimeState(server.id);
    return {
      ...server,
      status: runtime?.status || (server.category === 'managed' ? 'stopped' : 'idle'),
      capabilities: {
        ...(server.capabilities || {}),
        recentLogs: runtime?.recentLogs || server.capabilities?.recentLogs || [],
      },
      runtimeState: runtime || undefined,
    };
  }

  const connection = mcpConnections.get(server.name);
  return {
    ...server,
    status: connection?.connected ? 'running' : 'idle',
    capabilities: {
      ...(server.capabilities || {}),
      tools: connection?.tools || server.capabilities?.tools || [],
      recentLogs: server.capabilities?.recentLogs || [],
    },
    runtimeState: connection
      ? {
          connected: connection.connected,
          toolCount: connection.toolCount,
        }
      : undefined,
  };
};

const listServers = async () => {
  const servers = await listServerDefinitions();
  return servers.map(buildServerStatus);
};

const getServerOrThrow = async (serverId) => {
  const server = await getServerDefinition(serverId);
  if (!server) {
    throw new Error(`Server 未找到：${serverId}`);
  }
  return buildServerStatus(server);
};

const syncServerBackToRegistry = async (serverId) => {
  const server = await getServerDefinition(serverId);
  if (!server) return null;
  return buildServerStatus(server);
};

const executeInstantServerOnce = async (server, payload = {}) => {
  const tools = Array.isArray(server.capabilities?.tools) ? server.capabilities.tools : [];
  const defaultTool = tools.find((tool) => tool.isDefault) || tools[0];
  if (!defaultTool) {
    throw new Error(`Server ${server.id} 没有可调用工具。`);
  }
  startInstantPythonServer(server, payload);
};

const startServer = async (serverId, payload = {}) => {
  const server = await getServerDefinition(serverId);
  if (!server) {
    throw new Error(`Server 未找到：${serverId}`);
  }

  if (server.type === 'python-script') {
    if (server.category === 'managed') {
      await startManagedPythonServer(server, payload);
      return await syncServerBackToRegistry(serverId);
    }
    await executeInstantServerOnce(server, payload);
    return await syncServerBackToRegistry(serverId);
  }

  await connectMcpServer({
    name: server.name,
    transport: server.transport,
    command: server.connection?.command || server.entry,
    args: server.connection?.args || getDefaultFilesystemArgs(),
    url: server.connection?.url,
    headers: server.connection?.headers,
    riskLevel: server.connection?.riskLevel,
    toolRiskOverrides: server.connection?.toolRiskOverrides,
  });
  return await syncServerBackToRegistry(serverId);
};

const stopServer = async (serverId) => {
  const server = await getServerDefinition(serverId);
  if (!server) {
    throw new Error(`Server 未找到：${serverId}`);
  }

  if (server.type === 'python-script') {
    await stopManagedPythonServer(serverId);
    return await syncServerBackToRegistry(serverId);
  }

  await disconnectMcpServer(server.name);
  return await syncServerBackToRegistry(serverId);
};

const restartServer = async (serverId, payload = {}) => {
  const server = await getServerDefinition(serverId);
  if (!server) {
    throw new Error(`Server 未找到：${serverId}`);
  }

  if (server.type === 'python-script') {
    if (server.category === 'managed') {
      await restartManagedPythonServer(server, payload);
    } else {
      await executeInstantServerOnce(server, payload);
    }
    return await syncServerBackToRegistry(serverId);
  }

  await disconnectMcpServer(server.name);
  await connectMcpServer({
    name: server.name,
    transport: server.transport,
    command: server.connection?.command || server.entry,
    args: server.connection?.args || getDefaultFilesystemArgs(),
    url: server.connection?.url,
    headers: server.connection?.headers,
    riskLevel: server.connection?.riskLevel,
    toolRiskOverrides: server.connection?.toolRiskOverrides,
  });
  return await syncServerBackToRegistry(serverId);
};

const callServerToolById = async (serverId, toolName, argumentsValue = {}) => {
  const server = await getServerDefinition(serverId);
  if (!server) {
    throw new Error(`Server 未找到：${serverId}`);
  }

  if (server.type === 'python-script') {
    const tools = Array.isArray(server.capabilities?.tools) ? server.capabilities.tools : [];
    const matchedTool = tools.find((tool) => tool.name === toolName) || tools[0];
    if (!matchedTool) {
      throw new Error(`Server ${serverId} 没有可调用工具`);
    }
    return await executePythonServerTool(server, matchedTool, argumentsValue);
  }

  return await callMcpTool({
    serverName: server.name,
    toolName,
    argumentsValue,
  });
};

const listMcpTools = async () => {
  return await listMcpToolCatalogFromRecords(mcpConnections);
};

const getMcpStatuses = async () => {
  const records = await listMcpServerRecords(mcpConnections);
  return records.map((server) => ({
    name: server.name,
    connected: server.connected,
    toolCount: server.toolCount,
  }));
};

const restoreEnabledServers = async () => {
  const servers = await listServerDefinitions();
  for (const server of servers) {
    if (server.enabled === false) continue;
    if (server.type === 'mcp-system') {
      try {
        await startServer(server.id, {});
      } catch (error) {
        console.warn(`Failed to auto-start system server ${server.id}:`, error);
      }
    }
  }
};

const restoreEnabledMcpServers = async () => {
  const records = await listMcpServerRecords();
  for (const record of records) {
    if (record.enabled === false) continue;
    if (record.autoConnect === false) continue;
    try {
      await connectStoredMcpServer(record.name);
    } catch (error) {
      console.warn(`Failed to auto-connect MCP server ${record.name}:`, error);
    }
  }
};

const ensureMergedAssetsReady = async () => {
  let initializedDatabase = null;
  try {
    const initialized = await initializeFoundationDatabase({
      databasePath: DATABASE_PATH,
      assetsDir: ASSETS_DIR,
    });
    initializedDatabase = initialized.database;
    activeAuthService = createAppAuthService({ database: initialized.database });
    activeAuthService.ensureSeedUser();
    activeUserDataStore = createUserDataStore(initialized.database);
    const sqliteAssetStore = createSqliteAssetMonitorStore(initialized.database);
    await sqliteAssetStore.syncLocalDevicesMonitorDefaults();
    await sqliteAssetStore.rebuildMergedDevices();
    activeAssetStore = sqliteAssetStore;
    configureDeviceWatcherStore(sqliteAssetStore);
    const secretStore = process.env.OPSDOG_DISABLE_SECRET_STORE === '1'
      ? createUnavailableSecretStore({ provider: 'disabled' })
      : await createKeyringSecretStore();
    activeConnectionProfileService = createConnectionProfileService(initialized.database, secretStore);
    const sshTransport = createSshTransport();
    const hostKeyService = createHostKeyService(initialized.database, createHostKeyChallengeStore());
    activeSshConnectionTestService = createSshConnectionTestService(
      initialized.database,
      secretStore,
      sshTransport,
      hostKeyService,
    );
    activeSshTerminalService = createSshTerminalService(
      initialized.database,
      secretStore,
      sshTransport,
      hostKeyService,
      createTerminalTokenStore(),
    );
    const telnetTransport = createTelnetTransport();
    activeTelnetConnectionTestService = createTelnetConnectionTestService(
      initialized.database,
      secretStore,
      telnetTransport,
    );
    const telnetTerminalService = createTelnetTerminalService(
      initialized.database,
      secretStore,
      telnetTransport,
      createTerminalTokenStore(),
    );
    activeRemoteTerminalService = createRemoteTerminalService({
      profileService: activeConnectionProfileService,
      sshTerminalService: activeSshTerminalService,
      telnetTerminalService,
    });
    activeSftpService = createSftpService(
      initialized.database,
      secretStore,
      sshTransport,
      hostKeyService,
    );
    console.log(`[database] SQLite asset store active: ${initialized.database.databasePath}`);
  } catch (error) {
    initializedDatabase?.close();
    activeAssetStore = legacyAssetStore;
    activeConnectionProfileService = null;
    activeSshConnectionTestService = null;
    activeSshTerminalService = null;
    activeTelnetConnectionTestService = null;
    activeRemoteTerminalService = null;
    activeSftpService = null;
    activeAuthService = null;
    activeUserDataStore = null;
    configureDeviceWatcherStore(null);
    console.warn('[database] SQLite asset activation failed; using JSON asset fallback:', error);
    try {
      const authInitialized = await initializeFoundationDatabase();
      activeAuthService = createAppAuthService({ database: authInitialized.database });
      activeAuthService.ensureSeedUser();
      activeUserDataStore = createUserDataStore(authInitialized.database);
      console.log(`[database] SQLite auth store active: ${authInitialized.database.databasePath}`);
    } catch (authError) {
      activeAuthService = null;
      activeUserDataStore = null;
      console.warn('[database] SQLite auth activation failed:', authError);
    }
    try {
      await legacyAssetStore.syncLocalDevicesMonitorDefaults();
      await legacyAssetStore.rebuildMergedDevices();
    } catch (fallbackError) {
      console.warn('Failed to rebuild JSON asset fallback view:', fallbackError);
    }
  }
};

// ── 定时任务调度引擎初始化 ──
const scheduleEngine = initScheduleEngine({
  callServerToolById,
  callMcpTool,
}, {});

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendError(res, 400, 'Invalid request');
    return;
  }
  if (!authorizeSessionRequest(req, res)) {
    return;
  }

  const isRemoteRequest = req.url.startsWith('/api/remote/');

  if (req.method === 'OPTIONS') {
    if (isRemoteRequest) {
      const originResult = remoteOriginPolicy.checkRequest(req);
      if (!originResult.allowed) {
        writeJsonResponse(res, 403, {
          error: 'Remote browser origin is not allowed.',
          details: { code: 'REMOTE_ORIGIN_FORBIDDEN' },
        }, REMOTE_CORS_HEADERS);
        return;
      }
      res.writeHead(204, {
        ...REMOTE_CORS_HEADERS,
        ...originResult.corsHeaders,
      });
      res.end();
      return;
    }
    res.writeHead(204, DEFAULT_CORS_HEADERS);
    res.end();
    return;
  }

  let remoteCorsHeaders = null;
  if (isRemoteRequest) {
    const originResult = remoteOriginPolicy.checkRequest(req);
    if (!originResult.allowed) {
      writeJsonResponse(res, 403, {
        error: 'Remote browser origin is not allowed.',
        details: { code: 'REMOTE_ORIGIN_FORBIDDEN' },
      }, REMOTE_CORS_HEADERS);
      return;
    }
    remoteCorsHeaders = {
      ...REMOTE_CORS_HEADERS,
      ...originResult.corsHeaders,
    };
  }

  const sendRouteJson = (statusCode, payload) => {
    if (remoteCorsHeaders) {
      writeJsonResponse(res, statusCode, payload, remoteCorsHeaders);
      return;
    }
    sendJson(res, statusCode, payload);
  };
  const sendRouteError = (statusCode, message, details) => {
    sendRouteJson(statusCode, { error: message, details });
  };

  try {
    const routeUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const routePathname = routeUrl.pathname;
    const authContext = req.authContext || null;

    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'opsdog-server',
        now: new Date().toISOString(),
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/auth/session') {
      const sessionContext = activeAuthService?.authenticateSessionToken(getSessionToken(req));
      sendJson(res, 200, sessionContext
        ? { authenticated: true, user: sessionContext.user }
        : { authenticated: false });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/auth/login') {
      const payload = await readJsonBody(req);
      const result = requireAuthService().login(payload, {
        userAgent: req.headers['user-agent'] || '',
        remoteAddress: req.socket.remoteAddress || '',
      });
      if (!result.ok) {
        sendError(res, result.statusCode || 400, result.message || '密码修改失败。');
        return;
      }
      sendJson(res, 200, { ok: true, user: result.user }, {
        'Set-Cookie': buildAuthCookie(result.sessionToken, { maxAgeSeconds: 7 * 24 * 60 * 60 }),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/auth/logout') {
      requireAuthService().logout(getSessionToken(req));
      sendJson(res, 200, { ok: true }, {
        'Set-Cookie': buildAuthCookie('', { maxAgeSeconds: 0 }),
      });
      return;
    }

    if (req.method === 'PATCH' && req.url === '/api/auth/password') {
      const result = requireAuthService().changePassword(authContext?.user?.id, await readJsonBody(req));
      if (!result.ok) {
        sendError(res, result.statusCode || 400, result.message || '密码修改失败。');
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && routePathname === '/api/users') {
      sendJson(res, 200, { users: requireAuthService().listUsers() });
      return;
    }

    if (req.method === 'POST' && routePathname === '/api/users') {
      try {
        const user = requireAuthService().createUser(await readJsonBody(req));
        sendJson(res, 200, user);
      } catch (error) {
        sendError(res, error?.statusCode || 400, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (routePathname.startsWith('/api/users/')) {
      const userPath = routePathname.slice('/api/users/'.length);
      const segments = userPath.split('/').filter(Boolean).map(decodeURIComponent);
      const userId = segments[0] || '';
      if (!userId) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      try {
        if (req.method === 'PATCH' && segments.length === 1) {
          sendJson(res, 200, requireAuthService().updateUser(userId, await readJsonBody(req)));
          return;
        }
        if (req.method === 'POST' && segments.length === 2 && segments[1] === 'password') {
          sendJson(res, 200, requireAuthService().resetUserPassword(userId, await readJsonBody(req)));
          return;
        }
      } catch (error) {
        sendError(res, error?.statusCode || 400, error instanceof Error ? error.message : String(error));
        return;
      }
    }

    if (req.method === 'GET' && routePathname === '/api/config') {
      sendJson(res, 200, requireUserDataStore().loadConfig(authContext?.user?.id));
      return;
    }

    if (req.method === 'PUT' && routePathname === '/api/config') {
      sendJson(res, 200, requireUserDataStore().saveConfig(authContext?.user?.id, await readJsonBody(req)));
      return;
    }

    if (req.method === 'GET' && routePathname === '/api/conversations') {
      sendJson(res, 200, requireUserDataStore().loadConversations(authContext?.user?.id));
      return;
    }

    if (req.method === 'PUT' && routePathname === '/api/conversations') {
      const payload = await readJsonBody(req);
      const conversations = Array.isArray(payload) ? payload : (payload.conversations || []);
      sendJson(res, 200, requireUserDataStore().saveConversations(authContext?.user?.id, conversations));
      return;
    }

    if (req.method === 'GET' && routePathname === '/api/conversations/summaries') {
      sendJson(res, 200, requireUserDataStore().listConversationSummaries(authContext?.user?.id));
      return;
    }

    if (routePathname.startsWith('/api/conversations/')) {
      const conversationPath = routePathname.slice('/api/conversations/'.length);
      const segments = conversationPath.split('/').filter(Boolean).map(decodeURIComponent);
      const conversationId = segments[0] || '';
      if (!conversationId) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      const dataStore = requireUserDataStore();
      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'messages') {
        sendJson(res, 200, dataStore.loadConversationMessages(authContext?.user?.id, conversationId));
        return;
      }
      if (req.method === 'PUT' && segments.length === 1) {
        sendJson(res, 200, dataStore.upsertConversation(authContext?.user?.id, await readJsonBody(req)));
        return;
      }
      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'messages') {
        const payload = await readJsonBody(req);
        const message = payload.message || payload;
        sendJson(res, 200, dataStore.appendConversationMessage(authContext?.user?.id, conversationId, message));
        return;
      }
      if (req.method === 'PATCH' && segments.length === 3 && segments[1] === 'messages') {
        sendJson(
          res,
          200,
          dataStore.updateConversationMessage(authContext?.user?.id, conversationId, segments[2], await readJsonBody(req)),
        );
        return;
      }
      if (req.method === 'PUT' && segments.length === 2 && segments[1] === 'messages') {
        const payload = await readJsonBody(req);
        const messages = Array.isArray(payload) ? payload : (payload.messages || []);
        sendJson(res, 200, dataStore.replaceConversationMessages(authContext?.user?.id, conversationId, messages));
        return;
      }
      if (req.method === 'DELETE' && segments.length === 1) {
        sendJson(res, 200, dataStore.deleteConversation(authContext?.user?.id, conversationId));
        return;
      }
    }

    if (req.method === 'POST' && routePathname === '/api/auth/password') {
      sendError(res, 405, '请使用 PATCH /api/auth/password。');
      return;
    }

    if (isRemoteRequest) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const segments = url.pathname.split('/').filter(Boolean);
      const profileService = requireConnectionProfileService();
      const isSftpRoute = (
        (segments[2] === 'profiles' && segments[4] === 'sftp-sessions')
        || segments[2] === 'sftp-sessions'
      );
      if (isSftpRoute && await handleSftpHttpRoute({
        req,
        res,
        url,
        segments,
        sftpService: requireSftpService(),
        corsHeaders: remoteCorsHeaders,
      })) {
        return;
      }

      if (await handleAiRemoteRoute({
        req,
        segments,
        readJsonBody,
        sendJson: sendRouteJson,
        terminalService: requireRemoteTerminalService(),
      })) {
        return;
      }

      if (segments.length === 5
          && segments[0] === 'api'
          && segments[1] === 'remote'
          && segments[2] === 'devices'
          && segments[4] === 'profiles') {
        const deviceId = decodeURIComponent(segments[3]);
        if (req.method === 'GET') {
          sendRouteJson(200, await profileService.listProfiles(deviceId));
          return;
        }
        if (req.method === 'POST') {
          const payload = await readJsonBody(req);
          sendRouteJson(200, await profileService.createProfile(deviceId, payload));
          return;
        }
      }

      if (segments.length === 4
          && segments[0] === 'api'
          && segments[1] === 'remote'
          && segments[2] === 'profiles') {
        const profileId = decodeURIComponent(segments[3]);
        if (req.method === 'PATCH') {
          const payload = await readJsonBody(req);
          sendRouteJson(200, await profileService.updateProfile(profileId, payload));
          return;
        }
        if (req.method === 'DELETE') {
          sendRouteJson(200, await profileService.deleteProfile(profileId));
          return;
        }
      }

      if (segments.length === 6
          && segments[0] === 'api'
          && segments[1] === 'remote'
          && segments[2] === 'profiles'
          && segments[4] === 'host-key') {
        const profileId = decodeURIComponent(segments[3]);
        const sshService = requireSshConnectionTestService();
        if (req.method === 'POST' && segments[5] === 'probe') {
          sendRouteJson(200, await sshService.probeHostKey(profileId));
          return;
        }
        if (req.method === 'POST' && segments[5] === 'trust') {
          const payload = await readJsonBody(req);
          sendRouteJson(200, sshService.trustHostKey(profileId, payload));
          return;
        }
      }

      if (segments.length === 5
          && segments[0] === 'api'
          && segments[1] === 'remote'
          && segments[2] === 'profiles') {
        const profileId = decodeURIComponent(segments[3]);
        const sshService = requireSshConnectionTestService();
        if (req.method === 'GET' && segments[4] === 'host-keys') {
          sendRouteJson(200, sshService.listHostKeys(profileId));
          return;
        }
        if (req.method === 'POST' && segments[4] === 'test') {
          sendRouteJson(200, await sshService.testConnection(profileId));
          return;
        }
        if (req.method === 'POST' && segments[4] === 'test-connection') {
          const profile = profileService.getProfile(profileId);
          if (profile?.protocol === 'telnet') {
            sendRouteJson(200, await requireTelnetConnectionTestService().testConnection(profileId));
            return;
          }
          sendRouteJson(200, await sshService.testConnection(profileId));
          return;
        }
        if (req.method === 'POST' && segments[4] === 'terminal-token') {
          const payload = await readJsonBody(req);
          sendRouteJson(200, await requireRemoteTerminalService().issueTerminalToken(profileId, payload));
          return;
        }
      }
    }

    if (req.method === 'GET' && req.url.startsWith('/api/assets/devices')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await listAssetDevices(query);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/monitor/status')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const items = await activeAssetStore.readDeviceStatus();
      let filtered = items || [];
      if (query.status) filtered = filtered.filter((i) => i.status === query.status);
      if (query.source) filtered = filtered.filter((i) => i.source === query.source);
      sendJson(res, 200, { code: 0, items: filtered });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/assets/merged')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await activeAssetStore.listMergedDevices(query);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/assets/rebuild') {
      const rebuilt = await activeAssetStore.rebuildMergedDevices();
      sendJson(res, 200, rebuilt);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/assets/devices') {
      const payload = await readJsonBody(req);
      const created = await activeAssetStore.createLocalManagedAssetDevice(payload);
      sendJson(res, 200, created);
      return;
    }

    if (req.url.startsWith('/api/assets/devices/')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const deviceId = decodeURIComponent(url.pathname.slice('/api/assets/devices/'.length));
      if (!deviceId) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      if (req.method === 'PATCH') {
        const payload = await readJsonBody(req);
        const updated = await activeAssetStore.updateLocalManagedAssetDevice(deviceId, payload);
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === 'DELETE') {
        const result = await activeAssetStore.deleteLocalManagedAssetDevice(deviceId);
        sendJson(res, 200, result);
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/api/reports') {
      sendJson(res, 200, { reports: await listReports() });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/reports/draft') {
      const payload = await readJsonBody(req);
      const draft = await createReportDraft({
        payload,
        sendChat,
        skillPackages: await listSkillPackages(),
      });
      sendJson(res, 200, draft);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/reports/export') {
      const payload = await readJsonBody(req);
      sendJson(res, 200, await exportReportDraft(payload));
      return;
    }

    if (req.method === 'DELETE' && req.url === '/api/reports') {
      await clearReports();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      const payload = await readJsonBody(req);
      const data = await sendChat(payload);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat/stream') {
      const payload = await readJsonBody(req);
      if (OPENAI_COMPATIBLE_PROVIDERS.has(payload.provider)) {
        await streamOpenAICompatible(payload, res);
      } else {
        await streamFromFullResponse(payload, res);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/models') {
      const payload = await readJsonBody(req);
      const models = await fetchModels(payload);
      sendJson(res, 200, { models });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai-tasks/generate') {
      const abortController = new AbortController();
      req.on('aborted', () => abortController.abort());
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });
      const payload = await readJsonBody(req);
      if (abortController.signal.aborted) return;
      const result = await generateAiTask({ ...payload, signal: abortController.signal }, sendChat);
      if (abortController.signal.aborted || res.writableEnded || res.destroyed) return;
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai-tasks/validate') {
      const payload = await readJsonBody(req);
      const result = await validateAiTask(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai-tasks/create') {
      const payload = await readJsonBody(req);
      const result = await createAiTask(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/status') {
      sendJson(res, 200, { statuses: await getMcpStatuses() });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/servers') {
      sendJson(res, 200, { servers: await listMcpServerRecords(mcpConnections) });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/servers') {
      const payload = await readJsonBody(req);
      const created = await createMcpServerRecord(payload, mcpConnections);
      sendJson(res, 200, created);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/servers/import-json') {
      const payload = await readJsonBody(req);
      const result = await importMcpServersFromJson(String(payload.content || ''), mcpConnections);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/servers/import-dxt') {
      const payload = await readJsonBody(req);
      const result = await importMcpServersFromDxt(payload.fileName, payload.fileContentBase64, mcpConnections);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/market') {
      sendJson(res, 200, { items: await listMcpMarketItems() });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/tools/catalog') {
      sendJson(res, 200, { tools: await listMcpTools() });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/tools') {
      sendJson(res, 200, { tools: await listMcpTools() });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/connect') {
      const payload = await readJsonBody(req);
      const tools = await connectMcpServer(payload);
      sendJson(res, 200, { tools });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/disconnect') {
      const payload = await readJsonBody(req);
      await disconnectMcpServer(payload.serverName);
      await updateMcpServerConnectionState(payload.serverName, { connectionStatus: 'disconnected' }, mcpConnections).catch(() => {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/call') {
      const payload = await readJsonBody(req);
      const result = await callMcpTool(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.url.startsWith('/api/mcp/servers/')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const mcpPath = url.pathname.slice('/api/mcp/servers/'.length);
      const segments = mcpPath.split('/').filter(Boolean);
      const serverName = segments[0] ? decodeURIComponent(segments[0]) : '';

      if (!serverName) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      if (req.method === 'PATCH' && segments.length === 1) {
        const payload = await readJsonBody(req);
        const updated = await updateMcpServerRecord(serverName, payload, mcpConnections);
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === 'DELETE' && segments.length === 1) {
        await disconnectMcpServer(serverName).catch(() => {});
        await deleteMcpServerRecord(serverName);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'connect') {
        const record = await connectStoredMcpServer(serverName);
        sendJson(res, 200, record);
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'disconnect') {
        await disconnectMcpServer(serverName);
        await updateMcpServerConnectionState(serverName, { connectionStatus: 'disconnected' }, mcpConnections);
        await appendMcpServerLog(serverName, '已断开连接。');
        const record = await getMcpServerRecord(serverName, mcpConnections);
        sendJson(res, 200, record);
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'test') {
        const result = await testStoredMcpServer(serverName);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && segments.length === 3 && segments[1] === 'tools' && segments[2] === 'refresh') {
        const record = await refreshMcpServerTools(serverName);
        sendJson(res, 200, record);
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'resources') {
        const record = await getMcpServerRecord(serverName, mcpConnections);
        sendJson(res, 200, { resources: record?.resources || [] });
        return;
      }

      if (req.method === 'POST' && segments.length === 3 && segments[1] === 'resources' && segments[2] === 'read') {
        const payload = await readJsonBody(req);
        const result = await readMcpResource(serverName, String(payload.uri || ''));
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'prompts') {
        const record = await getMcpServerRecord(serverName, mcpConnections);
        sendJson(res, 200, { prompts: record?.prompts || [] });
        return;
      }

      if (req.method === 'POST' && segments.length === 3 && segments[1] === 'prompts' && segments[2] === 'get') {
        const payload = await readJsonBody(req);
        const result = await getMcpPrompt(serverName, String(payload.name || ''), payload.arguments || {});
        sendJson(res, 200, result);
        return;
      }
    }

    if (req.url.startsWith('/api/mcp/market/')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const marketPath = url.pathname.slice('/api/mcp/market/'.length);
      const segments = marketPath.split('/').filter(Boolean);
      const itemId = segments[0] ? decodeURIComponent(segments[0]) : '';
      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'install') {
        const created = await installMcpMarketItem(itemId, mcpConnections);
        sendJson(res, 200, created);
        return;
      }
    }

    if (req.method === 'POST' && req.url === '/api/servers/upload-script') {
      const payload = await readJsonBody(req);
      const result = await uploadScriptServer(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/skill-packages') {
      const packages = await listSkillPackages();
      sendJson(res, 200, { packages });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/skill-packages/preview') {
      const payload = await readJsonBody(req);
      const preview = await previewSkillPackage(payload);
      sendJson(res, 200, preview);
      return;
    }

    if (req.url.startsWith('/api/skill-packages/')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const skillPackagePath = url.pathname.slice('/api/skill-packages/'.length);
      const segments = skillPackagePath.split('/').filter(Boolean).map(decodeURIComponent);
      const skillPackageId = segments[0] || '';
      if (!skillPackageId) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'install') {
        const installed = await installSkillPackage(skillPackageId);
        sendJson(res, 200, installed);
        return;
      }

      if (req.method === 'PATCH' && segments.length === 1) {
        const payload = await readJsonBody(req);
        const updated = await updateSkillPackage(skillPackageId, payload);
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === 'DELETE' && segments.length === 1) {
        await deleteSkillPackage(skillPackageId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && segments.length === 3 && segments[1] === 'dependencies' && segments[2] === 'install') {
        const updated = await installSkillPackageDependencies(skillPackageId);
        sendJson(res, 200, updated);
        return;
      }
    }

    if (req.method === 'POST' && req.url === '/api/workflows/execute') {
      const payload = await readJsonBody(req);
      const modelConfig = payload.model || {};
      const aiReport = modelConfig.provider && modelConfig.apiKey && modelConfig.modelName
        ? async (systemPrompt, userPrompt) => {
            const response = await sendChat({
              provider: modelConfig.provider,
              apiKey: modelConfig.apiKey,
              baseUrl: modelConfig.baseUrl || undefined,
              modelName: modelConfig.modelName,
              maxTokens: modelConfig.maxTokens || 4096,
              temperature: modelConfig.temperature ?? 0.3,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
            });
            return response.content || '';
          }
        : null;
      const result = await executeWorkflowById(payload.workflowId, {
        requestText: payload.requestText,
        context: payload.context,
        listServers,
        callServerToolById,
        listMcpTools,
        callMcpTool,
        sendChat,
        model: modelConfig,
        aiReport,
      });
      sendJson(res, 200, result);
      return;
    }

    // ── 定时任务 ──
    if (req.method === 'GET' && req.url === '/api/schedules') {
      const schedules = await scheduleEngine.listSchedules();
      sendJson(res, 200, { schedules });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/schedules') {
      const payload = await readJsonBody(req);
      const schedule = await scheduleEngine.createSchedule(payload);
      sendJson(res, 201, schedule);
      return;
    }

    if (req.method === 'PATCH' && req.url.startsWith('/api/schedules/')) {
      const id = req.url.split('/api/schedules/')[1];
      if (!id) { sendError(res, 400, '缺少定时任务 ID'); return; }
      const payload = await readJsonBody(req);
      const schedule = await scheduleEngine.updateSchedule(id, payload);
      sendJson(res, 200, schedule);
      return;
    }

    if (req.method === 'DELETE' && req.url.startsWith('/api/schedules/')) {
      const id = req.url.split('/api/schedules/')[1];
      if (!id) { sendError(res, 400, '缺少定时任务 ID'); return; }
      const result = await scheduleEngine.deleteSchedule(id);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/trigger') && req.url.startsWith('/api/schedules/')) {
      const id = req.url.split('/api/schedules/')[1]?.replace('/trigger', '');
      if (!id) { sendError(res, 400, '缺少定时任务 ID'); return; }
      const history = await scheduleEngine.triggerSchedule(id);
      if (!history) { sendError(res, 404, '定时任务未找到或已停用'); return; }
      sendJson(res, 200, history);
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/schedules/') && req.url.endsWith('/history')) {
      const id = req.url.split('/api/schedules/')[1]?.replace('/history', '');
      if (!id) { sendError(res, 400, '缺少定时任务 ID'); return; }
      const history = await scheduleEngine.getScheduleHistory(id);
      sendJson(res, 200, { history });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/servers') {
      const servers = await listServers();
      sendJson(res, 200, { servers });
      return;
    }

    if (req.url.startsWith('/api/reports/')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const reportPath = url.pathname.slice('/api/reports/'.length);
      const segments = reportPath.split('/').filter(Boolean);
      const fileName = segments[0] ? decodeURIComponent(segments[0]) : '';

      if (!fileName) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'download') {
        const file = await readReportDownload(fileName);
        sendBinary(res, 200, file.body, {
          'Content-Type': file.mimeType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
        });
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'preview') {
        const file = await readReportDownload(fileName);
        sendBinary(res, 200, file.body, {
          'Content-Type': file.mimeType,
          'Content-Disposition': `inline; filename="${encodeURIComponent(file.fileName)}"`,
        });
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'content') {
        const report = await readReportContent(fileName);
        sendJson(res, 200, report);
        return;
      }

      if (req.method === 'DELETE' && segments.length === 1) {
        await deleteReport(fileName);
        sendJson(res, 200, { ok: true, fileName });
        return;
      }
    }

    if (req.url.startsWith('/api/servers/')) {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const serverPath = url.pathname.slice('/api/servers/'.length);
      const segments = serverPath.split('/').filter(Boolean);
      const serverId = segments[0] ? decodeURIComponent(segments[0]) : '';

      if (!serverId) {
        sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
        return;
      }

      if (req.method === 'GET' && segments.length === 1) {
        const serverRecord = await getServerOrThrow(serverId);
        sendJson(res, 200, serverRecord);
        return;
      }

      if (req.method === 'GET' && segments.length === 2 && segments[1] === 'script') {
        const script = await readServerScript(serverId);
        sendJson(res, 200, { script });
        return;
      }

      if (req.method === 'PATCH' && segments.length === 1) {
        const payload = await readJsonBody(req);
        const updated = await updateServerDefinition(serverId, payload);
        sendJson(res, 200, buildServerStatus(updated));
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'duplicate') {
        const payload = await readJsonBody(req);
        const duplicated = await duplicateServerDefinition(serverId, payload);
        sendJson(res, 200, buildServerStatus(duplicated));
        return;
      }

      if (req.method === 'DELETE' && segments.length === 1) {
        const removed = await deleteServerDefinition(serverId);
        if (removed.type === 'mcp-system') {
          await disconnectMcpServer(removed.name);
        } else if (removed.type === 'python-script') {
          try {
            await stopManagedPythonServer(serverId);
          } catch {
            // ignore stop failures while deleting
          }
        }
        sendJson(res, 200, { ok: true, serverId });
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'start') {
        const payload = await readJsonBody(req);
        const record = await startServer(serverId, payload);
        sendJson(res, 200, record);
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'stop') {
        const record = await stopServer(serverId);
        sendJson(res, 200, record);
        return;
      }

      if (req.method === 'POST' && segments.length === 2 && segments[1] === 'restart') {
        const payload = await readJsonBody(req);
        const record = await restartServer(serverId, payload);
        sendJson(res, 200, record);
        return;
      }

      if (req.method === 'POST' && segments.length === 4 && segments[1] === 'tools' && segments[3] === 'call') {
        const payload = await readJsonBody(req);
        const toolName = decodeURIComponent(segments[2]);
        const result = await callServerToolById(serverId, toolName, payload.argumentsValue || payload);
        sendJson(res, 200, result);
        return;
      }
    }

    if (await tryServeBuiltWeb(req, res)) {
      return;
    }

    sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
  } catch (error) {
    if (isAbortError(error)) {
      if (!res.writableEnded && !res.destroyed) sendRouteError(499, '请求已取消。');
      return;
    }
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const details = error?.code ? { code: error.code } : undefined;
    sendRouteError(statusCode, error instanceof Error ? error.message : String(error), details);
  }
});

await ensureMergedAssetsReady();

const terminalWebSocket = createTerminalWebSocket({
  openTerminal: (...args) => requireRemoteTerminalService().openTerminal(...args),
  write: (...args) => requireRemoteTerminalService().write(...args),
  resize: (...args) => requireRemoteTerminalService().resize(...args),
  close: (...args) => requireRemoteTerminalService().close(...args),
}, {
  isOriginAllowed: (request) => remoteOriginPolicy.checkRequest(request).allowed,
});
server.on('upgrade', (request, socket, head) => {
  if (!authorizeSessionUpgrade(request, socket)) return;
  if (!terminalWebSocket.handleUpgrade(request, socket, head)) socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`OpsDog backend listening on http://${HOST}:${PORT}`);
  void restoreEnabledServers();
  void restoreEnabledMcpServers();
  void scheduleEngine.loadAllSchedules();
  void startDeviceWatcher();
});
