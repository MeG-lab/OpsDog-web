import type { AssetDevice, ChatExecutionCandidate, ChatExecutionPlan, ChatRouteDecision, Conversation, Message, Skill, SkillArgsValidationResult, SkillPackageRecord } from '../../types';
import type {
  AiTaskDraftCreateRequest,
  AiTaskDraftGenerateRequest,
  AiTaskDraftGenerateResponse,
  AiTaskDraftValidateRequest,
  AiTaskDraftValidateResponse,
  ApiErrorResponse,
  AssetDeviceUpsertRequest,
  AssetDeviceListResponse,
  ChatRequest,
  ChatResponse,
  HealthResponse,
  MCPConnectRequest,
  MCPConnectResponse,
  MCPMarketResponse,
  MCPServerCreateRequest,
  MCPServerImportDxtRequest,
  MCPServerImportDxtResponse,
  MCPServerImportJsonRequest,
  MCPServerImportJsonResponse,
  MCPServerListResponse,
  MCPServerUpdateRequest,
  MCPStatusResponse,
  MCPToolCallRequest,
  MCPToolCallResponse,
  ModelListRequest,
  ModelListResponse,
  ReportContentResponse,
  ReportListResponse,
  SkillCreateRequest,
  SkillPackageListResponse,
  SkillPackagePreviewRequest,
  SkillPackagePreviewResponse,
  SkillPackageUpdateRequest,
  SkillListResponse,
  SkillRecordResponse,
  SkillUpdateRequest,
  ServerListResponse,
  ServerUploadScriptRequest,
  ServerUploadScriptResponse,
} from '../contracts';
import type { IntentSkillPackageCandidate, IntentToolCandidate, Runtime, RuntimeRequestOptions, RuntimeUnlistenFn } from './types';
import { getBundledSkillInstructions, getBundledSkills } from './webSkills';
import { buildWebExecutionPlan, routeWebChatInput } from './webRouting';
import { mapSkillRecord, resolveSkillBinding } from '../skillRecords';
import { buildIntentToolCatalog } from './intentCatalog';

const STORAGE_KEYS = {
  config: 'aiops_web_runtime_config',
  conversations: 'aiops_web_runtime_conversations',
} as const;

type StreamChunkPayload = { conversationId: string; messageId: string; chunk: string };
type StreamCompletePayload = { conversationId: string; messageId: string; success: boolean; error?: string };

const chunkListeners = new Set<(payload: StreamChunkPayload) => void>();
const completeListeners = new Set<(payload: StreamCompletePayload) => void>();
const API_BASE = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api').replace(/\/$/, '');

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  window.localStorage.setItem(key, JSON.stringify(value));
};

const unsupportedResult = (feature: string) => ({
  exitCode: 1,
  stdout: '',
  stderr: `Web runtime does not support ${feature} yet.`,
  executionTimeMs: 0,
  truncated: false,
});

const extractSkillTextPayload = (requestText: string, skill: Skill, args: string[]): string => {
  const directArg = args.find((item) => item && !item.startsWith('--'));
  if (directArg) return directArg.trim();

  const original = requestText.trim();
  if (!original) return '';

  const aliases = [skill.name, skill.resolvedToolName, skill.toolName, skill.serverId, ...(skill.triggers || [])]
    .filter((item): item is string => Boolean(item && item.trim()))
    .sort((left, right) => right.length - left.length);

  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadingPattern = new RegExp(`^\\s*(?:使用|调用|执行|运行|测试)?\\s*${escaped}\\s*[:：,，-]*\\s*`, 'i');
    const stripped = original.replace(leadingPattern, '').trim();
    if (stripped && stripped !== original) return stripped;
  }

  return original;
};

const getSavedVoiceEnvOverrides = (): Record<string, string> => {
  const config = readJson<Record<string, unknown>>(STORAGE_KEYS.config, {});
  const operatorProfile = config.operatorProfile && typeof config.operatorProfile === 'object'
    ? config.operatorProfile as Record<string, unknown>
    : null;
  const accessKeyId = String(operatorProfile?.voiceAccessKeyId || '').trim();
  const accessKeySecret = String(operatorProfile?.voiceAccessKeySecret || '').trim();

  if (!accessKeyId || !accessKeySecret) {
    return {};
  }

  return {
    ALIBABA_CLOUD_ACCESS_KEY_ID: accessKeyId,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: accessKeySecret,
  };
};

const tryParseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const direct = tryParseJson(text.trim());
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  return null;
};

const clampConfidence = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.max(0, Math.min(1, numeric));
};

const hasMeaningfulValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const getMissingRequiredParameters = (
  inputSchema: Record<string, unknown> | undefined,
  argumentsValue: Record<string, unknown>,
): string[] => {
  const required = Array.isArray(inputSchema?.required)
    ? inputSchema.required.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!required.length) return [];
  return required.filter((key) => !hasMeaningfulValue(argumentsValue[key]));
};

