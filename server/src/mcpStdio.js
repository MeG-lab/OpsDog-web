import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_STDIO_TIMEOUT_MS = 15000;

const encodeMessage = (message) => {
  return `${JSON.stringify(message)}\n`;
};

const parseMessages = (state, chunk, onMessage) => {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (true) {
    const newlineIndex = state.buffer.indexOf('\n');
    if (newlineIndex === -1) return;

    const body = state.buffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '').trim();
    state.buffer = state.buffer.slice(newlineIndex + 1);
    if (!body) continue;

    try {
      onMessage(JSON.parse(body));
    } catch {
      // ignore malformed payloads from child process
    }
  }
};

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const buildStderrSummary = (stderrLines) => {
  if (!stderrLines?.length) return '';
  return stderrLines.slice(-5).join('\n');
};

export const createStdioMcpConnection = async (config) => {
  const child = spawn(config.command, config.args || [], {
    env: { ...process.env, ...(config.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = {
    id: randomUUID(),
    name: config.name,
    transport: 'stdio',
    command: config.command,
    args: config.args || [],
    riskLevel: config.riskLevel || 'read-only',
    toolRiskOverrides: config.toolRiskOverrides || {},
    connected: false,
    toolCount: 0,
    tools: [],
    child,
    buffer: Buffer.alloc(0),
    pending: new Map(),
    stderrLines: [],
  };

  const buildProcessError = (message) => {
    const stderrSummary = buildStderrSummary(state.stderrLines);
    return new Error(stderrSummary ? `${message}\n最近 stderr：\n${stderrSummary}` : message);
  };

  const rejectAllPending = (message) => {
    for (const deferred of state.pending.values()) {
      deferred.reject(buildProcessError(message));
    }
    state.pending.clear();
  };

  child.on('error', (error) => {
    rejectAllPending(`MCP 子进程启动失败：${error.message}`);
  });

  child.on('exit', (code, signal) => {
    state.connected = false;
    rejectAllPending(`MCP 子进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    state.stderrLines.push(text);
    if (state.stderrLines.length > 20) {
      state.stderrLines = state.stderrLines.slice(-20);
    }
  });

  child.stdout.on('data', (chunk) => {
    parseMessages(state, chunk, (payload) => {
      if (payload.id && state.pending.has(payload.id)) {
        const deferred = state.pending.get(payload.id);
        state.pending.delete(payload.id);
        if (payload.error) {
          deferred.reject(new Error(payload.error.message || 'MCP stdio request failed'));
        } else {
          deferred.resolve(payload.result ?? null);
        }
      }
    });
  });

  const send = (message) => {
    child.stdin.write(encodeMessage(message), 'utf8');
  };

  const request = async (method, params) => {
    const id = randomUUID();
    const deferred = createDeferred();
    state.pending.set(id, deferred);
    const timeoutMs = Number(config.timeoutMs || DEFAULT_STDIO_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      deferred.reject(buildProcessError(`MCP stdio 请求超时：${method}（${timeoutMs}ms）`));
    }, timeoutMs);
    send({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeout);
    }
  };

  const notify = (method, params) => {
    send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  };

  try {
    const initializeResult = await request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'opsdog-web',
        version: '0.1.0',
      },
    });

    if (!initializeResult) {
      throw buildProcessError('MCP stdio initialize 没有返回结果');
    }

    notify('notifications/initialized', {});
    const toolsResult = await request('tools/list', {});
    state.connected = true;
    state.tools = (toolsResult?.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
      serverName: state.name,
      riskLevel: state.toolRiskOverrides?.[tool.name] || state.riskLevel || 'read-only',
    }));
    state.toolCount = state.tools.length;

    return {
      ...state,
      request,
      notify,
      close: async () => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      },
    };
  } catch (error) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    throw error;
  }
};
