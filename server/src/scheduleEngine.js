import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import cron from 'node-cron';

const APP_ROOT = process.cwd();
const SCHEDULES_DIR = path.join(APP_ROOT, 'server', 'data', 'schedules');
const HISTORY_DIR = path.join(SCHEDULES_DIR, 'history');
const MAX_HISTORY = 50;

// Injected dependencies — set by init()
let deps = null;

const nowIso = () => new Date().toISOString();

const schedulePath = (id) => path.join(SCHEDULES_DIR, `${id}.json`);
const historyPath = (id) => path.join(HISTORY_DIR, `${id}.json`);

const ensureDirs = async () => {
  await mkdir(SCHEDULES_DIR, { recursive: true });
  await mkdir(HISTORY_DIR, { recursive: true });
};

// ── cron 注册表（内存态） ──
const cronJobs = new Map(); // scheduleId → cron.ScheduledTask

const registerCron = (schedule) => {
  unregisterCron(schedule.id);
  if (!schedule.enabled) return;

  const job = cron.schedule(
    schedule.schedule,
    () => {
      void executeSchedule(schedule.id);
    },
    {
      timezone: schedule.timezone || 'Asia/Shanghai',
      scheduled: true,
    },
  );
  cronJobs.set(schedule.id, job);
};

const unregisterCron = (id) => {
  const existing = cronJobs.get(id);
  if (existing) {
    existing.stop();
    cronJobs.delete(id);
  }
};

// ── 步执行引擎 ──
const evalCondition = (expression, context) => {
  try {
    const fn = new Function('context', `return (${expression});`);
    return !!fn(context);
  } catch {
    return false;
  }
};