const PLANNER_WORKFLOWS = [
  {
    workflowId: 'status.overview',
    name: '状态总览',
    description: '汇总托管任务、设备、告警和运行态势，用于回答系统当前状态、异常、恢复和概览问题。',
  },
  {
    workflowId: 'report.inspection',
    name: '巡检报告',
    description: '基于当前运维上下文生成巡检报告，适合用户要求生成、导出或整理报告时使用。',
  },
] as const;

const buildPlannerPrompt = (
  input: string,
  intentTools: IntentToolCandidate[],
  skillPackages: IntentSkillPackageCandidate[],
  options: { chatMcpMode?: 'disabled' | 'manual' | 'auto'; selectedManualMcpServer?: string | null },
) => {
  const toolTable = intentTools.map((tool) => ({
    serverId: tool.serverId,
    serverName: tool.serverName,
    category: tool.category,
    serverDescription: tool.serverDescription,
    toolName: tool.toolName,
    toolDescription: tool.toolDescription,
    inputSchema: tool.inputSchema || null,
    execution: tool.execution || null,
    outputMode: tool.outputMode || null,
    usageExamples: tool.usageExamples || [],
    legacyIntentHints: tool.legacyIntentHints || [],
    defaultArgs: tool.defaultArgs || [],
  }));
  const skillPackageTable = skillPackages.map((pkg) => ({
    skillPackageId: pkg.id,
    name: pkg.name,
    kind: pkg.kind,
    description: pkg.description,
    tools: pkg.tools || [],
    instructionSummary: pkg.instructionText ? pkg.instructionText.slice(0, 2000) : '',
  }));

  return [
    '你是 OpsDog 的模型编排器。你的任务是先理解用户真实意图，再决定是否调用一个功能。',
    '不要做关键词匹配，不要因为用户碰巧说到某个功能名就调用；只有当用户意图需要这个能力时才选择它。',
    '可选动作只有：workflow、server-tool、skill-package、mcp、model。',
    'workflow 只能选择给定 workflow 表中的 workflowId。server-tool 只能选择工具能力表中的 serverId 和 toolName。mcp 只在用户需要外部 MCP 工具、文件系统、网页抓取或已选择的 MCP 服务时使用。其他情况选择 model。',
    '工具能力表中的 description、inputSchema、usageExamples、legacyIntentHints 都只是语义理解材料；不要把 legacyIntentHints 当关键字触发器。',
    '优先按用户动词和目标判断：执行/检测/统计/生成/拨打等明确动作可选择工具；咨询“怎么用/能做什么/介绍一下”不要执行工具。',
    'skill-package 只用于使用 Skill 包文档/说明回答问题，不执行脚本；如果用户明确要求执行可执行 Skill，请优先选择 server-tool。',
    '如果用户是在问概念、说明、怎么用、能力介绍，通常选择 model 或 skill-package；只有明确需要执行时才调用 server-tool。',
    '如果选择 server-tool，请根据 inputSchema 抽取 arguments；必需参数缺失时填写 missingParameters，不要猜参数。',
    '只返回 JSON，不要解释，不要 Markdown。',
    '',
    `MCP 模式：${options.chatMcpMode || 'disabled'}`,
    `手动 MCP 服务器：${options.selectedManualMcpServer || ''}`,
    `workflow 表：${JSON.stringify(PLANNER_WORKFLOWS)}`,
    `工具能力表：${JSON.stringify(toolTable)}`,
    `Skill 包表：${JSON.stringify(skillPackageTable)}`,
    '',
    'JSON 格式：{"intent":"一句话意图","action":"workflow|server-tool|skill-package|mcp|model","serverId":null,"toolName":null,"skillPackageId":null,"arguments":{},"missingParameters":[],"workflowId":null,"mcpMode":null,"riskLevel":"none|read-only|state-change|destructive","confidence":0.0,"reason":"简短原因"}',
    `用户输入：${input}`,
  ].join('\n');
};

const candidatePriority: Record<ChatExecutionCandidate['type'], number> = {
  workflow: 5000,
  'server-tool': 4500,
  'skill-package': 3500,
  skill: 4000,
  'mcp.manual': 3000,
  'mcp.auto': 2000,
  model: 0,
};

const modelCandidate = (reason: string): ChatExecutionCandidate => ({
  type: 'model',
  score: candidatePriority.model,
  reason,
  requiresConfirmation: false,
});

const normalizeRiskLevel = (value: unknown): ChatRouteDecision['maxMcpRiskLevel'] => {
  if (value === 'read-only' || value === 'state-change' || value === 'destructive') return value;
  return 'none';
};

const normalizePlannedMcpRisk = (value: unknown): Exclude<ChatRouteDecision['maxMcpRiskLevel'], 'none'> => {
  const riskLevel = normalizeRiskLevel(value);
  return riskLevel === 'none' ? 'read-only' : riskLevel;
};

