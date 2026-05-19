import type { ChatExecutionCandidate, ChatExecutionPlan, ChatRouteDecision, SkillRouteMatch } from '../../types';
import type { SkillExecutionCandidate } from './types';

const containsAny = (haystack: string, needles: string[]) => needles.some(item => haystack.includes(item));

const hasNumberToken = (input: string): boolean => /\d{2,}/.test(input);

export function routeWebChatInput(input: string): ChatRouteDecision {
  const normalized = input.trim().toLowerCase();
  const reasonCodes: string[] = [];
  const conceptualToolQuestion =
    containsAny(normalized, ['是什么', '做什么', '有什么用', '用途', '介绍', '说明', '怎么用']) &&
    containsAny(normalized, ['mcp', '工具', 'tool', 'filesystem', '文件系统']);

  const blockedPatterns = [
    'rm -rf /',
    'rm -rf ~',
    'mkfs',
    'dd if=',
    'shutdown -h',
    'reboot now',
    'curl http',
    'curl https',
    'wget http',
    'chmod -r 777 /',
    'kill -9 1',
    'sudo rm',
  ];

  if (blockedPatterns.some(pattern => normalized.includes(pattern))) {
    reasonCodes.push('dangerous_command');
    return {
      intent: 'unsafe.or.unknown',
      blocked: true,
      blockReason: '输入中包含高风险系统命令片段，已阻止进入模型与工具执行链路。',
      localOnly: true,
      allowMcp: false,
      maxMcpRiskLevel: 'none',
      explicitToolUse: false,
      requiresConfirmation: false,
      hasConfirmation: false,
      confidence: 1,
      reasonCodes,
    };
  }

  const promptInjectionHints = [
    '忽略之前',
    '忽略上面的要求',
    '忽略系统提示',
    'ignore previous',
    'ignore all previous',
    'system prompt',
    'developer message',
    'you are now',
    '假装是系统管理员',
    '绕过限制',
    '禁用安全检查',
    'override safety',
  ];
  const promptInjectionDetected = promptInjectionHints.some(pattern => normalized.includes(pattern));
  if (promptInjectionDetected) reasonCodes.push('prompt_injection');

  const skillCatalog =
    normalized.includes('skill') ||
    normalized.includes('技能') ||
    normalized.includes('会什么') ||
    normalized.includes('能干什么') ||
    normalized.includes('有什么能力');
  if (skillCatalog) reasonCodes.push('skill_catalog_query');

  const managedCreate = (() => {
    const intentHints = ['持续', '一直', '长期', '托管', '监控', '监测', '守护', '盯着', '值守', '告警'];
    const actionHints = ['帮我', '给我', '创建', '新增', '加个', '配置', '设置', '建立', '启动'];
    const targetHints = ['端口', 'port', '进程', 'process', '服务', 'nginx', 'redis', 'mysql', 'node', 'python', 'java'];
    const hasIntent = intentHints.some(hint => normalized.includes(hint));
    const hasAction = actionHints.some(hint => normalized.includes(hint));
    const hasTarget = targetHints.some(hint => normalized.includes(hint)) || hasNumberToken(input);
    return hasIntent && (hasAction || hasTarget);
  })();
  if (managedCreate) reasonCodes.push('managed_task_create');

  const managedQuery =
    normalized.includes('托管任务') ||
    normalized.includes('持续任务') ||
    normalized.includes('watchdog') ||
    normalized.includes('守护') ||
    (containsAny(normalized, ['状态', '日志', '运行', '异常', '告警', '恢复', '挂过', '最近', '怎么样', '情况']) &&
      (containsAny(normalized, ['端口', '服务', '任务']) || hasNumberToken(input)));
  if (managedQuery) reasonCodes.push('managed_task_query');

  const instantExecuteCandidate = (() => {
    const actionHints = ['执行', '运行', '测试', '检查', '检测', '排查', '巡检', '诊断', 'run', 'execute', 'check', 'test', 'inspect', 'ping'];
    return !managedCreate && !managedQuery && !skillCatalog && actionHints.some(hint => normalized.includes(hint));
  })();
  if (instantExecuteCandidate) reasonCodes.push('instant_task_candidate');

  const explicitToolUse = containsAny(normalized, [
    'mcp',
    '工具',
    'tool',
    'fetch',
    'filesystem',
    '文件系统',
    '列目录',
    '读取文件',
    '读文件',
    '调用工具',
    '抓取网页',
    '抓取页面',
    '获取网页',
    '获取页面',
    '读取网页',
    '读取页面',
  ]) && !conceptualToolQuestion
    || (!!input.match(/https?:\/\//i) && containsAny(normalized, ['抓取', '获取', '读取', 'fetch', '网页', '页面']));
  if (explicitToolUse) reasonCodes.push('explicit_tool_request');
  if (conceptualToolQuestion) reasonCodes.push('tool_concept_question');

  const hasConfirmation =
    normalized.includes('确认调用工具') ||
    normalized.includes('确认执行') ||
    normalized.includes('允许调用工具') ||
    normalized.includes('批准调用工具');

  const destructiveToolIntent = containsAny(normalized, [
    '删除',
    '清空',
    '移除',
    'drop',
    'delete',
    'remove',
    'kill',
    'shutdown',
    'reboot',
    '重启服务',
    '停止服务',
    '卸载',
  ]);
  if (destructiveToolIntent) reasonCodes.push('destructive_tool_intent');

  const stateChangeToolIntent =
    destructiveToolIntent ||
    containsAny(normalized, [
      '创建',
      '修改',
      '更新',
      '写入',
      '保存',
      '重载',
      '启动服务',
      'restart',
      'update',
      'write',
      'apply',
      'patch',
      'create',
    ]);
  if (stateChangeToolIntent && !destructiveToolIntent) reasonCodes.push('state_change_tool_intent');

  const intent = skillCatalog
    ? 'skill.catalog'
    : managedCreate
      ? 'task.managed.create'
      : managedQuery
        ? 'task.managed.query'
        : instantExecuteCandidate
          ? 'task.instant.execute_candidate'
          : 'chat.general';

  const localOnly = intent === 'skill.catalog' || intent === 'task.managed.create' || intent === 'task.managed.query';
  const confidence = promptInjectionDetected ? 0.95 : localOnly ? 0.9 : explicitToolUse ? 0.85 : 0.7;

  if (promptInjectionDetected && explicitToolUse) {
    return {
      intent: 'unsafe.or.unknown',
      blocked: true,
      blockReason: '输入同时包含角色绕过/提示注入特征和工具调用请求，已阻止进入模型与外部工具链路。',
      localOnly: true,
      allowMcp: false,
      maxMcpRiskLevel: 'none',
      explicitToolUse,
      requiresConfirmation: false,
      hasConfirmation,
      confidence,
      reasonCodes,
    };
  }

  const maxMcpRiskLevel: ChatRouteDecision['maxMcpRiskLevel'] =
    !explicitToolUse || promptInjectionDetected
      ? 'none'
      : destructiveToolIntent
        ? 'destructive'
        : stateChangeToolIntent
          ? 'state-change'
          : 'read-only';

  return {
    intent,
    blocked: false,
    blockReason: null,
    localOnly,
    allowMcp: explicitToolUse && !promptInjectionDetected,
    maxMcpRiskLevel,
    explicitToolUse,
    requiresConfirmation: explicitToolUse && maxMcpRiskLevel !== 'read-only',
    hasConfirmation,
    confirmationToken: explicitToolUse && maxMcpRiskLevel !== 'read-only' ? '确认调用工具' : null,
    confirmationTitle: explicitToolUse && maxMcpRiskLevel !== 'read-only' ? '外部工具调用确认' : null,
    confirmationSummary: explicitToolUse && maxMcpRiskLevel !== 'read-only'
      ? `当前请求计划调用 MCP 外部工具，允许的最高风险等级为 ${maxMcpRiskLevel}。请确认后再继续。`
      : null,
    confidence,
    reasonCodes,
  };
}

const CANDIDATE_TYPE_PRIORITY: Record<ChatExecutionCandidate['type'], number> = {
  workflow: 5000,
  skill: 4000,
  'mcp.manual': 3000,
  'mcp.auto': 2000,
  model: 0,
};

export function buildWebExecutionPlan(
  input: string,
  _allowedSkills: SkillExecutionCandidate[],
  options: { chatMcpMode?: 'disabled' | 'manual' | 'auto'; selectedManualMcpServer?: string | null } = {},
): ChatExecutionPlan {
  const route = routeWebChatInput(input);
  const matchedSkills: SkillRouteMatch[] = [];
  const executableSkills: SkillRouteMatch[] = [];
  const candidates: ChatExecutionCandidate[] = [];

  if (!route.blocked) {
    if (route.allowMcp && options.chatMcpMode === 'manual' && options.selectedManualMcpServer) {
      candidates.push({
        type: 'mcp.manual',
        score: CANDIDATE_TYPE_PRIORITY['mcp.manual'] + (route.explicitToolUse ? 10 : 0),
        reason: `MCP 手动模式已选择服务器：${options.selectedManualMcpServer}`,
        serverId: options.selectedManualMcpServer,
        requiresConfirmation: route.requiresConfirmation,
      });
    }

    if (route.allowMcp && options.chatMcpMode === 'auto' && !route.localOnly) {
      candidates.push({
        type: 'mcp.auto',
        score: CANDIDATE_TYPE_PRIORITY['mcp.auto'] + (route.explicitToolUse ? 10 : 0),
        reason: 'MCP 自动模式允许工具规划。',
        requiresConfirmation: route.requiresConfirmation,
      });
    }
  }

  candidates.push({
    type: 'model',
    score: CANDIDATE_TYPE_PRIORITY.model,
    reason: '未启用模型意图规划，交给普通模型回答。',
    requiresConfirmation: false,
  });

  const selected = [...candidates].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
    return CANDIDATE_TYPE_PRIORITY[right.type] - CANDIDATE_TYPE_PRIORITY[left.type];
  })[0];

  return { route, matchedSkills, executableSkills, candidates, selected };
}
