import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAppConfig } from '../../config/appConfig.js';
import { createStdioMcpConnection } from './mcpStdio.js';
import {
  executeInstantSkill,
  getManagedTask,
  listManagedTasks,
  restartManagedTask,
  restoreManagedTasks,
  startManagedTask,
  stopManagedTask,
} from './taskRunner.js';

const { serverHost: HOST, serverPort: PORT } = getAppConfig(process.env);

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
const MCP_PROTOCOL_VERSION = '2024-11-05';
const mcpConnections = new Map();
const CURL_STATUS_MARKER = '__OPSDOG_CURL_STATUS__';
const APP_ROOT = process.cwd();

const getOpenAIBaseUrl = (request) => request.baseUrl?.trim() || 'https://api.openai.com/v1';
const getGoogleBaseUrl = (request) => request.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta';

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
};

const sendError = (res, statusCode, message, details) => {
  sendJson(res, statusCode, { error: message, details });
};

const sendSseHeaders = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
    if (current?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
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

const streamWithCurlFallback = async (url, init, res) => {
  const method = init.method || 'GET';
  const headers = init.headers || {};
  const args = ['-sS', '-N', '-L', '-X', method, url];

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }

  if (init.body) {
    args.push('--data-raw', String(init.body));
  }

  const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  sendSseHeaders(res);

  child.stdout.on('data', (chunk) => {
    res.write(chunk);
  });

  child.stderr.on('data', () => {
    // ignore curl progress/errors here; failure will surface on exit
  });

  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`curl stream fallback failed with exit code ${code}`));
      }
    });
  });

  res.end();
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
    body.tool_choice = 'auto';
  }

  const finalResponse = await fetchWithTlsFallback(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
  });

  if (!response.ok) await buildUpstreamError(response);
  const data = await response.json();
  return {
    content: data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
  };
};

const sendChat = async (request) => {
  if (OPENAI_COMPATIBLE_PROVIDERS.has(request.provider)) return sendOpenAICompatible(request);
  if (request.provider === 'anthropic') return sendAnthropic(request);
  if (request.provider === 'google') return sendGoogle(request);
  throw new Error(`Unsupported provider: ${request.provider}`);
};

const streamOpenAICompatible = async (request, res) => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/chat/completions`;
  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.modelName,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
    }),
  };

  let response;
  try {
    response = await safeUpstreamFetch(url, requestInit);
  } catch (error) {
    if (isLocalIssuerCertError(error)) {
      await streamWithCurlFallback(url, requestInit, res);
      return;
    }
    throw error;
  }

  if (!response.ok) await buildUpstreamError(response);
  if (!response.body) throw new Error('Streaming response body is empty');

  sendSseHeaders(res);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value, { stream: true }));
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

const normalizeScriptBasename = (fileName) => path.basename(fileName, path.extname(fileName))
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '');

const scriptDirectoryForKind = (kind) => path.join(APP_ROOT, 'scripts', kind === 'managed' ? 'managed' : 'instant');

const buildSkillShellFromScript = ({ name, kind, description, scriptPath }) => ({
  name,
  taskKind: kind,
  entryScript: scriptPath,
  description,
  triggers: [],
  defaultArgs: [],
  instructions: `# ${name}\n\n- 脚本：\`${scriptPath}\`\n- 说明：${description}\n`,
});

const uploadScriptAsset = async ({ kind, fileName, description, fileContentBase64 }) => {
  const normalizedKind = kind === 'managed' ? 'managed' : 'instant';
  const trimmedDescription = String(description || '').trim();
  if (!trimmedDescription) {
    throw new Error('说明不能为空，请补充一句脚本用途说明。');
  }

  const extension = path.extname(fileName || '').toLowerCase();
  if (extension !== '.py') {
    throw new Error('当前仅支持上传 .py 脚本文件。');
  }

  const normalizedName = normalizeScriptBasename(fileName || '');
  if (!normalizedName) {
    throw new Error('脚本文件名不合法，请使用字母、数字、下划线或连字符。');
  }

  const directory = scriptDirectoryForKind(normalizedKind);
  await mkdir(directory, { recursive: true });

  const scriptPath = path.join(directory, `${normalizedName}.py`);
  const metaPath = path.join(directory, `${normalizedName}.meta.json`);

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

  const now = new Date().toISOString();
  await writeFile(scriptPath, scriptBuffer);
  await writeFile(metaPath, JSON.stringify({
    name: normalizedName,
    description: trimmedDescription,
    kind: normalizedKind,
    uploadedAt: now,
  }, null, 2));

  void buildSkillShellFromScript({
    name: normalizedName,
    kind: normalizedKind,
    description: trimmedDescription,
    scriptPath: path.posix.join('scripts', normalizedKind, `${normalizedName}.py`),
  });

  return {
    name: normalizedName,
    kind: normalizedKind,
    description: trimmedDescription,
    scriptPath: path.posix.join('scripts', normalizedKind, `${normalizedName}.py`),
    metaPath: path.posix.join('scripts', normalizedKind, `${normalizedName}.meta.json`),
    skillDraftAvailable: false,
  };
};