const buildRouteFromPlanner = (
  safetyRoute: ChatRouteDecision,
  planner: Record<string, unknown>,
  selected: ChatExecutionCandidate,
): ChatRouteDecision => {
  const riskLevel = selected.type.startsWith('mcp.') ? normalizePlannedMcpRisk(planner.riskLevel) : 'none';
  const maxMcpRiskLevel = selected.type.startsWith('mcp.')
    ? riskLevel
    : 'none';
  const requiresConfirmation = selected.type.startsWith('mcp.') && maxMcpRiskLevel !== 'read-only';
  return {
    ...safetyRoute,
    intent: String(planner.intent || selected.type),
    localOnly: selected.type === 'workflow' || selected.type === 'server-tool' || selected.type === 'skill-package' || selected.type === 'skill',
    allowMcp: selected.type.startsWith('mcp.'),
    maxMcpRiskLevel,
    explicitToolUse: selected.type.startsWith('mcp.'),
    requiresConfirmation,
    hasConfirmation: safetyRoute.hasConfirmation,
    confirmationToken: requiresConfirmation ? '确认调用工具' : null,
    confirmationTitle: requiresConfirmation ? '外部工具调用确认' : null,
    confirmationSummary: requiresConfirmation ? `当前请求计划调用 MCP 外部工具，允许的最高风险等级为 ${maxMcpRiskLevel}。请确认后再继续。` : null,
    confidence: clampConfidence(planner.confidence),
    reasonCodes: ['model_intent_planner', ...safetyRoute.reasonCodes.filter((code) => code.startsWith('dangerous') || code.startsWith('prompt'))],
  };
};

const buildModelDrivenExecutionPlan = async (
  input: string,
  options: Parameters<Runtime['buildChatExecutionPlan']>[1] = {},
): Promise<ChatExecutionPlan> => {
  const safetyRoute = routeWebChatInput(input);
  if (safetyRoute.blocked) {
    const selected = modelCandidate('请求被本地安全策略拦截。');
    return { route: safetyRoute, matchedSkills: [], executableSkills: [], candidates: [selected], selected };
  }
  if (!options.model?.apiKey || !options.model.modelName || !options.model.provider) {
    return buildWebExecutionPlan(input, options);
  }
  const [servers, skillPackages] = await Promise.all([
    webRuntime.listServers(),
    webRuntime.listSkillPackages().catch(() => [] as SkillPackageRecord[]),
  ]);
  const intentTools = buildIntentToolCatalog(servers);
  const intentSkillPackages: IntentSkillPackageCandidate[] = skillPackages
    .filter((pkg) => pkg.enabled !== false)
    .map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      kind: pkg.kind,
      description: pkg.description,
      instructionText: pkg.instructionText,
      tools: (pkg.tools || []).map((tool) => ({ name: tool.name, description: tool.description })),
    }));

  const response = await postJson<ChatResponse, ChatRequest>('/chat', {
    messages: [
      ...(options.conversationMessages || []).slice(-6).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      {
        role: 'user',
        content: buildPlannerPrompt(input, intentTools, intentSkillPackages, options),
      },
    ],
    provider: options.model.provider,
    apiKey: options.model.apiKey,
    baseUrl: options.model.baseUrl,
    modelName: options.model.modelName,
    maxTokens: Math.min(Math.max(options.model.maxTokens || 1024, 512), 2048),
    temperature: 0,
  });

  const planner = extractJsonObject(response.content || '') || {};
  const action = String(planner.action || 'model');
  const candidates: ChatExecutionCandidate[] = [];
  const plannedServerId = typeof planner.serverId === 'string' ? planner.serverId : '';
  const plannedToolName = typeof planner.toolName === 'string' ? planner.toolName : '';
  const plannedSkillPackageId = typeof planner.skillPackageId === 'string' ? planner.skillPackageId : '';
  const workflowId = typeof planner.workflowId === 'string' ? planner.workflowId : '';
  const plannedArguments = planner.arguments && typeof planner.arguments === 'object' && !Array.isArray(planner.arguments)
    ? planner.arguments as Record<string, unknown>
    : {};
  const plannedMissing = Array.isArray(planner.missingParameters)
    ? planner.missingParameters.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const plannedTool = intentTools.find((tool) => (
    (tool.serverId === plannedServerId || tool.serverName === plannedServerId) &&
    tool.toolName === plannedToolName
  ));
  const workflowAllowed = PLANNER_WORKFLOWS.some((item) => item.workflowId === workflowId);
  const plannedSkillPackage = intentSkillPackages.find((pkg) => pkg.id === plannedSkillPackageId || pkg.name === plannedSkillPackageId);

  if (action === 'workflow' && workflowId && workflowAllowed) {
    candidates.push({
      type: 'workflow',
      score: candidatePriority.workflow + clampConfidence(planner.confidence),
      reason: String(planner.reason || '模型规划选择 Workflow。'),
      workflowId,
      requiresConfirmation: false,
    });
  } else if (action === 'server-tool' && plannedTool) {
    const missingParameters = Array.from(new Set([
      ...plannedMissing,
      ...getMissingRequiredParameters(plannedTool.inputSchema, plannedArguments),
    ]));
    candidates.push({
      type: 'server-tool',
      score: candidatePriority['server-tool'] + clampConfidence(planner.confidence),
      reason: String(planner.reason || '模型规划选择任务能力。'),
      serverId: plannedTool.serverId,
      toolName: plannedTool.toolName,
      arguments: plannedArguments,
      missingParameters,
      requiresConfirmation: false,
    });
  } else if (action === 'skill-package' && plannedSkillPackage) {
    candidates.push({
      type: 'skill-package',
      score: candidatePriority['skill-package'] + clampConfidence(planner.confidence),
      reason: String(planner.reason || '模型规划选择 Skill 包上下文。'),
      skillPackageId: plannedSkillPackage.id,
      requiresConfirmation: false,
    });
  } else if (action === 'mcp' && options.chatMcpMode === 'manual' && options.selectedManualMcpServer) {
    const riskLevel = normalizePlannedMcpRisk(planner.riskLevel);
    candidates.push({
      type: 'mcp.manual',
      score: candidatePriority['mcp.manual'] + clampConfidence(planner.confidence),
      reason: String(planner.reason || `模型规划选择 MCP：${options.selectedManualMcpServer}`),
      serverId: options.selectedManualMcpServer,
      requiresConfirmation: riskLevel !== 'read-only',
    });
  } else if (action === 'mcp' && options.chatMcpMode === 'auto') {
    const riskLevel = normalizePlannedMcpRisk(planner.riskLevel);
    candidates.push({
      type: 'mcp.auto',
      score: candidatePriority['mcp.auto'] + clampConfidence(planner.confidence),
      reason: String(planner.reason || '模型规划选择 MCP 自动模式。'),
      requiresConfirmation: riskLevel !== 'read-only',
    });
  }

  candidates.push(modelCandidate(
    candidates.length > 0
      ? '模型规划候选的备用普通回答。'
      : String(planner.reason || '模型规划未选择可执行功能，交给普通模型回答。'),
  ));

  const selected = [...candidates].sort((left, right) => right.score - left.score)[0];
  const route = buildRouteFromPlanner(safetyRoute, planner, selected);

  return { route, matchedSkills: [], executableSkills: [], candidates, selected };
};

