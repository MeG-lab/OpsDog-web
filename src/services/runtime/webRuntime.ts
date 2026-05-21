import type { AssetDevice, ChatExecutionCandidate, ChatExecutionPlan, ChatRouteDecision, Conversation, MCPTool, Message, SkillPackageRecord } from '../../types';
import type {
  AiTaskCreateRequest,
  AiTaskGenerateRequest,
  AiTaskGenerateResponse,
  AiTaskValidateRequest,
  AiTaskValidateResponse,
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
  MCPServerTestResponse,
  MCPServerUpdateRequest,
  MCPStatusResponse,
  MCPToolCallRequest,
  MCPToolCallResponse,
  MCPToolCatalogResponse,
  ModelListRequest,
  ModelListResponse,
  ReportContentResponse,
  ReportListResponse,
  SkillPackageListResponse,
  SkillPackagePreviewRequest,
  SkillPackagePreviewResponse,
  SkillPackageUpdateRequest,
  ServerListResponse,
  ServerUploadScriptRequest,
  ServerUploadScriptResponse,
} from '../contracts';
import type { IntentSkillPackageCandidate, IntentToolCandidate, Runtime, RuntimeRequestOptions, RuntimeUnlistenFn } from './types';
import { buildWebExecutionPlan, routeWebChatInput } from './webRouting';
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
  mcpTools: MCPTool[],
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
    intentHints: tool.intentHints || [],
  }));
  const skillPackageTable = skillPackages.map((pkg) => ({
    skillPackageId: pkg.id,
    name: pkg.name,
    kind: pkg.kind,
    description: pkg.description,
    tools: pkg.tools || [],
    instructionSummary: pkg.instructionText ? pkg.instructionText.slice(0, 2000) : '',
  }));
  const mcpToolTable = mcpTools.map((tool) => ({
    id: tool.id || `${tool.serverName}/${tool.name}`,
    serverName: tool.serverName,
    toolName: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || {},
    requiredFields: tool.requiredFields || [],
    riskLevel: tool.riskLevel || 'read-only',
    transport: tool.transport || null,
  }));

  return [
    '你是 OpsDog 的模型编排器。你的任务是先理解用户真实意图，再决定是否调用一个功能。',
    '不要做关键词匹配，不要因为用户碰巧说到某个功能名就调用；只有当用户意图需要这个能力时才选择它。',
    '可选动作只有：workflow、server-tool、skill-package、mcp-tool、mcp、model。',
    'workflow 只能选择给定 workflow 表中的 workflowId。server-tool 只能选择工具能力表中的 serverId 和 toolName。mcp-tool 只能选择 MCP 工具表中的 mcpServerName 和 mcpToolName。mcp 只作为旧模式 fallback。',
    '工具能力表中的 description、inputSchema、usageExamples、intentHints 都只是语义理解材料；不要做关键字触发。',
    '优先按用户动词和目标判断：执行/检测/统计/生成/拨打等明确动作可选择工具；咨询“怎么用/能做什么/介绍一下”不要执行工具。',
    'skill-package 只用于使用 Skill 包文档/说明回答问题，不执行脚本；如果用户明确要求执行可执行 Skill，请优先选择 server-tool。',
    '如果用户是在问概念、说明、怎么用、能力介绍，通常选择 model 或 skill-package；只有明确需要执行时才调用 server-tool。',
    '如果选择 server-tool，请根据 inputSchema 抽取 arguments；必需参数缺失时填写 missingParameters，不要猜参数。',
    '如果选择 mcp-tool，请根据 MCP 工具 inputSchema 抽取 arguments；必需参数缺失时填写 missingParameters，不要猜参数。',
    '只返回 JSON，不要解释，不要 Markdown。',
    '',
    `MCP 模式：${options.chatMcpMode || 'disabled'}`,
    `手动 MCP 服务器：${options.selectedManualMcpServer || ''}`,
    `workflow 表：${JSON.stringify(PLANNER_WORKFLOWS)}`,
    `工具能力表：${JSON.stringify(toolTable)}`,
    `Skill 包表：${JSON.stringify(skillPackageTable)}`,
    `MCP 工具表：${JSON.stringify(mcpToolTable)}`,
    '',
    'JSON 格式：{"intent":"一句话意图","action":"workflow|server-tool|skill-package|mcp-tool|mcp|model","serverId":null,"toolName":null,"skillPackageId":null,"mcpServerName":null,"mcpToolName":null,"arguments":{},"missingParameters":[],"workflowId":null,"mcpMode":null,"riskLevel":"none|read-only|state-change|destructive","confidence":0.0,"reason":"简短原因"}',
    `用户输入：${input}`,
  ].join('\n');
};

