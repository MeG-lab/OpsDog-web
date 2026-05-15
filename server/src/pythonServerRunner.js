import { spawn } from 'node:child_process';
import path from 'node:path';

const APP_ROOT = process.cwd();
const RECENT_LOG_LIMIT = 60;
const DEFAULT_TIMEOUT_MS = 15000;

const runtimeEntries = new Map();

const nowIso = () => new Date().toISOString();

const resolveEntry = (entry) => path.isAbsolute(entry) ? entry : path.join(APP_ROOT, entry);

const createRuntimeInfo = (server) => ({
  status: server.category === 'managed' ? 'stopped' : 'idle',
  pid: null,
  startedAt: null,
  stoppedAt: null,
  lastOutputAt: null,
  lastLevel: null,
  exitCode: null,
  recentLogs: [],
  lastError: null,
});

const ensureRuntimeEntry = (server) => {
  if (!runtimeEntries.has(server.id)) {
    runtimeEntries.set(server.id, {
      info: createRuntimeInfo(server),
      process: null,
    });
  }
  return runtimeEntries.get(server.id);
};

const pushRecentLog = (info, line) => {
  info.recentLogs = [...info.recentLogs, line].slice(-RECENT_LOG_LIMIT);
  info.lastOutputAt = nowIso();
};

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const getServerProtocolMode = (server, tool) =>
  tool?.adapter?.stdoutMode === 'plain-text'
    ? 'cli-adapter'
    : tool?.outputMode === 'json-events'
      ? 'json-stream'
      : server.capabilities?.protocol?.mode || (server.category === 'managed' ? 'json-stream' : 'json-tool');

const getTimeoutMs = (server, payload = {}) =>
  Number(
    payload.timeoutMs
    || server.capabilities?.timeouts?.toolCallMs
    || server.capabilities?.timeoutMs
    || DEFAULT_TIMEOUT_MS,
  );

const getExecutionEnv = (payload = {}) => {
  const overrides = payload.envOverrides && typeof payload.envOverrides === 'object'
    ? payload.envOverrides
    : {};
  const allowed = {};

  for (const [key, rawValue] of Object.entries(overrides)) {
    if (!['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'].includes(key)) {
      continue;
    }
    const value = String(rawValue ?? '').trim();
    if (value) {
      allowed[key] = value;
    }
  }

  return {
    ...process.env,
    ...allowed,
  };
};

const buildCliArgsFromPayload = (payload = {}, tool = {}) => {
  const adapter = tool.adapter || {};
  const argv = [];
  const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
  const fieldValues = {
    ...(input || {}),
    ...(payload.fields && typeof payload.fields === 'object' ? payload.fields : {}),
  };

  if (Array.isArray(adapter.argv)) {
    const positional = [];
    for (const rule of adapter.argv) {
      const sourceKey = typeof rule.source === 'string' ? rule.source : null;
      const value = sourceKey ? fieldValues[sourceKey] : rule.value;
      if (value === undefined || value === null || value === '') continue;

      if (rule.kind === 'flag' && value === true) {
        argv.push(String(rule.flag || value));
        continue;
      }

      if (rule.kind === 'positional') {
        if (Array.isArray(value)) {
          positional.push(...value.map((item) => String(item)));
        } else {
          positional.push(String(value));
        }
        continue;
      }

      if (rule.flag) {
        argv.push(String(rule.flag));
      }
      if (Array.isArray(value)) {
        argv.push(...value.map((item) => String(item)));
      } else if (rule.kind !== 'flag') {
        argv.push(String(value));
      }
    }

    if (positional.length > 0) {
      argv.push(...positional);
    }
  }

  if (adapter.passthroughArgs !== false) {
    const passthrough = Array.isArray(payload.args) ? payload.args.map((item) => String(item)) : [];
    argv.push(...passthrough);
  }

  return argv;
};

const toTextResult = (text, meta = {}, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
  meta,
});

const toJsonResult = (payload, meta = {}, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  isError,
  meta,
});

const updateStatusFromPayload = (info, payload) => {
  const nextStatus = payload?.status || payload?.level;
  if (typeof nextStatus === 'string') {
    info.status = nextStatus;
    info.lastLevel = nextStatus;
  }
};

export const listPythonRuntimeStates = () => runtimeEntries;

