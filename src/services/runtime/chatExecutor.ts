import type {
  ChatExecutionCandidate,
  ChatMcpMode,
  ChatRouteDecision,
  ExecutionResult,
  LLMConfig,
  Message,
  PythonServerProtocolMode,
  ServerDefinition,
  ServerToolAdapterDefinition,
  ServerToolDefinition,
} from '../../types';
import {
  callMCPTool,
  callServerTool,
  executeWorkflow,
  listSkillPackages,
  listMCPToolCatalog,
  listMCPServers,
  listMCPTools,
  listServers,
  sendChatMessage,
  startServer,
} from './index';
import {
  buildMcpToolDefinitions,
  containsPseudoToolMarkup,
  detectManualMcpIntent,
  formatMcpToolResult,
  resolveToolCallTarget,
  runLocalMcpFallbackPlan,
} from './mcpChatPlanner';

type ToolResultContext = {
  source: 'mcp';
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
  rawText: string;
  isError?: boolean;
};

export type ExecuteSelectedCandidateInput = {
  selected: ChatExecutionCandidate | null;
  routeDecision: ChatRouteDecision | null;
  inputText: string;
  chatMcpMode: ChatMcpMode;
  selectedManualMcpServer: string | null;
  model: LLMConfig;
  conversationMessages: Message[];
  assistantMessageId: string;
  isRunActive: () => boolean;
};

const REPORT_ACTION_RE = /(生成报告|导出报告|巡检报告|报告)/;

const supportsMcpTools = (provider: LLMConfig['provider']) => (
  ['openai', 'custom', 'aliyun', 'deepseek', 'siliconflow', 'volcengine', 'zhipu', 'moonshot'].includes(provider)
);

const emptyResult = (patch: Partial<ExecutionResult>): ExecutionResult => ({
  ok: false,
  kind: 'error',
  summary: '',
  steps: [],
  artifacts: [],
  highlights: [],
  errors: [],
  ...patch,
});

const mcpRawText = (result: { content: Array<{ type?: string; text?: string; contentType?: string }>; isError?: boolean }) =>
  formatMcpToolResult(result).trim();

const summarizeMcpText = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 600 ? `${normalized.slice(0, 600)}…` : normalized;
};

const formatMcpExecutionReply = ({
  serverName,
  toolName,
  args,
  result,
  error,
}: {
  serverName: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: { content: Array<{ type?: string; text?: string; contentType?: string }>; isError?: boolean };
  error?: string;
}) => {
  const title = `已调用 MCP 工具：${serverName}/${toolName}`;
  const argSummary = args && Object.keys(args).length > 0 ? `参数：\`${JSON.stringify(args)}\`` : '参数：`{}`';
  if (error) return [title, '', argSummary, '', `执行失败：${error}`].join('\n');
  const resultText = result ? mcpRawText(result) : '';
  return [
    title,
    '',
    argSummary,
    '',
    result?.isError ? `执行失败：${resultText || '工具未返回错误内容。'}` : (resultText || '工具已执行完成，但没有返回可显示内容。'),
  ].join('\n');
};