const normalizeToolExecutionStdout = (text: string) => {
  const parsed = tryParseJson(text.trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      stdout: text.trim(),
      stderr: '',
      exitCode: 0,
      executionTimeMs: 0,
    };
  }

  const payload = parsed as {
    result?: unknown;
    stderr?: string;
    exitCode?: number;
    executionTimeMs?: number;
  };

  const result = payload.result;
  const normalizedStdout =
    result === undefined
      ? text.trim()
      : typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2);

  return {
    stdout: normalizedStdout,
    stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
    exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 0,
    executionTimeMs: typeof payload.executionTimeMs === 'number' ? payload.executionTimeMs : 0,
  };
};

const toUnlisten = <T>(set: Set<(payload: T) => void>, callback: (payload: T) => void): RuntimeUnlistenFn => {
  set.add(callback);
  return () => {
    set.delete(callback);
  };
};

const emitChunk = (payload: StreamChunkPayload) => {
  chunkListeners.forEach((listener) => listener(payload));
};

const emitComplete = (payload: StreamCompletePayload) => {
  completeListeners.forEach((listener) => listener(payload));
};

const buildError = async (response: Response): Promise<never> => {
  const body = await response.text().catch(() => '');
  if (response.status === 404 && typeof response.url === 'string' && response.url.includes('/api/skills')) {
    throw new Error('当前后端实例还未升级到 Skill 绑定编辑接口（缺少 /api/skills 路由）。请重启或切换到新的后端实例。');
  }
  try {
    const parsed = JSON.parse(body) as ApiErrorResponse;
    if (parsed?.error) {
      throw new Error(parsed.error);
    }
  } catch (error) {
    if (error instanceof Error && error.message) {
      throw error;
    }
  }
  throw new Error(`API returned ${response.status}: ${body || response.statusText}`);
};

const safeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network request failed: ${message}. Please confirm the OpsDog backend is running and reachable.`);
  }
};

const apiUrl = (path: string): string => `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;

