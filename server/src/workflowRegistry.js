const normalizeText = (value) => String(value || '').trim();

const wantsTimeContext = (text) => /(系统时间|当前时间|几点|time)/i.test(text);
const parseToolJsonText = (result) => {
  const text = Array.isArray(result?.content)
    ? result.content.map((item) => item?.text || '').join('\n').trim()
    : '';
  if (!text) return { rawText: '', parsed: null };
  try {
    return { rawText: text, parsed: JSON.parse(text) };
  } catch {
    return { rawText: text, parsed: null };
  }
};

const getDefaultToolName = (server) => {
  const tools = Array.isArray(server?.capabilities?.tools) ? server.capabilities.tools : [];
  return tools.find((tool) => tool?.isDefault)?.name || tools[0]?.name || '';
};

const scoreTimeCapability = (server) => {
  if (!server || server.category === 'managed' || server.category === 'system') return 0;
  const tools = Array.isArray(server.capabilities?.tools) ? server.capabilities.tools : [];
  const text = [
    server.name,
    server.description,
    server.entry,
    ...tools.flatMap((tool) => [tool?.name, tool?.description]),
  ].map((item) => normalizeText(item).toLowerCase()).join('\n');

  let score = 0;
  if (/(系统时间|当前时间|查询时间|时间检查)/i.test(text)) score += 10;
  if (/\btime\b/i.test(text)) score += 8;
  if (/(clock|datetime|timestamp|date)/i.test(text)) score += 4;
  if (server.category === 'instant') score += 2;
  return score;
};