const buildMcpExecutionResult = (input: {
  serverName: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: { content: Array<{ type?: string; text?: string; contentType?: string }>; isError?: boolean };
  error?: string;
}): ExecutionResult => {
  const rawText = input.result ? mcpRawText(input.result) : '';
  const parsed = (() => {
    try {
      return rawText ? JSON.parse(rawText) as {
        outputs?: Array<{ fileName?: string; mimeType?: string; format?: string; path?: string }>;
        output?: { type?: string; fileName?: string; mimeType?: string; format?: string; path?: string };
        highlights?: unknown[];
        summary?: string;
        error?: string;
        ok?: boolean;
      } : null;
    } catch {
      return null;
    }
  })();
  const artifacts = [
    ...(Array.isArray(parsed?.outputs) ? parsed.outputs : []),
    ...(parsed?.output?.type === 'file' ? [parsed.output] : []),
  ];
  const isError = Boolean(input.error || input.result?.isError || parsed?.ok === false);
  const errorText = input.error || parsed?.error || (input.result?.isError ? rawText : '');
  return {
    ok: !isError,
    kind: 'mcp',
    summary: isError ? `MCP 工具执行失败：${input.serverName}/${input.toolName}` : `已调用 MCP 工具：${input.serverName}/${input.toolName}`,
    steps: [{
      id: `mcp-${input.serverName}-${input.toolName}`,
      title: `调用 MCP：${input.serverName}/${input.toolName}`,
      status: isError ? 'failed' : 'completed',
      serverId: input.serverName,
      toolName: input.toolName,
      summary: input.args && Object.keys(input.args).length > 0 ? `参数：${JSON.stringify(input.args)}` : '参数：{}',
      error: errorText || undefined,
    }],
    artifacts,
    highlights: Array.isArray(parsed?.highlights) ? parsed.highlights.map((item) => String(item)) : [],
    errors: errorText ? [errorText] : [],
    textFallback: formatMcpExecutionReply(input),
  };
};

const toToolResultContext = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  result: { content: Array<{ type?: string; text?: string; contentType?: string }>; isError?: boolean },
): ToolResultContext => {
  const rawText = mcpRawText(result);
  return {
    source: 'mcp',
    serverName,
    toolName,
    arguments: args,
    summary: result.isError ? (rawText || '外部 MCP 工具执行失败。') : summarizeMcpText(rawText || '外部 MCP 工具已执行完成。'),
    rawText,
    isError: Boolean(result.isError),
  };
};

const resolveReadyMcpIntent = async (
  inputText: string,
  mode: ChatMcpMode,
  selectedManualMcpServer: string | null,
  routeDecision: ChatRouteDecision | null,
) => {
  const riskLevelOrder: Record<'read-only' | 'state-change' | 'destructive', number> = {
    'read-only': 1,
    'state-change': 2,
    destructive: 3,
  };
  const maxRiskLevel = routeDecision?.maxMcpRiskLevel || 'read-only';
  const maxAllowedRisk = maxRiskLevel === 'none' ? 0 : riskLevelOrder[maxRiskLevel];
  const allTools = maxRiskLevel === 'none'
    ? []
    : (await listMCPTools()).filter(tool => riskLevelOrder[(tool.riskLevel ?? 'read-only')] <= maxAllowedRisk);

  if (mode === 'manual') {
    if (!selectedManualMcpServer) {
      return { type: 'error' as const, message: '当前是 MCP 手动模式，请先在输入框旁边选择一个 MCP 服务器。' };
    }
    const serverTools = allTools.filter((tool) => tool.serverName === selectedManualMcpServer);
    if (serverTools.length === 0) {
      return { type: 'error' as const, message: '当前选中的 MCP 服务器没有可用工具，请重新选择。' };
    }
    return detectManualMcpIntent(inputText, serverTools, selectedManualMcpServer);
  }

  if (mode === 'auto') {
    const connectedServers = (await listMCPServers()).filter((server) => server.connected && server.name !== 'filesystem');
    if (allTools.length === 0 || connectedServers.length === 0) {
      return { type: 'error' as const, message: '当前没有可用的已连接 MCP 工具。请先在 MCP 面板连接对应服务器后再重试。' };
    }
    if (connectedServers.length === 1 && connectedServers[0].tools.length === 1) {
      const onlyServer = connectedServers[0];
      return detectManualMcpIntent(inputText, [onlyServer.tools[0]], onlyServer.name);
    }
    return detectManualMcpIntent(inputText, allTools);
  }

  return { type: 'error' as const, message: '当前已禁用 MCP。请将输入区的 MCP 模式切换到“手动”或“自动”后再重试。' };
};