const buildManagedServerPayload = async (serverId: string, payload: Record<string, unknown>) => {
  if (Array.isArray(payload.args) && payload.args.length > 0) {
    return payload;
  }

  const servers = await webRuntime.listServers();
  const server = servers.find((item) => item.id === serverId || item.name === serverId);
  if (!server || server.category !== 'managed') {
    return payload;
  }

  const defaultArgs = Array.isArray(server.capabilities?.defaultArgs) ? server.capabilities.defaultArgs : [];
  if (defaultArgs.length === 0) {
    return payload;
  }
  const defaultTool = (server.capabilities?.tools || []).find((tool) => tool.isDefault) || server.capabilities?.tools?.[0];

  return {
    ...payload,
    args: defaultArgs,
    input: {
      ...(payload.input && typeof payload.input === 'object' ? payload.input as Record<string, unknown> : {}),
      args: defaultArgs,
      toolName: defaultTool?.name,
    },
  };
};

const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== 'string') {
      reject(new Error('脚本读取失败：无法解析文件内容。'));
      return;
    }
    const marker = 'base64,';
    const markerIndex = result.indexOf(marker);
    if (markerIndex === -1) {
      reject(new Error('脚本读取失败：未生成 base64 内容。'));
      return;
    }
    resolve(result.slice(markerIndex + marker.length));
  };
  reader.onerror = () => reject(new Error('脚本读取失败，请重试。'));
  reader.readAsDataURL(file);
});

const getBuiltinFilesystemFallbackTools = async () => {
  const servers = await webRuntime.listServers();
  const filesystem = servers.find((server) => server.category === 'system' && server.id === 'filesystem');
  if (!filesystem) return [];
  return (filesystem.capabilities?.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || {},
    serverName: filesystem.name,
    riskLevel: filesystem.connection?.toolRiskOverrides?.[tool.name] || filesystem.connection?.riskLevel || 'read-only',
  }));
};

const postJson = async <TResponse, TRequest>(
  path: string,
  body: TRequest,
  options?: RuntimeRequestOptions,
): Promise<TResponse> => {
  const response = await safeFetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) await buildError(response);
  return await response.json() as TResponse;
};

const patchJson = async <TResponse, TRequest>(path: string, body: TRequest): Promise<TResponse> => {
  const response = await safeFetch(apiUrl(path), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) await buildError(response);
  return await response.json() as TResponse;
};

const deleteJson = async <TResponse>(path: string): Promise<TResponse> => {
  const response = await safeFetch(apiUrl(path), {
    method: 'DELETE',
  });
  if (!response.ok) await buildError(response);
  return await response.json() as TResponse;
};