const executeStep = async (step, context) => {
  const startedAt = Date.now();
  let result;

  switch (step.type) {
    case 'instant-script': {
      if (!deps.callServerToolById) {
        throw new Error('scheduleEngine 未初始化 callServerToolById');
      }
      result = await deps.callServerToolById(step.serverId, step.toolName, {
        input: step.args || {},
      });
      // pythonServerRunner returns { content: [{type:'text', text:'...'}], isError }
      const text = Array.isArray(result?.content)
        ? result.content.map((c) => c?.text || '').join('\n')
        : '';
      return {
        ok: !result?.isError,
        output: text,
        elapsedMs: Date.now() - startedAt,
        error: result?.isError ? text : null,
      };
    }

    case 'mcp-tool': {
      if (!deps.callMcpTool) {
        throw new Error('scheduleEngine 未初始化 callMcpTool');
      }
      result = await deps.callMcpTool({
        serverName: step.serverName,
        toolName: step.toolName,
        argumentsValue: step.args || {},
      });
      const mcpText = Array.isArray(result?.content)
        ? result.content.map((c) => c?.text || '').join('\n')
        : JSON.stringify(result || {});
      return {
        ok: !result?.isError,
        output: mcpText,
        elapsedMs: Date.now() - startedAt,
        error: result?.isError ? mcpText : null,
      };
    }

    case 'skill-package': {
      if (!deps.callServerToolById) {
        throw new Error('scheduleEngine 未初始化 callServerToolById');
      }
      const serverId = `skillpkg_${step.skillPackageId}`;
      result = await deps.callServerToolById(serverId, step.toolName, {
        input: step.args || {},
      });
      const skillText = Array.isArray(result?.content)
        ? result.content.map((c) => c?.text || '').join('\n')
        : '';
      return {
        ok: !result?.isError,
        output: skillText,
        elapsedMs: Date.now() - startedAt,
        error: result?.isError ? skillText : null,
      };
    }

    case 'http-request': {
      try {
        const init = {
          method: (step.options?.method || 'GET'),
          headers: (step.options?.headers || {}),
        };
        if (step.options?.body) {
          init.body = typeof step.options.body === 'string'
            ? step.options.body
            : JSON.stringify(step.options.body);
        }
        const response = await fetch(step.url, init);
        const body = await response.text();
        return {
          ok: response.ok,
          output: body,
          elapsedMs: Date.now() - startedAt,
          error: response.ok ? null : `HTTP ${response.status}: ${body.slice(0, 500)}`,
        };
      } catch (error) {
        return {
          ok: false,
          output: '',
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'delay': {
      const ms = Math.min(Math.max(step.ms || 1000, 100), 60000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return {
        ok: true,
        output: `Waited ${ms}ms`,
        elapsedMs: Date.now() - startedAt,
        error: null,
      };
    }

    case 'condition': {
      const matched = evalCondition(step.condition || 'false', context);
      const branch = matched ? (step.onTrue || []) : (step.onFalse || []);
      const branchResults = [];
      let branchOk = true;
      for (const subStep of branch) {
        const subResult = await executeStep(subStep, context);
        branchResults.push(subResult);
        if (!subResult.ok) {
          branchOk = false;
          if (subStep.onFailure !== 'continue') break;
        }
      }
      return {
        ok: branchOk,
        output: JSON.stringify({ matched, branch: matched ? 'onTrue' : 'onFalse', results: branchResults }),
        elapsedMs: Date.now() - startedAt,
        error: branchOk ? null : '条件分支执行失败',
      };
    }

    default:
      return {
        ok: false,
        output: '',
        elapsedMs: 0,
        error: `未知 step 类型: ${step.type}`,
      };
  }
};

// ── 编排执行 ──
const executeSteps = async (steps, context) => {
  const results = [];
  let overallOk = true;

  for (const step of steps) {
    const result = await executeStep(step, context);
    context[step.id] = result;
    results.push({ stepId: step.id, ...result });

    if (!result.ok && step.onFailure !== 'continue') {
      overallOk = false;
      break;
    }
  }

  return { ok: overallOk, results };
};

const executeSchedule = async (scheduleId) => {
  await ensureDirs();

  let schedule;
  try {
    const raw = await readFile(schedulePath(scheduleId), 'utf8');
    schedule = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!schedule.enabled) return null;

  const startedAt = Date.now();
  const context = {};
  let status = 'success';
  let stepResults = [];

  try {
    const outcome = await executeSteps(schedule.steps || [], context);
    stepResults = outcome.results;
    status = outcome.ok ? 'success' : 'failure';
  } catch (error) {
    status = 'failure';
    stepResults.push({
      stepId: '__error__',
      ok: false,
      output: '',
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 写历史
  const entry = {
    scheduleId,
    triggeredAt: nowIso(),
    status,
    elapsedMs: Date.now() - startedAt,
    steps: stepResults,
  };

  let history = [];
  try {
    const raw = await readFile(historyPath(scheduleId), 'utf8');
    history = JSON.parse(raw);
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  await writeFile(historyPath(scheduleId), JSON.stringify(history, null, 2), 'utf8');

  // 更新 lastRunAt / nextRunAt
  schedule.lastRunAt = entry.triggeredAt;
  schedule.nextRunAt = computeNextRun(schedule);
  schedule.updatedAt = nowIso();
  await writeFile(schedulePath(scheduleId), JSON.stringify(schedule, null, 2), 'utf8');

  // 失败通知
  if (status !== 'success' && schedule.errorHandling?.notifyOnFailure) {
    try {
      if (deps.addSystemAnnouncement) {
        deps.addSystemAnnouncement(
          `定时任务「${schedule.name}」执行失败`,
          'warning',
        );
      }
    } catch {
      // 通知是 best-effort
    }
  }

  return entry;
};

// ── Cron 解析 ──
const computeNextRun = (schedule) => {
  try {
    const parsed = cron.parseExpression(schedule.schedule);
    const next = parsed.next().toISOString();
    return next;
  } catch {
    return null;
  }
};

const isValidCron = (expression) => {
  try {
    return cron.validate(expression);
  } catch {
    return false;
  }
};

// ── 公开 API ──
export const listSchedules = async () => {
  await ensureDirs();
  const entries = await readdir(SCHEDULES_DIR, { withFileTypes: true }).catch(() => []);
  const schedules = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(SCHEDULES_DIR, entry.name), 'utf8');
      schedules.push(JSON.parse(raw));
    } catch {
      // skip malformed
    }
  }
  return schedules.sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

export const createSchedule = async (data, callbacks = {}) => {
  await ensureDirs();
  if (!data.name?.trim()) throw new Error('定时任务名称不能为空。');
  if (!isValidCron(data.schedule)) throw new Error('无效的 Cron 表达式。');

  const id = `sched_${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  const schedule = {
    id,
    name: data.name.trim(),
    enabled: data.enabled !== false,
    schedule: data.schedule,
    timezone: data.timezone || 'Asia/Shanghai',
    steps: Array.isArray(data.steps) ? data.steps : [],
    errorHandling: {
      retryCount: data.errorHandling?.retryCount ?? 2,
      retryBackoffMs: data.errorHandling?.retryBackoffMs ?? 5000,
      notifyOnFailure: data.errorHandling?.notifyOnFailure ?? true,
    },
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
  };

  schedule.nextRunAt = computeNextRun(schedule);
  await writeFile(schedulePath(id), JSON.stringify(schedule, null, 2), 'utf8');
  registerCron(schedule);

  if (callbacks.onChanged) callbacks.onChanged(schedule);

  return schedule;
};

export const updateSchedule = async (id, data, callbacks = {}) => {
  await ensureDirs();

  let current;
  try {
    const raw = await readFile(schedulePath(id), 'utf8');
    current = JSON.parse(raw);
  } catch {
    throw new Error(`定时任务未找到：${id}`);
  }

  if (data.schedule !== undefined && !isValidCron(data.schedule)) {
    throw new Error('无效的 Cron 表达式。');
  }

  const merged = {
    ...current,
    ...data,
    errorHandling: {
      ...current.errorHandling,
      ...(data.errorHandling || {}),
    },
    updatedAt: nowIso(),
  };

  merged.nextRunAt = computeNextRun(merged);
  await writeFile(schedulePath(id), JSON.stringify(merged, null, 2), 'utf8');
  registerCron(merged);

  if (callbacks.onChanged) callbacks.onChanged(merged);

  return merged;
};

export const deleteSchedule = async (id) => {
  await ensureDirs();
  unregisterCron(id);
  await rm(schedulePath(id), { force: true }).catch(() => {});
  await rm(historyPath(id), { force: true }).catch(() => {});
  return { ok: true };
};

export const triggerSchedule = async (id) => {
  await ensureDirs();
  return await executeSchedule(id);
};

export const getScheduleHistory = async (id) => {
  await ensureDirs();
  try {
    const raw = await readFile(historyPath(id), 'utf8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
};

export const loadAllSchedules = async (callbacks = {}) => {
  await ensureDirs();
  const schedules = await listSchedules();
  for (const schedule of schedules) {
    registerCron(schedule);
  }
  if (callbacks.onChanged) {
    for (const schedule of schedules) {
      callbacks.onChanged(schedule);
    }
  }
  return schedules;
};

export const init = (dep, callbacks = {}) => {
  deps = dep;
  return {
    listSchedules,
    createSchedule: (data) => createSchedule(data, callbacks),
    updateSchedule: (id, data) => updateSchedule(id, data, callbacks),
    deleteSchedule,
    triggerSchedule,
    getScheduleHistory,
    loadAllSchedules: () => loadAllSchedules(callbacks),
  };
};