const executeMcpDeterministic = async (
  inputText: string,
  mode: ChatMcpMode,
  selectedManualMcpServer: string | null,
  routeDecision: ChatRouteDecision | null,
) => {
  const intent = await resolveReadyMcpIntent(inputText, mode, selectedManualMcpServer, routeDecision);
  if (intent.type === 'error') {
    return { result: emptyResult({ kind: 'error', summary: intent.message, errors: [intent.message], textFallback: intent.message }) };
  }
  if (intent.type === 'ambiguous') {
    const message = `当前识别到了多个可能的 MCP 工具，请明确指定工具名：${intent.matches.slice(0, 6).map(item => `\`${item.serverName}/${item.toolName}\``).join('、')}`;
    return { result: emptyResult({ kind: 'error', summary: message, errors: ['ambiguous'], textFallback: message }) };
  }
  if (intent.type === 'missing-args') {
    const message = `已识别到 MCP 工具 \`${intent.serverName}/${intent.toolName}\`，但还缺少必需参数：${intent.missing.join('、')}。请补全后重试。`;
    return { result: emptyResult({ kind: 'error', summary: message, errors: ['missing-args'], textFallback: message }) };
  }
  if (intent.type !== 'ready') {
    const message = '当前请求看起来是在使用 MCP，但系统没有识别出可执行的目标工具或参数。请明确说明服务器/工具名，或补充必需参数后重试。';
    return { result: emptyResult({ kind: 'error', summary: message, errors: ['missing-tool'], textFallback: message }) };
  }

  try {
    const toolResult = await callMCPTool(intent.serverName, intent.toolName, intent.args);
    const result = buildMcpExecutionResult({
      serverName: intent.serverName,
      toolName: intent.toolName,
      args: intent.args,
      result: toolResult,
    });
    return {
      result,
      context: toToolResultContext(intent.serverName, intent.toolName, intent.args, toolResult),
    };
  } catch (error) {
    const result = buildMcpExecutionResult({
      serverName: intent.serverName,
      toolName: intent.toolName,
      args: intent.args,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result };
  }
};

const isMissingValue = (value: unknown) => (
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0)
);

const getRequiredSchemaFields = (schema: Record<string, unknown> | undefined): string[] => {
  const required = schema?.required;
  return Array.isArray(required) ? required.map((item) => String(item)).filter(Boolean) : [];
};

const toFlagName = (key: string) => `--${key.replace(/_/g, '-')}`;

const argumentsToCliArgs = (args: Record<string, unknown>): string[] => {
  const result: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (isMissingValue(value) || key === 'args' || key === 'input') continue;
    if (value === true) {
      result.push(toFlagName(key));
      continue;
    }
    if (value === false) continue;
    result.push(toFlagName(key));
    if (Array.isArray(value)) {
      result.push(...value.map((item) => String(item)));
    } else {
      result.push(String(value));
    }
  }
  return result;
};

const stripTransportFields = (args: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...args };
  delete result.args;
  delete result.input;
  return result;
};

const normalizeExplicitCliArgs = (value: unknown): string[] | null => {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return null;
};

const getServerToolAdapter = (
  server: ServerDefinition,
  tool: ServerToolDefinition,
): ServerToolAdapterDefinition =>
  tool.adapter || server.capabilities?.adapter || {};

const getServerToolProtocolMode = (
  server: ServerDefinition,
  tool: ServerToolDefinition,
): PythonServerProtocolMode => {
  const adapter = getServerToolAdapter(server, tool);
  if (adapter.stdoutMode === 'plain-text' || tool.outputMode === 'plain-text') return 'cli-adapter';
  if (tool.outputMode === 'json-events') return 'json-stream';
  return server.capabilities?.protocol?.mode || (server.category === 'managed' ? 'json-stream' : 'json-tool');
};