const validateBundledSkillArgs = (
  skillPath: string,
  args: string[],
): SkillArgsValidationResult => {
  const skill = getBundledSkills().find((item) => item.path === skillPath);
  if (!skill || !skill.argsSchema || skill.argsSchema.length === 0) {
    return {
      valid: true,
      normalizedArgs: args,
      errors: [],
    };
  }

  const valuesByFlag = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;

    const values: string[] = [];
    let cursor = index + 1;
    while (cursor < args.length && !args[cursor].startsWith('--')) {
      values.push(args[cursor]);
      cursor += 1;
    }
    valuesByFlag.set(token, values);
  }

  const errors: string[] = [];
  for (const schema of skill.argsSchema) {
    const values = valuesByFlag.get(schema.flag) || [];
    if (schema.required && values.length === 0) {
      errors.push(`${schema.flag} 为必填参数`);
      continue;
    }
    if (!schema.multiple && values.length > 1) {
      errors.push(`${schema.flag} 不支持多个值`);
    }
    for (const value of values) {
      if (schema.type === 'integer') {
        const numeric = Number.parseInt(value, 10);
        if (Number.isNaN(numeric)) {
          errors.push(`${schema.flag} 需要整数值`);
          continue;
        }
        if (typeof schema.min === 'number' && numeric < schema.min) {
          errors.push(`${schema.flag} 不能小于 ${schema.min}`);
        }
        if (typeof schema.max === 'number' && numeric > schema.max) {
          errors.push(`${schema.flag} 不能大于 ${schema.max}`);
        }
      }
      if (schema.type === 'string' && schema.pattern) {
        const pattern = new RegExp(schema.pattern);
        if (!pattern.test(value)) {
          errors.push(`${schema.flag} 的值格式不合法`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    normalizedArgs: args,
    errors,
  };
};

export const webRuntime: Runtime = {
  mode: 'web',
  getBackendHealth: async () => {
    const response = await safeFetch(apiUrl('/health'));
    if (!response.ok) await buildError(response);
    return await response.json() as HealthResponse;
  },
  sendChatMessage: async (request) => postJson<ChatResponse, ChatRequest>('/chat', request),
  fetchAvailableModels: async (request) => {
    const response = await postJson<ModelListResponse, ModelListRequest>('/models', request);
    return response.models;
  },
  routeChatInput: async (input) => routeWebChatInput(input),
  buildChatExecutionPlan: async (input, options) => buildModelDrivenExecutionPlan(input, options),
  sendChatMessageStream: async (request, conversationId, messageId) => {
    try {
      const response = await safeFetch(apiUrl('/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) await buildError(response);
      if (!response.body) throw new Error('Streaming response body is empty');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let lineEnd = buffer.indexOf('\n');
        while (lineEnd !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);

          if (line && !line.startsWith(':') && line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              emitComplete({ conversationId, messageId, success: true });
              return;
            }
            try {
              const chunk = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const content = chunk.choices?.[0]?.delta?.content;
              if (content) {
                emitChunk({ conversationId, messageId, chunk: content });
              }
            } catch {
              // Ignore malformed SSE fragments and keep reading.
            }
          }

          lineEnd = buffer.indexOf('\n');
        }
      }

      emitComplete({ conversationId, messageId, success: true });
    } catch (error) {
      emitComplete({
        conversationId,
        messageId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
  onStreamChunk: async (callback) => toUnlisten(chunkListeners, callback),
  onStreamComplete: async (callback) => toUnlisten(completeListeners, callback),
  executeInstantSkill: async (skillName, args = [], options = {}) => {
    try {
      const [skills, servers] = await Promise.all([webRuntime.scanSkills(), webRuntime.listServers()]);
      const skill = skills.find((item) => item.name === skillName);
      if (!skill || skill.bindingStatus !== 'resolved' || !skill.serverId || !skill.resolvedToolName) {
        return unsupportedResult(`instant skill execution (${skillName} binding not resolved)`);
      }
      const server = servers.find((item) => item.id === skill.serverId || item.name === skill.serverId);
      if (!server) {
        return unsupportedResult(`instant skill execution (${skillName} not found)`);
      }
      const requestText = typeof options.requestText === 'string' ? options.requestText : '';
      const textPayload = extractSkillTextPayload(requestText, skill, args);
      const envOverrides = skillName.startsWith('aliyun_voice_')
        ? {
            ...getSavedVoiceEnvOverrides(),
            ...(options.envOverrides || {}),
          }
        : (options.envOverrides || {});
      const response = await webRuntime.callServerTool(server.id, skill.resolvedToolName, {
        args,
        requestText,
        skillName,
        envOverrides,
        ...(textPayload ? { message: textPayload, text: textPayload, query: textPayload } : {}),
        input: { args, requestText, skillName, ...(textPayload ? { message: textPayload, text: textPayload, query: textPayload } : {}) },
      });
      const text = response.content?.map((item) => item.text || '').join('\n').trim() || '';
      const normalized = normalizeToolExecutionStdout(text);
      return {
        exitCode: response.isError ? 1 : normalized.exitCode,
        stdout: response.isError ? '' : normalized.stdout,
        stderr: response.isError ? (normalized.stderr || text) : normalized.stderr,
        executionTimeMs: normalized.executionTimeMs,
        truncated: false,
      };
    } catch (error) {
      return unsupportedResult(error instanceof Error ? error.message : 'instant skill execution');
    }
  },
  executeWorkflow: async (request) =>
    await postJson('/workflows/execute', request),
  uploadServerScript: async (kind, file, description, usageExamples = []) => {
    const fileContentBase64 = await fileToBase64(file);
    return await postJson<ServerUploadScriptResponse, ServerUploadScriptRequest>('/servers/upload-script', {
      kind,
      fileName: file.name,
      description,
      usageExamples,
      fileContentBase64,
    });
  },
  generateTaskDraft: async (request, options) =>
    await postJson<AiTaskDraftGenerateResponse, AiTaskDraftGenerateRequest>('/task-drafts/generate', request, options),
  validateTaskDraft: async (request) =>
    await postJson<AiTaskDraftValidateResponse, AiTaskDraftValidateRequest>('/task-drafts/validate', request),
  createTaskDraft: async (request) =>
    await postJson<ServerUploadScriptResponse, AiTaskDraftCreateRequest>('/task-drafts/create', request),
  listAssetDevices: async (query = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      if (!text) continue;
      params.set(key, text);
    }

    const path = params.size > 0
      ? `/assets/devices?${params.toString()}`
      : '/assets/devices';
    const response = await safeFetch(apiUrl(path));
    if (!response.ok) await buildError(response);
    return await response.json() as AssetDeviceListResponse;
  },
  createAssetDevice: async (request) =>
    await postJson<AssetDevice, AssetDeviceUpsertRequest>('/assets/devices', request),
  updateAssetDevice: async (deviceId, request) =>
    await patchJson<AssetDevice, Partial<AssetDeviceUpsertRequest>>(`/assets/devices/${encodeURIComponent(deviceId)}`, request),
  deleteAssetDevice: async (deviceId) => {
    await deleteJson(`/assets/devices/${encodeURIComponent(deviceId)}`);
  },
  listServers: async () => {
    const response = await safeFetch(apiUrl('/servers'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as ServerListResponse;
    return data.servers;
  },
  getServer: async (serverId) => {
    const response = await safeFetch(apiUrl(`/servers/${encodeURIComponent(serverId)}`));
    if (!response.ok) await buildError(response);
    return await response.json();
  },
  updateServer: async (serverId, updates) =>
    await patchJson(`/servers/${encodeURIComponent(serverId)}`, updates),
  deleteServer: async (serverId) => {
    await deleteJson(`/servers/${encodeURIComponent(serverId)}`);
  },
  startServer: async (serverId, payload = {}) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/start`, await buildManagedServerPayload(serverId, payload)),
  stopServer: async (serverId) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/stop`, {}),
  restartServer: async (serverId, payload = {}) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/restart`, await buildManagedServerPayload(serverId, payload)),
  callServerTool: async (serverId, toolName, argumentsValue) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/call`, {
      argumentsValue,
    }),
  scanSkills: async () => {
    try {
      const response = await safeFetch(apiUrl('/skills'));
      if (!response.ok) await buildError(response);
      const data = await response.json() as SkillListResponse;
      return data.skills.map((skill) => mapSkillRecord(skill, true));
    } catch (error) {
      const fallbackSkills = getBundledSkills().map((skill) => mapSkillRecord(skill, true));
      try {
        const servers = await webRuntime.listServers();
        return fallbackSkills.map((skill) => resolveSkillBinding(skill, servers));
      } catch {
        return fallbackSkills.map((skill) => ({
          ...skill,
          bindingStatus: 'missing-server',
          bindingError: `后端 /api/skills 不可用，且 Server 列表也不可用：${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    }
  },
  previewSkillPackage: async (file) => {
    const fileContentBase64 = await fileToBase64(file);
    return await postJson<SkillPackagePreviewResponse, SkillPackagePreviewRequest>('/skill-packages/preview', {
      fileName: file.name,
      fileContentBase64,
    });
  },
  installSkillPackage: async (importId) =>
    await postJson(`/skill-packages/${encodeURIComponent(importId)}/install`, {}),
  listSkillPackages: async () => {
    const response = await safeFetch(apiUrl('/skill-packages'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as SkillPackageListResponse;
    return data.packages;
  },
  updateSkillPackage: async (skillPackageId, updates) =>
    await patchJson<SkillPackageRecord, SkillPackageUpdateRequest>(`/skill-packages/${encodeURIComponent(skillPackageId)}`, updates),
  deleteSkillPackage: async (skillPackageId) => {
    await deleteJson(`/skill-packages/${encodeURIComponent(skillPackageId)}`);
  },
  installSkillPackageDependencies: async (skillPackageId) =>
    await postJson(`/skill-packages/${encodeURIComponent(skillPackageId)}/dependencies/install`, {}),
  createSkill: async (request) =>
    mapSkillRecord(await postJson<SkillRecordResponse, SkillCreateRequest>('/skills', request), true),
  updateSkillMeta: async (skillName, updates) =>
    mapSkillRecord(await patchJson<SkillRecordResponse, SkillUpdateRequest>(`/skills/${encodeURIComponent(skillName)}`, updates), true),
  deleteSkill: async (skillName) => {
    await deleteJson(`/skills/${encodeURIComponent(skillName)}`);
  },
  loadSkillInstructions: async (skillPath) => getBundledSkillInstructions(skillPath),
  resolveSkillEntryScript: async (_skillPath, entryScript) => entryScript,
  validateSkillArgs: async (skillPath, args) => validateBundledSkillArgs(skillPath, args),
  loadConfig: async () => readJson(STORAGE_KEYS.config, {}),
  saveConfig: async (config) => {
    writeJson(STORAGE_KEYS.config, config);
  },
  loadConversations: async () => readJson(STORAGE_KEYS.conversations, []),
  saveConversations: async (conversations) => {
    writeJson(STORAGE_KEYS.conversations, conversations);
  },
  listConversationSummaries: async () => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    return conversations.map(({ messages, ...rest }) => rest);
  },
  loadConversationMessages: async (conversationId) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    return conversations.find((item) => item.id === conversationId)?.messages ?? [];
  },
  upsertConversationRecord: async (conversation) => {
    const conversations = readJson<Array<Record<string, unknown> & { id: string; messages?: unknown[] }>>(STORAGE_KEYS.conversations, []);
    const existing = conversations.findIndex((item) => item.id === conversation.id);
    if (existing >= 0) {
      conversations[existing] = { ...conversations[existing], ...conversation };
    } else {
      conversations.unshift({ ...conversation, messages: conversation.messages ?? [] });
    }
    writeJson(STORAGE_KEYS.conversations, conversations);
  },
  appendConversationMessage: async (conversationId, message) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    const next = conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: [...conversation.messages, message] }
      : conversation);
    writeJson(STORAGE_KEYS.conversations, next);
  },
  updateConversationMessage: async (conversationId, messageId, updates) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    const next = conversations.map((conversation) => conversation.id === conversationId
      ? {
          ...conversation,
          messages: conversation.messages.map((message: Message) => message.id === messageId ? { ...message, ...updates } : message),
        }
      : conversation);
    writeJson(STORAGE_KEYS.conversations, next);
  },
  replaceConversationMessages: async (conversationId, messages) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    const next = conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages }
      : conversation);
    writeJson(STORAGE_KEYS.conversations, next);
  },
  deleteConversationRecord: async (conversationId) => {
    const conversations = readJson<Array<{ id: string }>>(STORAGE_KEYS.conversations, []);
    writeJson(STORAGE_KEYS.conversations, conversations.filter((conversation) => conversation.id !== conversationId));
  },
  connectMCPServer: async (serverConfig) => {
    const response = await postJson<MCPConnectResponse, MCPConnectRequest>('/mcp/connect', serverConfig as unknown as MCPConnectRequest);
    return response.tools;
  },
  disconnectMCPServer: async (serverName) => {
    await postJson('/mcp/disconnect', { serverName });
  },
  listMCPServers: async () => {
    const response = await safeFetch(apiUrl('/mcp/servers'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as MCPServerListResponse;
    return data.servers;
  },
  createMCPServer: async (request) =>
    postJson('/mcp/servers', request as MCPServerCreateRequest),
  updateMCPServer: async (serverName, request) =>
    patchJson(`/mcp/servers/${encodeURIComponent(serverName)}`, request as MCPServerUpdateRequest),
  deleteMCPServer: async (serverName) => {
    await deleteJson(`/mcp/servers/${encodeURIComponent(serverName)}`);
  },
  connectMCPServerByName: async (serverName) =>
    postJson(`/mcp/servers/${encodeURIComponent(serverName)}/connect`, {}),
  disconnectMCPServerByName: async (serverName) =>
    postJson(`/mcp/servers/${encodeURIComponent(serverName)}/disconnect`, {}),
  importMCPServersJson: async (request) =>
    postJson<MCPServerImportJsonResponse, MCPServerImportJsonRequest>('/mcp/servers/import-json', request),
  importMCPServerDxt: async (request) =>
    postJson<MCPServerImportDxtResponse, MCPServerImportDxtRequest>('/mcp/servers/import-dxt', request),
  listMCPMarket: async () => {
    const response = await safeFetch(apiUrl('/mcp/market'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as MCPMarketResponse;
    return data.items;
  },
  installMCPMarketItem: async (itemId) =>
    postJson(`/mcp/market/${encodeURIComponent(itemId)}/install`, {}),
  listReports: async () => {
    const response = await safeFetch(apiUrl('/reports'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as ReportListResponse;
    return data.reports;
  },
  getReportContent: async (fileName) => {
    const response = await safeFetch(apiUrl(`/reports/${encodeURIComponent(fileName)}/content`));
    if (!response.ok) await buildError(response);
    return await response.json() as ReportContentResponse;
  },
  getReportDownloadUrl: async (fileName) => apiUrl(`/reports/${encodeURIComponent(fileName)}/download`),
  getReportPreviewUrl: async (fileName) => apiUrl(`/reports/${encodeURIComponent(fileName)}/preview`),
  deleteReport: async (fileName) => {
    await deleteJson(`/reports/${encodeURIComponent(fileName)}`);
  },
  clearReports: async () => {
    await deleteJson('/reports');
  },
  listMCPTools: async () => {
    const response = await safeFetch(apiUrl('/mcp/tools'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as { tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      serverName: string;
      riskLevel?: 'read-only' | 'state-change' | 'destructive';
    }> };
    const tools = data.tools;
    const hasFilesystem = tools.some((tool) => String(tool.serverName).toLowerCase() === 'filesystem');
    if (hasFilesystem) {
      return tools;
    }
    return [...tools, ...(await getBuiltinFilesystemFallbackTools())];
  },
  getMCPStatus: async () => {
    const response = await safeFetch(apiUrl('/mcp/status'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as MCPStatusResponse;
    return data.statuses;
  },
  callMCPTool: async (serverName, toolName, argumentsValue) => {
    try {
      return await postJson<MCPToolCallResponse, MCPToolCallRequest>('/mcp/call', {
        serverName,
        toolName,
        argumentsValue,
      });
    } catch (error) {
      if (serverName === 'filesystem') {
        return await postJson<MCPToolCallResponse, Record<string, unknown>>(
          `/servers/${encodeURIComponent('filesystem')}/tools/${encodeURIComponent(toolName)}/call`,
          argumentsValue,
        );
      }
      throw error;
    }
  },
  getSystemInfo: async () => ({
    os: navigator.platform || 'web',
    arch: 'web',
    hostname: window.location.hostname || 'localhost',
  }),
};
