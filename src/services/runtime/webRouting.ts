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

const normalizeText = (value: string) => value.trim().toLowerCase();

const REPORT_ACTION_HINTS = [
  '生成报告',
  '导出报告',
  '巡检并生成报告',
  '并生成报告',
  '并且生成报告',
  '生成今天的报告',
  '生成巡检报告',
  '导出巡检结果',
];

const WORKFLOW_PRIORITY: Record<string, number> = {
  'status.overview': 300,
  'time.check': 300,
  'report.inspection': 50,
};

const CANDIDATE_TYPE_PRIORITY: Record<ChatExecutionCandidate['type'], number> = {
  workflow: 5000,
  skill: 4000,
  'mcp.manual': 3000,
  'mcp.auto': 2000,
  model: 0,
};

const getWorkflowPriority = (skill: SkillExecutionCandidate, input: string): number => {
  if (!skill.workflowId) return 0;
  const normalizedInput = normalizeText(input);
  const hasReportAction = isReportAction(normalizedInput);
  if (hasReportAction && skill.workflowId === 'report.inspection') return 1000;
  return WORKFLOW_PRIORITY[skill.workflowId] || 10;
};

const isReportAction = (normalizedInput: string): boolean => {
  if (REPORT_ACTION_HINTS.some((hint) => normalizedInput.includes(hint))) return true;
  return /生成.+报告/.test(normalizedInput) || /导出.+报告/.test(normalizedInput);
};