const candidatePriority: Record<ChatExecutionCandidate['type'], number> = {
  workflow: 5000,
  'server-tool': 4500,
  'mcp-tool': 4200,
  'skill-package': 3500,
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
  const isMcpSelection = selected.type === 'mcp-tool' || selected.type.startsWith('mcp.');
  const riskLevel = isMcpSelection ? normalizePlannedMcpRisk(selected.riskLevel || planner.riskLevel) : 'none';
  const maxMcpRiskLevel = isMcpSelection
    ? riskLevel
    : 'none';
  const requiresConfirmation = isMcpSelection && maxMcpRiskLevel !== 'read-only';
  return {
    ...safetyRoute,
    intent: String(planner.intent || selected.type),
    localOnly: selected.type === 'workflow' || selected.type === 'server-tool' || selected.type === 'skill-package',
    allowMcp: isMcpSelection,
    maxMcpRiskLevel,
    explicitToolUse: isMcpSelection,
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
    return { route: safetyRoute, candidates: [selected], selected };
  }
  if (!options.model?.apiKey || !options.model.modelName || !options.model.provider) {
    return buildWebExecutionPlan(input, options);
  }
  const [servers, skillPackages, mcpCatalog] = await Promise.all([
    webRuntime.listServers(),
    webRuntime.listSkillPackages().catch(() => [] as SkillPackageRecord[]),
    options.chatMcpMode === 'disabled'
      ? Promise.resolve({ tools: [] as MCPTool[] })
      : webRuntime.listMCPToolCatalog().catch(() => ({ tools: [] as MCPTool[] })),
  ]);
  const intentTools = buildIntentToolCatalog(servers);
  const allowedMcpTools = options.chatMcpMode === 'manual' && options.selectedManualMcpServer
    ? mcpCatalog.tools.filter((tool) => tool.serverName === options.selectedManualMcpServer)
    : mcpCatalog.tools;
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
        content: buildPlannerPrompt(input, intentTools, intentSkillPackages, allowedMcpTools, options),
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
  const plannedMcpServerName = typeof planner.mcpServerName === 'string' ? planner.mcpServerName : '';
  const plannedMcpToolName = typeof planner.mcpToolName === 'string' ? planner.mcpToolName : '';
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
  const plannedMcpTool = allowedMcpTools.find((tool) => (
    (tool.serverName === plannedMcpServerName || `${tool.serverName}/${tool.name}` === plannedMcpServerName) &&
    tool.name === plannedMcpToolName
  ));

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
  } else if (action === 'mcp-tool' && plannedMcpTool && options.chatMcpMode !== 'disabled') {
    const riskLevel = plannedMcpTool.riskLevel || normalizePlannedMcpRisk(planner.riskLevel);
    const missingParameters = Array.from(new Set([
      ...plannedMissing,
      ...getMissingRequiredParameters(plannedMcpTool.inputSchema, plannedArguments),
    ]));
    candidates.push({
      type: 'mcp-tool',
      score: candidatePriority['mcp-tool'] + clampConfidence(planner.confidence),
      reason: String(planner.reason || `模型规划选择 MCP 工具：${plannedMcpTool.serverName}/${plannedMcpTool.name}`),
      mcpServerName: plannedMcpTool.serverName,
      mcpToolName: plannedMcpTool.name,
      arguments: plannedArguments,
      missingParameters,
      riskLevel,
      requiresConfirmation: riskLevel !== 'read-only',
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

  return { route, candidates, selected };
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
  generateAiTask: async (request, options) =>
    await postJson<AiTaskGenerateResponse, AiTaskGenerateRequest>('/ai-tasks/generate', request, options),
  validateAiTask: async (request) =>
    await postJson<AiTaskValidateResponse, AiTaskValidateRequest>('/ai-tasks/validate', request),
  createAiTask: async (request) =>
    await postJson<ServerUploadScriptResponse, AiTaskCreateRequest>('/ai-tasks/create', request),
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
    await postJson(`/servers/${encodeURIComponent(serverId)}/start`, payload),
  stopServer: async (serverId) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/stop`, {}),
  restartServer: async (serverId, payload = {}) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/restart`, payload),
  callServerTool: async (serverId, toolName, argumentsValue) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/call`, {
      argumentsValue,
    }),
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
  listMCPToolCatalog: async () => {
    const response = await safeFetch(apiUrl('/mcp/tools/catalog'));
    if (!response.ok) await buildError(response);
    return await response.json() as MCPToolCatalogResponse;
  },
  getMCPStatus: async () => {
    const response = await safeFetch(apiUrl('/mcp/status'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as MCPStatusResponse;
    return data.statuses;
  },
  refreshMCPServerTools: async (serverName) =>
    await postJson(`/mcp/servers/${encodeURIComponent(serverName)}/tools/refresh`, {}),
  testMCPServer: async (serverName) =>
    await postJson<MCPServerTestResponse, Record<string, never>>(`/mcp/servers/${encodeURIComponent(serverName)}/test`, {}),
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
