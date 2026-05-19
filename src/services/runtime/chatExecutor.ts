import type {
  ChatExecutionCandidate,
  ChatMcpMode,
  ChatRouteDecision,
  ExecutionResult,
  LLMConfig,
  Message,
  Skill,
} from '../../types';
import {
  callMCPTool,
  executeInstantSkill,
  executeWorkflow,
  listMCPServers,
  listMCPTools,
  sendChatMessage,
  startServer,
  validateSkillArgs,
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
  enabledSkills: Skill[];
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

const buildSkillArgs = (skillName: string, inputText: string): string[] | null => {
  if (skillName === 'aliyun_voice_make_call') {
    const calledNumber =
      inputText.match(/\b1\d{10}\b/)?.[0]
      || inputText.match(/\b0\d{2,3}-?\d{7,8}\b/)?.[0]
      || inputText.match(/(?:给|向|拨打|通知)\s*((?:1\d{10}|0\d{2,3}-?\d{7,8}))/)?.[1]
      || '';
    const equipment =
      inputText.match(/(?:设备|equipment)[：:\s]*([^\n，。,;；]{1,15})/)?.[1]?.trim()
      || inputText.match(/(?:内容|播报|告警)[：:\s]*([^\n，。,;；]{1,15})/)?.[1]?.trim()
      || '';
    if (!calledNumber || !equipment) return null;
    return ['--called-number', calledNumber, '--equipment', equipment];
  }

  if (skillName === 'aliyun_voice_query_call') {
    const callId =
      inputText.match(/call[\s_-]?id[：:\s]*([^\s，。；;]+)/i)?.[1]
      || inputText.match(/\b([A-Za-z0-9^_*.-]{8,})\b/)?.[1]
      || '';
    if (!callId) return null;
    return ['--call-id', callId];
  }

  if (skillName.toLowerCase().includes('log')) {
    const pathMatch = inputText.match(/(?:\/[\w.\-/:]+(?:\.log|\.txt|\.json))/);
    if (!pathMatch) return null;
    return [pathMatch[0]];
  }
  return [];
};

const collectFlagValues = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  if (index === -1) return [];
  const values: string[] = [];
  for (let cursor = index + 1; cursor < args.length && !args[cursor].startsWith('--'); cursor += 1) {
    values.push(args[cursor]);
  }
  return values;
};

const firstFlagValue = (args: string[], flag: string) => collectFlagValues(args, flag)[0] || '';

const extractManagedTaskCreationConfig = (inputText: string) => ({
  host: inputText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] || '127.0.0.1',
  port:
    inputText.match(/(?:端口|port)[^\d]{0,6}(\d{2,5})/i)?.[1] ||
    inputText.match(/(?:监控|监测|检测|盯着|守着)\s*(\d{2,5})\s*端口?/i)?.[1] ||
    inputText.match(/\b(\d{2,5})\b/)?.[1] ||
    '',
  process:
    inputText.match(/(?:进程|process)[^a-zA-Z0-9._-]{0,4}([a-zA-Z0-9._-]+)/i)?.[1] ||
    inputText.match(/\b(nginx|redis|mysql|node|python|java|postgres|docker)\b/i)?.[1] ||
    '',
  interval:
    inputText.match(/(?:每|间隔)\s*(\d+)\s*秒/i)?.[1] ||
    inputText.match(/(\d+)\s*秒(?:一次|轮询|检测|检查)/i)?.[1] ||
    '5',
  maxFailures:
    inputText.match(/连续失败\s*(\d+)\s*次/i)?.[1] ||
    inputText.match(/失败\s*(\d+)\s*次.*告警/i)?.[1] ||
    '3',
  logFile: inputText.match(/(?:\/[\w.\-/:]+(?:\.log|\.txt|\.json))/)?.[0] || '',
});

const buildManagedTaskArgsFromInput = (skill: Skill, inputText: string): string[] => {
  const defaults = skill.defaultArgs || [];
  const extracted = extractManagedTaskCreationConfig(inputText);
  const usesTargets = defaults.includes('--targets');
  if (usesTargets) {
    const explicitTargets = Array.from(new Set(inputText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []));
    const fallbackTargets = collectFlagValues(defaults, '--targets');
    const targets = explicitTargets.length > 0 ? explicitTargets : fallbackTargets;
    const args = ['--targets', ...targets, '--interval', extracted.interval || firstFlagValue(defaults, '--interval') || '5', '--max-failures', extracted.maxFailures || firstFlagValue(defaults, '--max-failures') || '3'];
    if (extracted.logFile) args.push('--log-file', extracted.logFile);
    return args;
  }
  const args: string[] = [];
  if (extracted.process || firstFlagValue(defaults, '--process')) args.push('--process', extracted.process || firstFlagValue(defaults, '--process'));
  args.push('--host', extracted.host || firstFlagValue(defaults, '--host') || '127.0.0.1');
  if (extracted.port || firstFlagValue(defaults, '--port')) args.push('--port', extracted.port || firstFlagValue(defaults, '--port'));
  args.push('--interval', extracted.interval || firstFlagValue(defaults, '--interval') || '3', '--max-failures', extracted.maxFailures || firstFlagValue(defaults, '--max-failures') || '3');
  if (extracted.logFile) args.push('--log-file', extracted.logFile);
  return args;
};