const buildServerToolPayload = (
  selected: ChatExecutionCandidate,
  server: ServerDefinition,
  tool: ServerToolDefinition,
  inputText: string,
) => {
  const plannedArgs = selected.arguments || {};
  if (server.type !== 'python-script') {
    return plannedArgs;
  }

  const fieldArgs = stripTransportFields(plannedArgs);
  const adapter = getServerToolAdapter(server, tool);
  const protocolMode = getServerToolProtocolMode(server, tool);
  const explicitArgs = normalizeExplicitCliArgs(plannedArgs.args);
  const shouldGenerateCliArgs =
    protocolMode === 'cli-adapter' &&
    explicitArgs === null &&
    adapter.passthroughArgs !== false &&
    !Array.isArray(adapter.argv);
  const cliArgs = explicitArgs || (shouldGenerateCliArgs ? argumentsToCliArgs(fieldArgs) : []);
  const inputPayload = {
    ...fieldArgs,
    ...(cliArgs.length > 0 ? { args: cliArgs } : {}),
    requestText: inputText,
    toolName: tool.name,
  };

  return {
    ...fieldArgs,
    ...(cliArgs.length > 0 ? { args: cliArgs } : {}),
    requestText: inputText,
    toolName: tool.name,
    input: inputPayload,
  };
};

const executeServerTool = async (
  selected: ChatExecutionCandidate,
  inputText: string,
): Promise<ExecutionResult> => {
  if (!selected.serverId || !selected.toolName) {
    const message = '任务能力执行失败：模型规划没有返回 serverId 或 toolName。';
    return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
  }

  const servers = await listServers();
  const server = servers.find((item) => item.id === selected.serverId || item.name === selected.serverId);
  if (!server) {
    const message = `任务能力执行失败：Server 未找到：${selected.serverId}`;
    return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
  }
  const tool = (server.capabilities?.tools || []).find((item) => item.name === selected.toolName);
  if (!tool) {
    const message = `任务能力执行失败：Tool 未找到：${server.id}/${selected.toolName}`;
    return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
  }

  const schema = tool.inputSchema || server.capabilities?.inputSchema;
  const requiredMissing = getRequiredSchemaFields(schema)
    .filter((field) => isMissingValue(selected.arguments?.[field]));
  const missing = Array.from(new Set([...(selected.missingParameters || []), ...requiredMissing]));
  if (missing.length > 0) {
    const message = `还缺少参数：${missing.join('、')}。请补充后我再执行。`;
    return emptyResult({
      kind: 'tool',
      summary: '任务能力参数不完整。',
      errors: ['missing-parameters'],
      textFallback: message,
    });
  }

  const payload = buildServerToolPayload(selected, server, tool, inputText);
  if (server.category === 'managed') {
    const task = await startServer(server.id, payload);
    const text = [
      `任务能力已启动：${server.name}/${tool.name}`,
      `当前状态：${task.status}`,
      `参数：${JSON.stringify(selected.arguments || {})}`,
    ].join('\n');
    return {
      ok: true,
      kind: 'tool',
      summary: `已启动任务能力：${server.name}/${tool.name}`,
      steps: [{
        id: `server-tool-${server.id}-${tool.name}`,
        title: `启动任务能力：${server.name}/${tool.name}`,
        status: 'completed',
        serverId: server.id,
        toolName: tool.name,
        summary: text,
      }],
      artifacts: [],
      highlights: [],
      errors: [],
      textFallback: text,
    };
  }

  const result = await callServerTool(server.id, tool.name, payload);
  const rawText = mcpRawText(result);
  const isError = Boolean(result.isError);
  const text = [
    `已执行任务能力：${server.name}/${tool.name}`,
    '',
    `参数：${JSON.stringify(selected.arguments || {})}`,
    '',
    rawText || '任务已执行完成，但没有返回可显示内容。',
  ].join('\n');
  return {
    ok: !isError,
    kind: 'tool',
    summary: isError ? `任务能力执行失败：${server.name}/${tool.name}` : `已执行任务能力：${server.name}/${tool.name}`,
    steps: [{
      id: `server-tool-${server.id}-${tool.name}`,
      title: `执行任务能力：${server.name}/${tool.name}`,
      status: isError ? 'failed' : 'completed',
      serverId: server.id,
      toolName: tool.name,
      summary: rawText || text,
      error: isError ? rawText || text : undefined,
    }],
    artifacts: [],
    highlights: [],
    errors: isError ? [rawText || text] : [],
    textFallback: text,
  };
};