const normalizeMcpTools = (connection, tools) => (tools || []).map((tool) => ({
  name: tool.name,
  description: tool.description || '',
  inputSchema: tool.inputSchema || {},
  serverName: connection.name,
  riskLevel: connection.toolRiskOverrides?.[tool.name] || connection.riskLevel || 'read-only',
}));

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

const connectMcpServer = async (config) => {
  assertMcpConfig(config);
  if (mcpConnections.has(config.name)) {
    await disconnectMcpServer(config.name);
  }

  if ((config.transport || 'stdio') === 'stdio') {
    const connection = await createStdioMcpConnection(config);
    mcpConnections.set(connection.name, connection);
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
    connected: false,
    toolCount: 0,
    tools: [],
    sessionId: undefined,
  };

  const initializeResult = await sendMcpRequest(connection, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
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
  connection.tools = normalizeMcpTools(connection, toolsResult?.tools);
  connection.toolCount = connection.tools.length;
  connection.connected = true;
  mcpConnections.set(connection.name, connection);
  return connection.tools;
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

const listMcpTools = () => Array.from(mcpConnections.values()).flatMap((connection) => connection.tools);

const getMcpStatuses = () => Array.from(mcpConnections.values()).map((connection) => ({
  name: connection.name,
  connected: connection.connected,
  toolCount: connection.toolCount,
}));

const callMcpTool = async ({ serverName, toolName, argumentsValue }) => {
  const connection = mcpConnections.get(serverName);
  if (!connection) {
    throw new Error(`MCP Server 未连接：${serverName}`);
  }

  if (connection.transport === 'stdio') {
    const result = await connection.request('tools/call', {
      name: toolName,
      arguments: argumentsValue,
    });

    return {
      content: result?.content || [],
      isError: result?.isError || false,
    };
  }

  const result = await sendMcpRequest(connection, 'tools/call', {
    name: toolName,
    arguments: argumentsValue,
  });

  return {
    content: result?.content || [],
    isError: result?.isError || false,
  };
};

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendError(res, 400, 'Invalid request');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'opsdog-server',
        now: new Date().toISOString(),
      });
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

    if (req.method === 'GET' && req.url === '/api/mcp/status') {
      sendJson(res, 200, { statuses: getMcpStatuses() });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/tools') {
      sendJson(res, 200, { tools: listMcpTools() });
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
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/mcp/call') {
      const payload = await readJsonBody(req);
      const result = await callMcpTool(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tasks') {
      sendJson(res, 200, { tasks: listManagedTasks() });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tasks/start') {
      const payload = await readJsonBody(req);
      const task = await startManagedTask(payload.taskId, payload.scriptPath, payload.args || []);
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tasks/restart') {
      const payload = await readJsonBody(req);
      const task = await restartManagedTask(payload.taskId, payload.scriptPath, payload.args || []);
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tasks/stop') {
      const payload = await readJsonBody(req);
      const task = await stopManagedTask(payload.taskId);
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tasks/restore') {
      sendJson(res, 200, { tasks: restoreManagedTasks() });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/tasks/')) {
      const taskId = decodeURIComponent(req.url.slice('/api/tasks/'.length));
      const task = getManagedTask(taskId);
      if (!task) {
        sendError(res, 404, `Managed task not found: ${taskId}`);
        return;
      }
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/skills/execute') {
      const payload = await readJsonBody(req);
      const result = await executeInstantSkill(payload.skillName, payload.scriptPath, payload.args || []);
      sendJson(res, 200, { result });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/scripts/upload') {
      const payload = await readJsonBody(req);
      const result = await uploadScriptAsset(payload);
      sendJson(res, 200, result);
      return;
    }

    sendError(res, 404, `Route not found: ${req.method} ${req.url}`);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpsDog backend listening on http://${HOST}:${PORT}`);
});