const findTimeCapabilityServer = (servers) => {
  const candidates = (Array.isArray(servers) ? servers : [])
    .map((server) => ({ server, score: scoreTimeCapability(server) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || String(left.server.id).localeCompare(String(right.server.id)));
  return candidates[0]?.server || null;
};

const summarizeServers = (servers) => {
  const targetServers = servers.filter((server) => server.category !== 'system');
  const runningCount = targetServers.filter((server) => server.status === 'running').length;
  const alertServers = targetServers.filter((server) => ['warning', 'attention', 'error'].includes(server.status));
  const recoveredServers = targetServers.filter((server) => server.status === 'recovered');
  return {
    servers: targetServers.map((server) => ({
      id: server.id,
      name: server.name,
      category: server.category,
      status: server.status,
      description: server.description,
    })),
    alerts: alertServers.map((server) => ({
      id: server.id,
      name: server.name,
      status: server.status,
      description: server.description,
      detail: server.capabilities?.recentLogs?.slice(-1)[0] || '',
    })),
    recoveries: recoveredServers.map((server) => ({
      id: server.id,
      name: server.name,
      status: server.status,
      description: server.description,
      detail: server.capabilities?.recentLogs?.slice(-1)[0] || '',
    })),
    summary: `本次共巡检 ${targetServers.length} 个服务器对象，其中运行中 ${runningCount} 个，需关注/异常 ${alertServers.length} 个，已恢复 ${recoveredServers.length} 个。`,
  };
};

const MANAGED_ACTIVE_STATUSES = ['running', 'attention', 'warning', 'recovered', 'starting', 'stopping'];

const extractStatusQueryHints = (text) => ({
  ports: Array.from(new Set(String(text || '').match(/\b\d{2,5}\b/g) || [])),
  wantsDetail: /(最近|日志|异常|告警|恢复|详情|具体|端口|进程|server\s*[:：\w-]+)/i.test(text) || /\b\d{2,5}\b/.test(text),
  wantsRunning: /(运行|在跑|哪些|running)/i.test(text),
  wantsException: /(异常|告警|挂过|失败|warning|error)/i.test(text),
  wantsRecovered: /(恢复|recovered)/i.test(text),
});

const recentLogText = (server) => (server?.capabilities?.recentLogs || []).join('\n');

const serverMatchesStatusQuery = (server, text, hints) => {
  const normalized = normalizeText(text).toLowerCase();
  const fields = [
    server.id,
    server.name,
    server.description,
    server.entry,
    recentLogText(server),
  ].map((item) => normalizeText(item).toLowerCase());
  if (fields.some((field) => field && normalized.includes(field))) return true;
  if (hints.ports.length > 0) {
    const combined = fields.join('\n');
    return hints.ports.some((port) => combined.includes(port));
  }
  return false;
};

const parseRecentEvents = (server) => (server?.capabilities?.recentLogs || [])
  .flatMap((line) => String(line || '').split(/\r?\n/))
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(-8);

const buildServerDetailStep = (server) => {
  const events = parseRecentEvents(server);
  const warningEvents = events.filter((line) => /(warning|attention|error|异常|告警|失败)/i.test(line));
  const recoveredEvents = events.filter((line) => /(recovered|恢复)/i.test(line));
  const findings = [
    `当前状态：${server.status}`,
    `最近日志：${events.length} 条`,
    ...(warningEvents.length > 0 ? [`异常/告警日志：${warningEvents.length} 条`] : []),
    ...(recoveredEvents.length > 0 ? [`恢复日志：${recoveredEvents.length} 条`] : []),
  ];

  return buildStepResult({
    id: `server-detail-${server.id}`,
    title: `查看 ${server.name || server.id} 状态详情`,
    status: 'completed',
    serverId: server.id,
    summary: `${server.name || server.id} 当前状态为 ${server.status}。`,
    findings,
    data: {
      id: server.id,
      name: server.name,
      category: server.category,
      status: server.status,
      description: server.description,
      recentLogs: events,
    },
  });
};

const buildStepResult = ({ id, title, status = 'completed', summary = '', findings = [], artifacts = [], data = {}, serverId, toolName, error }) => ({
  id,
  title,
  status,
  ...(serverId ? { serverId } : {}),
  ...(toolName ? { toolName } : {}),
  ...(summary ? { summary } : {}),
  ...(Array.isArray(findings) && findings.length > 0 ? { findings } : {}),
  ...(Array.isArray(artifacts) && artifacts.length > 0 ? { artifacts } : {}),
  ...(data && Object.keys(data).length > 0 ? { data } : {}),
  ...(error ? { error } : {}),
});

const buildStatusOverview = async ({ listServers, requestText }) => {
  const servers = await listServers();
  const statusSummary = summarizeServers(servers);
  const text = normalizeText(requestText);
  const hints = extractStatusQueryHints(text);
  const managedServers = servers.filter((server) => server.category === 'managed');
  const matchedManagedServers = hints.wantsDetail
    ? managedServers.filter((server) => serverMatchesStatusQuery(server, text, hints))
    : [];

  if (hints.wantsDetail) {
    const detailTargets = matchedManagedServers.length > 0 ? matchedManagedServers : hints.ports.length > 0 ? [] : managedServers;
    if (detailTargets.length === 0) {
      return {
        ok: false,
        kind: 'workflow',
        workflowId: 'status.overview',
        summary: '没有找到匹配的托管 Server。',
        steps: [
          buildStepResult({
            id: 'match-managed-server',
            title: '匹配托管 Server',
            status: 'failed',
            summary: `查询条件：${text || '无'}`,
            error: '没有找到匹配的托管 Server。',
            data: { ports: hints.ports },
          }),
        ],
        artifacts: [],
        highlights: [],
        errors: ['没有找到匹配的托管 Server。'],
      };
    }

    const steps = detailTargets.map(buildServerDetailStep);
    const highlights = steps.flatMap((step) => step.findings || []);
    return {
      ok: true,
      kind: 'workflow',
      workflowId: 'status.overview',
      summary: `已查询 ${detailTargets.length} 个托管 Server 的状态详情。`,
      steps,
      artifacts: [],
      highlights,
      errors: [],
    };
  }

  return {
    ok: true,
    kind: 'workflow',
    workflowId: 'status.overview',
    summary: statusSummary.summary,
    steps: [
      {
        id: 'collect-status',
        title: '收集服务器状态',
        status: 'completed',
        summary: statusSummary.summary,
        findings: [
          `运行中：${statusSummary.servers.filter((server) => server.status === 'running').length}`,
          `告警/需关注：${statusSummary.alerts.length}`,
          `已恢复：${statusSummary.recoveries.length}`,
        ],
        data: statusSummary,
      },
    ],
    artifacts: [],
    highlights: [
      `运行中：${statusSummary.servers.filter((server) => server.status === 'running').length}`,
      `告警/需关注：${statusSummary.alerts.length}`,
      `已恢复：${statusSummary.recoveries.length}`,
    ],
    errors: [],
  };
};

const buildTimeCheck = async ({ requestText, listServers, callServerToolById }) => {
  const servers = await listServers();
  const timeServer = findTimeCapabilityServer(servers);
  if (!timeServer) {
    return {
      ok: false,
      kind: 'workflow',
      workflowId: 'time.check',
      summary: '未找到可用的时间检查能力，无法执行时间检查。',
      steps: [
        {
          id: 'read-time',
          title: '检查系统时间',
          status: 'failed',
          error: '未找到描述或工具能力中包含时间语义的即时 Server。',
        },
      ],
      artifacts: [],
      highlights: [],
      errors: ['未找到可用的时间检查能力。'],
    };
  }

  try {
    const toolName = getDefaultToolName(timeServer);
    if (!toolName) {
      throw new Error('时间检查能力没有可调用工具。');
    }
    const result = await callServerToolById(timeServer.id, toolName, {
      requestText,
      input: { requestText },
    });
    const { parsed, rawText } = parseToolJsonText(result);
    const timestamp = parsed?.result?.timestamp || parsed?.timestamp || rawText || '未知';
    return {
      ok: true,
      kind: 'workflow',
      workflowId: 'time.check',
      summary: '已完成系统时间检查。',
      steps: [
        {
          id: 'read-time',
          title: '检查系统时间',
          status: 'completed',
          serverId: timeServer.id,
          toolName,
          summary: `当前系统时间：${timestamp}`,
          findings: [`当前系统时间：${timestamp}`],
          data: { timestamp },
        },
      ],
      artifacts: [],
      highlights: [`当前系统时间：${timestamp}`],
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'workflow',
      workflowId: 'time.check',
      summary: '系统时间检查失败。',
      steps: [
        {
          id: 'read-time',
          title: '检查系统时间',
          status: 'failed',
          serverId: timeServer.id,
          toolName: getDefaultToolName(timeServer),
          error: error instanceof Error ? error.message : String(error),
        },
      ],
      artifacts: [],
      highlights: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
};

export const workflowRegistry = {
  'status.overview': {
    intent: '查看服务器状态',
    execute: buildStatusOverview,
  },
  'time.check': {
    intent: '检查系统时间',
    execute: buildTimeCheck,
  },
};

export const executeWorkflowById = async (workflowId, requestContext) => {
  const workflow = workflowRegistry[workflowId];
  if (!workflow) {
    throw new Error(`Workflow 未找到：${workflowId}`);
  }
  return await workflow.execute(requestContext);
};