export const getPythonRuntimeState = (serverId) => runtimeEntries.get(serverId)?.info || null;

export const executePythonServerTool = async (server, tool, payload = {}) => {
  const runtime = ensureRuntimeEntry(server);
  const info = runtime.info;
  const startedAtMs = Date.now();
  const timeoutMs = getTimeoutMs(server, payload);
  const protocolMode = getServerProtocolMode(server, tool);
  const adapter = tool?.adapter || server.capabilities?.adapter || {};
  const args = protocolMode === 'cli-adapter'
    ? buildCliArgsFromPayload(payload, tool)
    : Array.isArray(payload.args) ? payload.args.map((item) => String(item)) : [];
  const entry = resolveEntry(server.entry);
  const executionEnv = getExecutionEnv(payload);

  return await new Promise((resolve) => {
    const child = spawn(server.runtime || 'python3', [entry, ...args], {
      cwd: APP_ROOT,
      env: executionEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    info.status = 'starting';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      info.status = 'error';
      info.lastError = `Python Server 执行超时（${timeoutMs}ms）`;
      finish({
        content: [{ type: 'text', text: info.lastError }],
        isError: true,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      info.status = 'error';
      info.lastError = error.message;
      finish({
        content: [{ type: 'text', text: `Python Server 启动失败：${error.message}` }],
        isError: true,
      });
    });

    child.on('exit', (code) => {
      const elapsed = Date.now() - startedAtMs;
      const rawStdout = stdout.trim();
      const rawStderr = stderr.trim();
      const parsed = rawStdout ? parseJsonLine(rawStdout) : null;
      const errorText = rawStderr || (code && code !== 0 ? `Python Server 退出码 ${code}` : '');

      info.exitCode = code ?? 0;
      info.status = code === 0 ? 'idle' : 'error';
      info.lastError = errorText || null;
      if (rawStdout) {
        pushRecentLog(info, rawStdout);
      }
      if (rawStderr) {
        pushRecentLog(info, JSON.stringify({ time: nowIso(), level: 'error', message: rawStderr }));
      }

      if (protocolMode === 'cli-adapter') {
        finish(toJsonResult({
          toolName: tool?.name || server.id,
          protocolMode,
          outputMode: tool?.outputMode || 'plain-text',
          result: parsed || rawStdout,
          stderr: rawStderr || undefined,
          exitCode: code ?? 0,
          executionTimeMs: elapsed,
        }, {
          elapsed,
          parsed,
          stdout: rawStdout,
          stderr: rawStderr,
          exitCode: code ?? 0,
          protocolMode,
        }, code !== 0));
        return;
      }

      if (!parsed) {
        finish(toTextResult(
          code === 0
            ? `Python Server 未返回合法 ${protocolMode === 'json-stream' ? '事件 JSON' : 'JSON'}。stdout=${rawStdout || '<empty>'}`
            : `Python Server 执行失败。stderr=${errorText || '<empty>'}`,
          { elapsed, stdout: rawStdout, stderr: rawStderr, exitCode: code ?? 0, protocolMode },
          true,
        ));
        return;
      }

      finish(toJsonResult({
        toolName: tool?.name || server.id,
        protocolMode,
        outputMode: tool?.outputMode || (protocolMode === 'json-stream' ? 'json-events' : 'json-object'),
        result: parsed,
        stderr: rawStderr || undefined,
        exitCode: code ?? 0,
        executionTimeMs: elapsed,
      }, {
        elapsed,
        parsed,
        stderr: rawStderr,
        exitCode: code ?? 0,
        protocolMode,
      }, code !== 0));
    });

    if (protocolMode !== 'cli-adapter' || adapter.stdinMode === 'json') {
      child.stdin.write(JSON.stringify(payload.input || payload, null, 2));
      child.stdin.end('\n');
      return;
    }

    child.stdin.end();
  });
};

export const startManagedPythonServer = async (server, payload = {}) => {
  const runtime = ensureRuntimeEntry(server);
  if (runtime.process && runtime.info.pid) {
    return runtime.info;
  }

  const primaryTool = Array.isArray(server.capabilities?.tools) ? server.capabilities.tools[0] : null;
  const protocolMode = getServerProtocolMode(server, primaryTool);
  const adapter = primaryTool?.adapter || server.capabilities?.adapter || {};
  const args = protocolMode === 'cli-adapter'
    ? buildCliArgsFromPayload(payload, primaryTool)
    : Array.isArray(payload.args) ? payload.args.map((item) => String(item)) : [];
  const entry = resolveEntry(server.entry);
  const executionEnv = getExecutionEnv(payload);
  const child = spawn(server.runtime || 'python3', [entry, ...args], {
    cwd: APP_ROOT,
    env: executionEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  runtime.process = child;
  runtime.info.status = 'starting';
  runtime.info.pid = child.pid ?? null;
  runtime.info.startedAt = nowIso();
  runtime.info.stoppedAt = null;
  runtime.info.exitCode = null;
  runtime.info.lastError = null;

  let stdoutBuffer = '';
  let stderrBuffer = '';

  const flushStdout = () => {
    let lineEnd = stdoutBuffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = stdoutBuffer.slice(0, lineEnd).trim();
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      if (line) {
        pushRecentLog(runtime.info, line);
        const parsed = parseJsonLine(line);
        if (protocolMode === 'json-stream' && parsed) {
          updateStatusFromPayload(runtime.info, parsed);
        } else if (runtime.info.status === 'starting') {
          runtime.info.status = 'running';
        }
      }
      lineEnd = stdoutBuffer.indexOf('\n');
    }
  };

  const flushStderr = () => {
    let lineEnd = stderrBuffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = stderrBuffer.slice(0, lineEnd).trim();
      stderrBuffer = stderrBuffer.slice(lineEnd + 1);
      if (line) {
        runtime.info.status = 'error';
        runtime.info.lastError = line;
        pushRecentLog(runtime.info, JSON.stringify({ time: nowIso(), level: 'error', message: line }));
      }
      lineEnd = stderrBuffer.indexOf('\n');
    }
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    flushStdout();
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
    flushStderr();
  });

  child.on('error', (error) => {
    runtime.info.status = 'error';
    runtime.info.lastError = error.message;
    runtime.info.exitCode = 1;
    runtime.info.pid = null;
    runtime.process = null;
  });

  child.on('exit', (code, signal) => {
    if (stdoutBuffer.trim()) {
      pushRecentLog(runtime.info, stdoutBuffer.trim());
      stdoutBuffer = '';
    }
    if (stderrBuffer.trim()) {
      pushRecentLog(runtime.info, JSON.stringify({ time: nowIso(), level: 'error', message: stderrBuffer.trim() }));
      stderrBuffer = '';
    }

    runtime.info.exitCode = code ?? null;
    runtime.info.pid = null;
    runtime.info.stoppedAt = nowIso();
    runtime.process = null;

    if (runtime.info.status === 'stopping') {
      runtime.info.status = 'stopped';
      return;
    }

    if (signal || (typeof code === 'number' && code !== 0)) {
      runtime.info.status = 'error';
      runtime.info.lastError = `Python Server 退出异常（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`;
      pushRecentLog(runtime.info, JSON.stringify({ time: nowIso(), level: 'error', message: runtime.info.lastError }));
    } else if (!['running', 'attention', 'warning', 'recovered'].includes(runtime.info.status)) {
      runtime.info.status = 'stopped';
    }
  });

  if (protocolMode !== 'cli-adapter' || adapter.stdinMode === 'json') {
    child.stdin.write(JSON.stringify(payload.input || payload, null, 2));
    child.stdin.end('\n');
  } else {
    child.stdin.end();
  }
  return runtime.info;
};

export const stopManagedPythonServer = async (serverId) => {
  const runtime = runtimeEntries.get(serverId);
  if (!runtime) {
    throw new Error(`Server 未运行：${serverId}`);
  }
  if (!runtime.process || !runtime.info.pid) {
    runtime.info.status = 'stopped';
    runtime.info.stoppedAt = nowIso();
    return runtime.info;
  }
  runtime.info.status = 'stopping';
  runtime.process.kill('SIGTERM');
  return runtime.info;
};

export const restartManagedPythonServer = async (server, payload = {}) => {
  const runtime = runtimeEntries.get(server.id);
  if (runtime?.process && runtime.info.pid) {
    runtime.info.status = 'stopping';
    runtime.process.kill('SIGTERM');
  }
  runtimeEntries.delete(server.id);
  return await startManagedPythonServer(server, payload);
};