const buildModelMessages = (messages: Message[], assistantMessageId: string, inputText: string, chatMcpMode: ChatMcpMode) => {
  const apiMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = messages
    .filter(message => message.role !== 'system' && message.id !== assistantMessageId)
    .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
  apiMessages.unshift({
    role: 'system',
    content: [
      '你是 OpsDog 运维助手。',
      '只输出给用户看的最终答案，不要输出内部思考、推理链、草稿、<think>、<thinking>、<reasoning> 或类似标签内容。',
      '如果需要解释依据，用简短的结论和关键理由表达，不要逐步暴露思考过程。',
    ].join('\n'),
  });
  if (chatMcpMode === 'disabled') {
    apiMessages.unshift({
      role: 'system',
      content: '当前 MCP 已被禁用。不要调用任何 MCP 工具，不要声称已经调用过 MCP 工具，也不要继续沿用历史对话中的工具执行结果来回答当前请求。',
    });
  }
  if (!apiMessages.some((message) => message.role === 'user' && message.content === inputText)) {
    apiMessages.push({ role: 'user', content: inputText });
  }
  return apiMessages;
};

const executeModel = async (input: ExecuteSelectedCandidateInput): Promise<ExecutionResult> => {
  const response = await sendChatMessage({
    messages: buildModelMessages(input.conversationMessages, input.assistantMessageId, input.inputText, input.chatMcpMode),
    provider: input.model.provider,
    apiKey: input.model.apiKey,
    baseUrl: input.model.baseUrl,
    modelName: input.model.modelName,
    maxTokens: input.model.maxTokens,
    temperature: input.model.temperature,
  });
  if (containsPseudoToolMarkup(response.content || '')) {
    const message = '系统拦截了一段无效的伪工具调用文本。请重试，或直接在工作区 / MCP 面板中调用对应的 Server。';
    return emptyResult({ kind: 'blocked', summary: message, errors: [message], textFallback: message });
  }
  if (
    input.chatMcpMode === 'disabled' &&
    /(已调用\s*MCP\s*工具|以下是\s*MCP\s*工具|让我.*调用|我现在.*使用.*工具|fetch\/fetch|filesystem\/)/i.test(response.content || '')
  ) {
    const message = '当前已禁用 MCP。请将输入区的 MCP 模式切换到“手动”或“自动”后再重试。';
    return emptyResult({ kind: 'blocked', summary: message, errors: [message], textFallback: message });
  }
  return {
    ok: true,
    kind: 'model',
    summary: response.content || '模型未返回内容。',
    steps: [],
    artifacts: [],
    highlights: [],
    errors: [],
    textFallback: response.content || '模型未返回内容。',
  };
};

