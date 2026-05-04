import { spawn } from 'node:child_process';
import path from 'node:path';

const managedTasks = new Map();
const RECENT_LOG_LIMIT = 40;

const nowIso = () => new Date().toISOString();

const resolveScriptPath = (scriptPath) => {
  if (!scriptPath) {
    throw new Error('scriptPath is required');
  }
  return path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
};

const createBaseTaskInfo = (taskId, scriptPath, args = []) => ({
  taskId,
  scriptPath,
  logPath: null,
  args,
  status: 'starting',
  pid: null,
  startedAt: nowIso(),
  stoppedAt: null,
  lastOutputAt: null,
  lastLevel: null,
  exitCode: null,
  recentLogs: [],
});

const pushRecentLog = (task, line) => {
  task.recentLogs = [...task.recentLogs, line].slice(-RECENT_LOG_LIMIT);
};

const normalizeStatusFromLevel = (level) => {
  switch (level) {
    case 'running':
      return 'running';
    case 'attention':
      return 'attention';
    case 'warning':
      return 'warning';
    case 'recovered':
      return 'recovered';
    default:
      return null;
  }
};

const tryParseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const createPythonProcess = (scriptPath, args = []) => {
  const resolvedPath = resolveScriptPath(scriptPath);
  const child = spawn('python3', [resolvedPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, resolvedPath };
};

const wireManagedTaskProcess = (entry) => {
  const task = entry.info;
  const child = entry.process;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const flushStdoutLines = () => {
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line) {
        pushRecentLog(task, line);
        task.lastOutputAt = nowIso();
        const parsed = tryParseJsonLine(line);
        const level = parsed?.level;
        const status = normalizeStatusFromLevel(level);
        if (level) task.lastLevel = level;
        if (status && task.status !== 'stopping') task.status = status;
      }

      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  };

  const flushStderrLines = () => {
    let newlineIndex = stderrBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stderrBuffer.slice(0, newlineIndex).trim();
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);

      if (line) {
        pushRecentLog(task, JSON.stringify({ time: nowIso(), level: 'error', message: line }));
        task.lastOutputAt = nowIso();
        if (task.status !== 'stopping') {
          task.lastLevel = 'error';
          task.status = 'error';
        }
      }

      newlineIndex = stderrBuffer.indexOf('\n');
    }
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    flushStdoutLines();
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
    flushStderrLines();
  });

  child.on('error', (error) => {
    task.status = 'error';
    task.exitCode = 1;
    task.stoppedAt = nowIso();
    task.pid = null;
    task.lastLevel = 'error';
    entry.process = null;
    pushRecentLog(task, JSON.stringify({ time: nowIso(), level: 'error', message: `task spawn failed: ${error.message}` }));
  });

  child.on('exit', (code, signal) => {
    if (stdoutBuffer.trim()) {
      pushRecentLog(task, stdoutBuffer.trim());
      stdoutBuffer = '';
    }
    if (stderrBuffer.trim()) {
      pushRecentLog(task, JSON.stringify({ time: nowIso(), level: 'error', message: stderrBuffer.trim() }));
      stderrBuffer = '';
    }

    task.exitCode = code;
    task.pid = null;
    task.stoppedAt = nowIso();
    entry.process = null;

    if (task.status === 'stopping') {
      task.status = 'stopped';
      return;
    }

    if (signal || (typeof code === 'number' && code !== 0)) {
      task.status = 'error';
      task.lastLevel = 'error';
      pushRecentLog(task, JSON.stringify({
        time: nowIso(),
        level: 'error',
        message: `task exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      }));
    } else if (!['running', 'attention', 'warning', 'recovered'].includes(task.status)) {
      task.status = 'stopped';
    }
  });
};

export const listManagedTasks = () => Array.from(managedTasks.values()).map((entry) => entry.info);

export const getManagedTask = (taskId) => managedTasks.get(taskId)?.info ?? null;

export const restoreManagedTasks = () => listManagedTasks();

export const startManagedTask = async (taskId, scriptPath, args = []) => {
  const existing = managedTasks.get(taskId);
  if (existing?.process && existing.info.pid) {
    return existing.info;
  }

  const { child, resolvedPath } = createPythonProcess(scriptPath, args);
  const info = createBaseTaskInfo(taskId, resolvedPath, args);
  info.pid = child.pid ?? null;

  const entry = { info, process: child };
  managedTasks.set(taskId, entry);
  wireManagedTaskProcess(entry);
  return info;
};

export const stopManagedTask = async (taskId) => {
  const existing = managedTasks.get(taskId);
  if (!existing) {
    throw new Error(`Managed task not found: ${taskId}`);
  }

  if (!existing.process || !existing.info.pid) {
    existing.info.status = 'stopped';
    existing.info.stoppedAt = nowIso();
    return existing.info;
  }

  existing.info.status = 'stopping';
  existing.process.kill('SIGTERM');
  return existing.info;
};

export const restartManagedTask = async (taskId, scriptPath, args = []) => {
  const existing = managedTasks.get(taskId);
  if (existing?.process && existing.info.pid) {
    existing.info.status = 'stopping';
    existing.process.kill('SIGTERM');
  }

  managedTasks.delete(taskId);
  return await startManagedTask(taskId, scriptPath, args);
};

export const executeInstantSkill = async (skillName, scriptPath, args = []) => {
  const startedAt = Date.now();
  const { child, resolvedPath } = createPythonProcess(scriptPath, args);

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: `Failed to execute ${skillName} (${resolvedPath}): ${error.message}`,
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      });
    });

    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        executionTimeMs: Date.now() - startedAt,
        truncated: false,
      });
    });
  });
};