const compareSkillMatches = (
  input: string,
  left: { skill: SkillExecutionCandidate; match: SkillRouteMatch },
  right: { skill: SkillExecutionCandidate; match: SkillRouteMatch },
) => {
  const leftPriority = getWorkflowPriority(left.skill, input);
  const rightPriority = getWorkflowPriority(right.skill, input);
  const normalizedInput = normalizeText(input);
  const hasReportAction = isReportAction(normalizedInput);

  if (hasReportAction && leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  const scoreDelta = right.match.score - left.match.score;
  if (Math.abs(scoreDelta) > 0.02) return scoreDelta;

  if (leftPriority !== rightPriority) return rightPriority - leftPriority;

  const triggerLengthDelta = (right.match.matchedTrigger || '').length - (left.match.matchedTrigger || '').length;
  if (triggerLengthDelta !== 0) return triggerLengthDelta;

  return left.skill.name.localeCompare(right.skill.name);
};

const scoreSkillMatch = (input: string, skill: SkillExecutionCandidate): SkillRouteMatch | null => {
  const normalizedInput = normalizeText(input);
  const candidates = [
    { text: skill.name, score: 0.96 },
    { text: skill.serverId, score: 0.92 },
    ...(skill.toolName ? [{ text: skill.toolName, score: 0.9 }] : []),
    ...(skill.resolvedToolName && skill.resolvedToolName !== skill.toolName ? [{ text: skill.resolvedToolName, score: 0.89 }] : []),
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

export function buildWebExecutionPlan(
  input: string,
  allowedSkills: SkillExecutionCandidate[],
  options: { chatMcpMode?: 'disabled' | 'manual' | 'auto'; selectedManualMcpServer?: string | null } = {},
): ChatExecutionPlan {
  const route = routeWebChatInput(input);
  const matchedSkills: SkillRouteMatch[] = [];
  const executableSkills: SkillRouteMatch[] = [];
  const candidates: ChatExecutionCandidate[] = [];
  const scoredMatches = allowedSkills
    .map((skill) => ({ skill, match: scoreSkillMatch(input, skill) }))
    .filter((item): item is { skill: SkillExecutionCandidate; match: SkillRouteMatch } => Boolean(item.match))
    .sort((a, b) => compareSkillMatches(input, a, b));

  matchedSkills.push(...scoredMatches.map((item) => item.match));

  const normalizedInput = normalizeText(input);
  const hasReportAction = isReportAction(normalizedInput);
  const workflowMatches = scoredMatches.filter((item) => item.skill.workflowId);
  const singleStepMatches = scoredMatches.filter((item) => !item.skill.workflowId);

  if (!route.blocked) {
    const statusWorkflow = workflowMatches.find((item) => item.skill.workflowId === 'status.overview');
    if (route.intent === 'task.managed.query') {
      candidates.push({
        type: 'workflow',
        score: CANDIDATE_TYPE_PRIORITY.workflow + 900 + (statusWorkflow?.match.score || 0),
        reason: '托管/端口状态查询进入状态 Workflow。',
        skillName: statusWorkflow?.skill.name,
        workflowId: 'status.overview',
        requiresConfirmation: false,
      });
    }

    const reportWorkflow = workflowMatches.find((item) => item.skill.workflowId === 'report.inspection');
    if (hasReportAction) {
      candidates.push({
        type: 'workflow',
        score: CANDIDATE_TYPE_PRIORITY.workflow + 1200 + (reportWorkflow?.match.score || 0),
        reason: reportWorkflow
          ? '用户请求生成报告，优先进入报告 Workflow。'
          : '用户请求生成报告，进入内置报告 Workflow。',
        skillName: reportWorkflow?.skill.name,
        workflowId: 'report.inspection',
        requiresConfirmation: false,
      });
    }
    const selectedWorkflow = hasReportAction && reportWorkflow ? reportWorkflow : workflowMatches[0];
    if (
      !hasReportAction &&
      selectedWorkflow?.skill.workflowId &&
      route.intent !== 'task.managed.create' &&
      !(route.intent === 'task.managed.query' && selectedWorkflow.skill.workflowId === 'status.overview')
    ) {
      candidates.push({
        type: 'workflow',
        score: CANDIDATE_TYPE_PRIORITY.workflow + getWorkflowPriority(selectedWorkflow.skill, input) + selectedWorkflow.match.score,
        reason: hasReportAction && selectedWorkflow.skill.workflowId === 'report.inspection'
          ? '用户请求生成报告，优先进入报告 Workflow。'
          : `命中 Workflow Skill：${selectedWorkflow.skill.name}`,
        skillName: selectedWorkflow.skill.name,
        workflowId: selectedWorkflow.skill.workflowId,
        requiresConfirmation: false,
      });
    }

    const selectedSingleStep = singleStepMatches.find((item) => {
      if (route.intent === 'task.managed.query') return false;
      if (route.intent === 'task.managed.create') return item.skill.taskKind === 'managed';
      if (route.intent === 'task.instant.execute_candidate') return item.skill.taskKind === 'instant' || item.skill.taskKind === 'managed';
      return item.match.score >= 0.8;
    });
    if (selectedSingleStep) {
      candidates.push({
        type: 'skill',
        score: CANDIDATE_TYPE_PRIORITY.skill + selectedSingleStep.match.score,
        reason: `命中单步 Skill：${selectedSingleStep.skill.name}`,
        skillName: selectedSingleStep.skill.name,
        serverId: selectedSingleStep.skill.serverId,
        toolName: selectedSingleStep.skill.resolvedToolName || selectedSingleStep.skill.toolName,
        requiresConfirmation: false,
      });
    }

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

  if (route.intent === 'chat.general') {
    const directInstantMatches = scoredMatches
      .filter((item) => item.skill.taskKind === 'instant')
      .filter((item) => item.match.score >= 0.8)
      .slice(0, 1)
      .map((item) => item.match);
    executableSkills.push(...directInstantMatches);
  }

  candidates.push({
    type: 'model',
    score: CANDIDATE_TYPE_PRIORITY.model,
    reason: '没有更高优先级的可执行候选，交给普通模型回答。',
    requiresConfirmation: false,
  });

  const selected = [...candidates].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
    return CANDIDATE_TYPE_PRIORITY[right.type] - CANDIDATE_TYPE_PRIORITY[left.type];
  })[0];

  return { route, matchedSkills, executableSkills, candidates, selected };
}