const executeSkillPackageContext = async (
  input: ExecuteSelectedCandidateInput,
  skillPackageId: string,
): Promise<ExecutionResult> => {
  const packages = await listSkillPackages();
  const skillPackage = packages.find((item) => item.id === skillPackageId || item.name === skillPackageId);
  if (!skillPackage || skillPackage.enabled === false) {
    const message = `Skill 包不可用：${skillPackageId}`;
    return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
  }

  const response = await sendChatMessage({
    messages: [
      {
        role: 'system',
        content: [
          `你正在使用 OpsDog Skill 包：${skillPackage.name} (${skillPackage.id})。`,
          `类型：${skillPackage.kind}`,
          `说明：${skillPackage.description}`,
          '这个 Skill 包当前用于模型上下文增强，不代表已经执行本地脚本。',
          '请严格基于下面的 Skill 文档和用户问题回答；如果缺少必要输入，直接询问用户补充。',
          '',
          'Skill 文档：',
          clipForModel(skillPackage.instructionText || skillPackage.description || '', 12000),
        ].join('\n'),
      },
      ...buildModelMessages(input.conversationMessages, input.assistantMessageId, input.inputText, input.chatMcpMode).slice(-8),
    ],
    provider: input.model.provider,
    apiKey: input.model.apiKey,
    baseUrl: input.model.baseUrl,
    modelName: input.model.modelName,
    maxTokens: input.model.maxTokens,
    temperature: Math.min(input.model.temperature ?? 0.2, 0.4),
  });

  return {
    ok: true,
    kind: 'model',
    summary: response.content || 'Skill 包未返回内容。',
    steps: [{
      id: `skill-package-${skillPackage.id}`,
      title: `使用 Skill 包：${skillPackage.name}`,
      status: 'completed',
      summary: skillPackage.description,
    }],
    artifacts: [],
    highlights: [],
    errors: [],
    textFallback: response.content || 'Skill 包未返回内容。',
  };
};

const clipForModel = (value: string, maxLength = 8000) => (
  value.length > maxLength ? `${value.slice(0, maxLength)}\n...（结果过长，已截断）` : value
);

const composeExecutionAnswer = async (
  input: ExecuteSelectedCandidateInput,
  result: ExecutionResult,
): Promise<ExecutionResult> => {
  if (!result.ok || result.kind === 'model' || result.kind === 'blocked') return result;
  try {
    const response = await sendChatMessage({
      messages: [
        ...buildModelMessages(input.conversationMessages, input.assistantMessageId, input.inputText, input.chatMcpMode).slice(-8),
        {
          role: 'system',
          content: [
            '你是 OpsDog。系统已经完成了用户请求中的功能调用。',
            '请基于下面的执行结果回答用户，不要重新规划工具，不要声称还没有执行。',
            '回答要直接说明结果、关键发现、失败原因或下一步需要用户补充的信息。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: clipForModel([
            `用户原始请求：${input.inputText}`,
            '',
            '功能执行结果：',
            JSON.stringify({
              ok: result.ok,
              kind: result.kind,
              summary: result.summary,
              highlights: result.highlights,
              errors: result.errors,
              artifacts: result.artifacts,
              steps: result.steps,
              textFallback: result.textFallback,
            }, null, 2),
          ].join('\n')),
        },
      ],
      provider: input.model.provider,
      apiKey: input.model.apiKey,
      baseUrl: input.model.baseUrl,
      modelName: input.model.modelName,
      maxTokens: input.model.maxTokens,
      temperature: Math.min(input.model.temperature ?? 0.2, 0.4),
    });
    return {
      ...result,
      textFallback: response.content || result.textFallback,
    };
  } catch {
    return result;
  }
};