const executeSkill = async (skill: Skill, inputText: string): Promise<ExecutionResult> => {
  if (skill.bindingStatus !== 'resolved') {
    const message = `Skill 绑定无效，暂未执行。${skill.bindingError ? ` ${skill.bindingError}` : ''}`;
    return emptyResult({ kind: 'tool', summary: message, errors: [message], textFallback: message });
  }
  if (skill.taskKind === 'managed') {
    const args = buildManagedTaskArgsFromInput(skill, inputText);
    const validated = await validateSkillArgs(skill.path, args);
    if (!validated.valid) {
      const message = ['参数还不完整，暂未启动。', ...validated.errors.map(error => `- ${error}`)].join('\n');
      return emptyResult({ kind: 'tool', summary: '托管任务参数不完整。', errors: validated.errors, textFallback: message });
    }
    const task = await startServer(skill.serverId, {
      args: validated.normalizedArgs,
      input: { args: validated.normalizedArgs, toolName: skill.resolvedToolName || skill.toolName || undefined },
    });
    const text = [
      `好的，\`${skill.name}\` 任务已经在后台启动了。`,
      '',
      `- 绑定 Server：\`${skill.serverId}\``,
      `- 绑定 Tool：\`${skill.resolvedToolName || skill.toolName || '默认工具'}\``,
      `- 启动参数：\`${validated.normalizedArgs.join(' ')}\``,
      `- 当前状态：${task.status}`,
    ].join('\n');
    return {
      ok: true,
      kind: 'tool',
      summary: `已启动托管 Skill：${skill.name}`,
      steps: [{
        id: `skill-${skill.name}`,
        title: `执行 Skill：${skill.name}`,
        status: 'completed',
        serverId: skill.serverId,
        toolName: skill.resolvedToolName || skill.toolName,
        summary: text,
      }],
      artifacts: [],
      highlights: [],
      errors: [],
      textFallback: text,
    };
  }

  const args = buildSkillArgs(skill.name, inputText);
  if (args === null) {
    const message = '缺少必需参数，暂未执行。';
    return emptyResult({ kind: 'tool', summary: message, errors: [message], textFallback: message });
  }
  const result = await executeInstantSkill(skill.name, args, { requestText: inputText });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const text = [
    '已调用本地即时任务。',
    '',
    `任务：${skill.name}`,
    `Server：${skill.serverId || '未绑定'}`,
    `Tool：${skill.resolvedToolName || skill.toolName || '默认工具'}`,
    `执行状态：${result.exitCode === 0 ? '成功' : '失败'}`,
    ...(stdout ? ['结果：', stdout] : []),
    ...(stderr ? ['错误输出：', stderr] : []),
  ].join('\n');
  return {
    ok: result.exitCode === 0,
    kind: 'tool',
    summary: `已处理 Skill：${skill.name}`,
    steps: [{
      id: `skill-${skill.name}`,
      title: `执行 Skill：${skill.name}`,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      serverId: skill.serverId,
      toolName: skill.resolvedToolName || skill.toolName,
      summary: stdout || text,
      error: result.exitCode === 0 ? undefined : stderr || text,
    }],
    artifacts: [],
    highlights: [],
    errors: result.exitCode === 0 ? [] : [stderr || text],
    textFallback: text,
  };
};

const buildModelMessages = (messages: Message[], assistantMessageId: string, inputText: string, chatMcpMode: ChatMcpMode) => {
  const apiMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = messages
    .filter(message => message.role !== 'system' && message.id !== assistantMessageId)
    .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }));
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
      skillName: selected.skillName,
      context,
    });
    return await composeExecutionAnswer(input, { ...result, kind: 'workflow' });
  }

  if (selected?.type === 'skill' && selected.skillName) {
    const skill = input.enabledSkills.find((item) => item.name === selected.skillName);
    if (!skill) {
      const message = `Skill 执行失败：未找到 ${selected.skillName}`;
      return emptyResult({ kind: 'error', summary: message, errors: [message], textFallback: message });
    }
    return await composeExecutionAnswer(input, await executeSkill(skill, input.inputText));
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
