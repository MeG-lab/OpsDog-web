import type { ChatExecutionPlan, ChatRouteDecision, SkillRouteMatch } from '../../types';
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
    'filesystem',
    '文件系统',
    '列目录',
    '读取文件',
    '读文件',
    '调用工具',
  ]) && !conceptualToolQuestion;
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
    requiresConfirmation: explicitToolUse,
    hasConfirmation,
    confirmationToken: explicitToolUse ? '确认调用工具' : null,
    confirmationTitle: explicitToolUse ? '外部工具调用确认' : null,
    confirmationSummary: explicitToolUse
      ? `当前请求计划调用 MCP 外部工具，允许的最高风险等级为 ${maxMcpRiskLevel}。请确认后再继续。`
      : null,
    confidence,
    reasonCodes,
  };
}

const normalizeText = (value: string) => value.trim().toLowerCase();

const scoreSkillMatch = (input: string, skill: SkillExecutionCandidate): SkillRouteMatch | null => {
  const normalizedInput = normalizeText(input);
  const scriptName = skill.entryScript.split('/').pop() || '';
  const scriptBase = scriptName.replace(/\.[^.]+$/, '');
  const candidates = [
    { text: skill.name, score: 0.96 },
    { text: scriptName, score: 0.92 },
    { text: scriptBase, score: 0.9 },
    ...skill.triggers.map((trigger) => ({ text: trigger, score: 0.88 })),
  ];

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeText(candidate.text);
    if (normalizedCandidate && normalizedInput.includes(normalizedCandidate)) {
      return {
        skillName: skill.name,
        score: candidate.score,
        matchedTrigger: candidate.text,
      };
    }
  }

  const descriptionTerms = (skill.description || '')
    .split(/[\s,，。；、]+/)
    .map((term) => normalizeText(term))
    .filter((term) => term.length >= 4);

  const descriptionHit = descriptionTerms.find((term) => normalizedInput.includes(term));
  if (descriptionHit) {
    return {
      skillName: skill.name,
      score: 0.72,
      matchedTrigger: descriptionHit,
    };
  }

  return null;
};

export function buildWebExecutionPlan(input: string, allowedSkills: SkillExecutionCandidate[]): ChatExecutionPlan {
  const route = routeWebChatInput(input);
  const matchedSkills: SkillRouteMatch[] = [];
  const executableSkills: SkillRouteMatch[] = [];
  const scoredMatches = allowedSkills
    .map((skill) => ({ skill, match: scoreSkillMatch(input, skill) }))
    .filter((item): item is { skill: SkillExecutionCandidate; match: SkillRouteMatch } => Boolean(item.match))
    .sort((a, b) => b.match.score - a.match.score);

  matchedSkills.push(...scoredMatches.map((item) => item.match));

  if (route.intent === 'task.instant.execute_candidate') {
    executableSkills.push(
      ...scoredMatches
        .filter((item) => item.skill.taskKind === 'instant')
        .slice(0, 2)
        .map((item) => item.match),
    );
  }

  if (route.intent === 'task.managed.create' || route.intent === 'task.instant.execute_candidate') {
    executableSkills.push(
      ...scoredMatches
        .filter((item) => item.skill.taskKind === 'managed')
        .slice(0, 1)
        .map((item) => item.match),
    );
  }

  return { route, matchedSkills, executableSkills };
}