const executeMcpPlanner = async (input: ExecuteSelectedCandidateInput): Promise<ExecutionResult> => {
  const riskLevelOrder: Record<'read-only' | 'state-change' | 'destructive', number> = {
    'read-only': 1,
    'state-change': 2,
    destructive: 3,
  };
  const maxRiskLevel = input.routeDecision?.maxMcpRiskLevel || 'read-only';
  const maxAllowedRisk = maxRiskLevel === 'none' ? 0 : riskLevelOrder[maxRiskLevel];
  const mcpTools = maxRiskLevel === 'none'
    ? []
    : (await listMCPTools()).filter(tool => riskLevelOrder[(tool.riskLevel ?? 'read-only')] <= maxAllowedRisk);
  if (mcpTools.length === 0) {
    const message = '当前没有可用的已连接 MCP 工具。请先在 MCP 面板连接对应服务器后再重试。';
    return emptyResult({ kind: 'error', summary: message, errors: ['missing-tool'], textFallback: message });
  }
  const { toolDefinitions, toolNameMap } = buildMcpToolDefinitions(mcpTools);
  const planning = await sendChatMessage({
    messages: [
      ...buildModelMessages(input.conversationMessages, input.assistantMessageId, input.inputText, input.chatMcpMode),
      {
        role: 'system',
        content: '如果需要调用工具，必须返回真实 tool call。不要输出 <invoke>、<parameter>、XML 标签或伪工具调用文本；如果不需要工具，就直接用自然语言回答。',
      },
    ],
    provider: input.model.provider,
    apiKey: input.model.apiKey,
    baseUrl: input.model.baseUrl,
    modelName: input.model.modelName,
    maxTokens: input.model.maxTokens,
    temperature: input.model.temperature,
    tools: toolDefinitions,
  });
  if (planning.toolCalls && planning.toolCalls.length > 0) {
    const toolCall = planning.toolCalls[0];
    const resolved = resolveToolCallTarget(toolCall.name, toolNameMap);
    if (!resolved) {
      const message = `模型请求了未知 MCP 工具 ${toolCall.name}，无法执行。`;
      return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
    }
    try {
      const parsedArgs = toolCall.arguments?.trim() ? JSON.parse(toolCall.arguments) : {};
      const result = await callMCPTool(resolved.serverName, resolved.toolName, parsedArgs);
      return buildMcpExecutionResult({ serverName: resolved.serverName, toolName: resolved.toolName, args: parsedArgs, result });
    } catch (error) {
      return buildMcpExecutionResult({
        serverName: resolved.serverName,
        toolName: resolved.toolName,
        args: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fallback = await runLocalMcpFallbackPlan({
    input: input.inputText,
    mcpTools,
    callTool: callMCPTool,
  });
  if (fallback.type === 'failed') {
    return emptyResult({ kind: 'error', summary: fallback.message, errors: [fallback.message], textFallback: fallback.message });
  }
  if (fallback.type === 'tool-messages') {
    return {
      ok: true,
      kind: 'mcp',
      summary: '已完成 MCP 工具调用。',
      steps: [],
      artifacts: [],
      highlights: [],
      errors: [],
      textFallback: fallback.toolMessages.map((message) => message.content).join('\n\n'),
    };
  }
  if (containsPseudoToolMarkup(planning.content || '')) {
    const message = '工具规划返回了无效的伪工具调用文本，系统已拦截这段内容。';
    return emptyResult({ kind: 'blocked', summary: message, errors: [message], textFallback: message });
  }
  return {
    ok: true,
    kind: 'model',
    summary: planning.content || '已收到请求，但模型未返回内容。',
    steps: [],
    artifacts: [],
    highlights: [],
    errors: [],
    textFallback: planning.content || '已收到请求，但模型未返回内容。',
  };
};

const executeMcpToolCandidate = async (
  selected: ChatExecutionCandidate,
): Promise<{ result: ExecutionResult; context?: ToolResultContext }> => {
  if (!selected.mcpServerName || !selected.mcpToolName) {
    const message = 'MCP 工具执行失败：模型规划没有返回 mcpServerName 或 mcpToolName。';
    return { result: emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message }) };
  }

  const catalog = await listMCPToolCatalog().catch(() => ({ tools: [] }));
  const tool = catalog.tools.find((item) => item.serverName === selected.mcpServerName && item.name === selected.mcpToolName);
  if (!tool) {
    const message = `MCP 工具不可用：${selected.mcpServerName}/${selected.mcpToolName}。请确认该 MCP 服务已连接且已启用对话规划。`;
    return { result: emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message }) };
  }

  const args = selected.arguments || {};
  const missing = Array.from(new Set([
    ...(selected.missingParameters || []),
    ...(tool.requiredFields || getRequiredSchemaFields(tool.inputSchema)).filter((field) => isMissingValue(args[field])),
  ]));
  if (missing.length > 0) {
    const message = `已识别到 MCP 工具 \`${tool.serverName}/${tool.name}\`，但还缺少必需参数：${missing.join('、')}。请补全后我再调用。`;
    return { result: emptyResult({ kind: 'error', summary: 'MCP 工具参数不完整。', errors: ['missing-parameters'], textFallback: message }) };
  }

  try {
    const toolResult = await callMCPTool(tool.serverName, tool.name, args);
    return {
      result: buildMcpExecutionResult({
        serverName: tool.serverName,
        toolName: tool.name,
        args,
        result: toolResult,
      }),
      context: toToolResultContext(tool.serverName, tool.name, args, toolResult),
    };
  } catch (error) {
    return {
      result: buildMcpExecutionResult({
        serverName: tool.serverName,
        toolName: tool.name,
        args,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};

export const executeSelectedCandidate = async (input: ExecuteSelectedCandidateInput): Promise<ExecutionResult> => {
  if (!input.isRunActive()) {
    return emptyResult({ kind: 'blocked', summary: '执行已停止。', errors: ['stopped'], textFallback: '执行已停止。' });
  }
  const selected = input.selected;
  const wantsReport = REPORT_ACTION_RE.test(input.inputText);
  const explicitMcp = Boolean(input.routeDecision?.explicitToolUse);

  if (selected?.type === 'workflow' && selected.workflowId) {
    let context: { toolResults?: ToolResultContext[] } | undefined;
    if (selected.workflowId === 'report.inspection' && explicitMcp && input.chatMcpMode !== 'disabled') {
      const preflight = await executeMcpDeterministic(input.inputText, input.chatMcpMode, input.selectedManualMcpServer, input.routeDecision);
      if (!input.isRunActive()) return emptyResult({ kind: 'blocked', summary: '执行已停止。', errors: ['stopped'] });
      if (!preflight.context || !preflight.result.ok) {
        return preflight.result;
      }
      context = { toolResults: [preflight.context] };
    }
    const result = await executeWorkflow({
      workflowId: selected.workflowId,
      requestText: input.inputText,
      context,
    });
    return await composeExecutionAnswer(input, { ...result, kind: 'workflow' });
  }

  if (selected?.type === 'server-tool') {
    return await composeExecutionAnswer(input, await executeServerTool(selected, input.inputText));
  }

  if (selected?.type === 'skill-package' && selected.skillPackageId) {
    return await executeSkillPackageContext(input, selected.skillPackageId);
  }

  if (selected?.type === 'mcp-tool') {
    const execution = await executeMcpToolCandidate(selected);
    if (wantsReport) {
      if (!execution.context || !execution.result.ok) return execution.result;
      const workflowResult = await executeWorkflow({
        workflowId: 'report.inspection',
        requestText: input.inputText,
        context: { toolResults: [execution.context] },
      });
      return await composeExecutionAnswer(input, { ...workflowResult, kind: 'workflow' });
    }
    return await composeExecutionAnswer(input, execution.result);
  }

  if (selected?.type === 'mcp.manual' || selected?.type === 'mcp.auto') {
    if (!supportsMcpTools(input.model.provider)) {
      const message = '当前模型配置不支持 MCP 工具调用。';
      return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
    }
    const deterministic = await executeMcpDeterministic(input.inputText, input.chatMcpMode, input.selectedManualMcpServer, input.routeDecision);
    if (wantsReport) {
      if (!deterministic.context || !deterministic.result.ok) return deterministic.result;
      const workflowResult = await executeWorkflow({
        workflowId: 'report.inspection',
        requestText: input.inputText,
        context: { toolResults: [deterministic.context] },
      });
      return await composeExecutionAnswer(input, { ...workflowResult, kind: 'workflow' });
    }
    if (deterministic.result.ok || input.routeDecision?.explicitToolUse) {
      return await composeExecutionAnswer(input, deterministic.result);
    }
    if (selected.type === 'mcp.auto') return await composeExecutionAnswer(input, await executeMcpPlanner(input));
    return deterministic.result;
  }

  return await executeModel(input);
};
