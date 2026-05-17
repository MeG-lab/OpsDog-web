import React from 'react';
import { Activity, AlertTriangle, CheckCircle2, CirclePlay, Clock3, Crosshair, FilePlus2, ShieldAlert } from 'lucide-react';
import { callServerTool } from '../../services/runtime';
import { SYSTEM_ANNOUNCEMENTS_ID, useAppStore, useChatStore, useToastStore } from '../../stores';
import { summarizeManagedServers } from '../../services/serverSummaries';
import type { ServerDefinition } from '../../types';

type OverviewFilter = 'all' | 'healthy' | 'attention' | 'alert';
type DerivedStatus = ServerDefinition['status'];

type DerivedTask = {
  id: string;
  scriptName: string;
  status: DerivedStatus;
  summary: string;
  target: string;
  targetSummary: string;
  ticketTargetKey: string;
  latestEventText: string;
  latestEventAt: number | null;
  warningText: string;
  recoveredText: string;
  recentLogs: string[];
  latestEventLevel: DerivedStatus | null;
  recentAlertCount: number;
  recentRecoveredCount: number;
  latestAlertMessage: string;
  latestAlertDetail: string;
  latestAlertTime: string | null;
};

type OverviewEvent = {
  id: string;
  sourceId: string;
  title: string;
  detail: string;
  timeLabel: string;
  timestamp: number;
  level: 'healthy' | 'attention' | 'alert' | 'neutral';
  repeatCount?: number;
  signature: string;
};

type ParsedTaskEvent = {
  timestamp: number;
  timeLabel: string;
  level: DerivedStatus;
  message: string;
  detail: string;
  target: string;
  primaryOfflineDeviceId: string;
  signature: string;
};

const statusLabel: Record<DerivedStatus, string> = {
  idle: '待命',
  starting: '启动中',
  running: '运行中',
  attention: '需关注',
  warning: '告警中',
  recovered: '已恢复',
  stopping: '停止中',
  stopped: '已停止',
  error: '异常退出',
};

const OverviewWorkspace: React.FC = () => {
  const focusScript = useAppStore((state) => state.focusScript);
  const servers = useAppStore((state) => state.servers);
  const operatorProfile = useAppStore((state) => state.operatorProfile);
  const appendSystemAnnouncement = useChatStore((state) => state.appendSystemAnnouncement);
  const showToast = useToastStore((state) => state.showToast);
  const systemConversation = useChatStore((state) =>
    state.conversations.find((conversation) => conversation.id === SYSTEM_ANNOUNCEMENTS_ID)
  );

  const [filter, setFilter] = React.useState<OverviewFilter>('all');
  const [ticketStateByTask, setTicketStateByTask] = React.useState<Record<string, {
    loading?: boolean;
    ticketId?: string;
    sourceNo?: string;
    error?: string;
  }>>({});
  const tasks = React.useMemo(() => servers.filter((server) => server.category === 'managed'), [servers]);

  const derivedTasks = React.useMemo(() => tasks.map(summarizeTask), [tasks]);
  const filteredTasks = React.useMemo(
    () => derivedTasks.filter((task) => matchesFilter(task, filter)),
    [derivedTasks, filter]
  );

  const counts = React.useMemo(() => {
    const summary = summarizeManagedServers(tasks);
    return {
      running: summary.activeCount,
      healthy: summary.healthyCount,
      attention: derivedTasks.filter((task) => task.status === 'attention').length,
      alert: summary.alertCount,
    };
  }, [derivedTasks, tasks]);

  const activeAlerts = React.useMemo(
    () =>
      [...derivedTasks]
        .filter((task) => task.status === 'warning' || task.status === 'attention' || task.status === 'error')
        .sort((a, b) => statusWeight(b.status) - statusWeight(a.status) || (b.latestEventAt || 0) - (a.latestEventAt || 0))
        .slice(0, 3),
    [derivedTasks]
  );

  const recentEvents = React.useMemo(
    () => buildOverviewEvents(derivedTasks, systemConversation?.messages || []),
    [derivedTasks, systemConversation?.messages]
  );
  const latestUpdatedAt = React.useMemo(
    () => Math.max(0, ...derivedTasks.map((task) => task.latestEventAt || 0)),
    [derivedTasks]
  );
  const monitoredTargetCount = React.useMemo(() => {
    const targets = new Set(
      derivedTasks
        .map((task) => task.targetSummary)
        .filter(Boolean)
    );
    return targets.size;
  }, [derivedTasks]);
  const recentWindowSummary = React.useMemo(() => {
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    const recentTaskEvents = derivedTasks.flatMap((task) =>
      task.recentLogs
        .map(parseManagedTaskLog)
        .filter((item): item is ParsedTaskEvent => Boolean(item))
        .filter((event) => event.timestamp >= tenMinutesAgo)
    );

    const alerts = recentTaskEvents.filter((event) => event.level === 'warning' || event.level === 'attention' || event.level === 'error').length;
    const recoveries = recentTaskEvents.filter((event) => event.level === 'recovered').length;
    const latestAlertAt = Math.max(
      0,
      ...recentTaskEvents
        .filter((event) => event.level === 'warning' || event.level === 'attention' || event.level === 'error')
        .map((event) => event.timestamp)
    );

    return {
      alerts,
      recoveries,
      latestAlertAt,
      quietMinutes: latestAlertAt ? Math.max(1, Math.floor((Date.now() - latestAlertAt) / 60000)) : null,
    };
  }, [derivedTasks]);

  const createTicketForTask = React.useCallback(async (task: DerivedTask) => {
    const targetKey = task.ticketTargetKey || task.target || task.targetSummary || task.id;
    const sourceNo = `OPSDOG-ALERT-${task.id}-${task.latestEventAt || 0}`;

    setTicketStateByTask((state) => ({
      ...state,
      [task.id]: {
        ...state[task.id],
        loading: true,
        error: undefined,
        sourceNo,
      },
    }));

    try {
      const previewResponse = await callServerTool('ticketing', 'build_alert_ticket_payload', {
        serverId: task.id,
        targetKey,
        alertStatus: task.status,
        alertMessage: task.latestAlertMessage || task.summary,
        alertDetail: task.latestAlertDetail || undefined,
        alertTime: task.latestAlertTime || undefined,
        sourceNo,
        rawPayload: {
          taskId: task.id,
          scriptName: task.scriptName,
          status: task.status,
          target: targetKey,
          ticketTargetKey: targetKey,
          summary: task.summary,
          latestEventText: task.latestEventText,
        },
        remark: `来自 ${task.scriptName} 的告警建单`,
      });

      const previewPayload = parseToolJson(previewResponse)?.payload;
      if (!previewPayload || typeof previewPayload !== 'object') {
        throw new Error('工单预览结果缺少 payload。');
      }

      const normalizedPayload = {
        ...previewPayload,
        personName: normalizeMissingValue(String((previewPayload as Record<string, unknown>).personName || ''), operatorProfile.name),
        unitName: normalizeMissingValue(String((previewPayload as Record<string, unknown>).unitName || ''), operatorProfile.organization),
        contactPhone: normalizeMissingValue(String((previewPayload as Record<string, unknown>).contactPhone || ''), operatorProfile.phone),
      };

      const createResponse = await callServerTool('ticketing', 'create_ticket', normalizedPayload);
      const created = parseToolJson(createResponse);

      if (createResponse.isError || !created?.ok) {
        throw new Error(String(created?.error || '工单创建失败。'));
      }

      const ticketId = String(created.ticketId || '');
      setTicketStateByTask((state) => ({
        ...state,
        [task.id]: {
          loading: false,
          ticketId,
          sourceNo,
        },
      }));

      showToast(created.deduplicated ? '已返回已有工单' : '工单创建成功', 'success');
      appendSystemAnnouncement([
        '## 工单通知',
        `任务：${task.scriptName}`,
        `状态：${statusLabel[task.status]}`,
        `工单ID：${ticketId || '未返回'}`,
        `来源编号：${String(created.sourceNo || sourceNo)}`,
        created.deduplicated ? '结果：已命中去重，返回已有工单。' : '结果：已成功创建外部工单。',
      ].join('\n'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTicketStateByTask((state) => ({
        ...state,
        [task.id]: {
          ...state[task.id],
          loading: false,
          error: message,
          sourceNo,
        },
      }));
      showToast('工单创建失败', 'error');
      appendSystemAnnouncement([
        '## 工单通知',
        `任务：${task.scriptName}`,
        `状态：${statusLabel[task.status]}`,
        `来源编号：${sourceNo}`,
        `结果：创建失败`,
        `原因：${message}`,
      ].join('\n'));
    }
  }, [appendSystemAnnouncement, operatorProfile.name, operatorProfile.organization, operatorProfile.phone, showToast]);

  return (
    <div className="overview-workspace">
      <section className="overview-hero">
        <div>
          <div className="overview-kicker">Overview</div>
          <h1>运行态势总览</h1>
          <p className="overview-subtitle">一眼看清当前任务状态、最近变化和需要关注的对象。</p>
        </div>
        <div className="overview-status-strip">
          <OverviewStatCard icon={<Activity size={16} />} label="运行中" value={String(counts.running)} tone="neutral" />
          <OverviewStatCard icon={<CheckCircle2 size={16} />} label="正常" value={String(counts.healthy)} tone="healthy" />
          <OverviewStatCard icon={<ShieldAlert size={16} />} label="需关注" value={String(counts.attention)} tone="attention" />
          <OverviewStatCard icon={<AlertTriangle size={16} />} label="异常" value={String(counts.alert)} tone="alert" />
        </div>
      </section>

      <div className="overview-shell">
        <div className="overview-primary-column">
          <section className="overview-panel overview-health-panel">
            <div className="overview-panel-header">
              <div>
                <span className="overview-panel-kicker">全局状态</span>
                <h2>健康摘要</h2>
              </div>
            </div>
            <div className="overview-health-summary">
              <div className="overview-health-summary-main">
                <div className="overview-health-summary-head">
                  <span className="overview-health-summary-icon">
                    <CheckCircle2 size={18} />
                  </span>
                  <div>
                    <strong>{activeAlerts.length === 0 ? '整体运行状态平稳' : '当前存在需要关注的监控项'}</strong>
                    <p>
                      {activeAlerts.length === 0
                        ? '当前没有活跃告警，运行中的任务整体稳定。'
                        : `当前有 ${activeAlerts.length} 个活跃告警，优先关注高风险任务与最近异常事件。`}
                    </p>
                  </div>
                </div>
              </div>
              <div className="overview-health-summary-grid">
                <OverviewSummaryTile label="受监控目标" value={String(monitoredTargetCount)} icon={<Crosshair size={16} />} />
                <OverviewSummaryTile
                  label="最近更新"
                  value={latestUpdatedAt ? formatEventTime(latestUpdatedAt) : '暂无'}
                  compact
                  icon={<Clock3 size={16} />}
                />
                <OverviewSummaryTile
                  label="近 10 分钟告警"
                  value={String(recentWindowSummary.alerts)}
                  compact
                  icon={<ShieldAlert size={16} />}
                />
                <OverviewSummaryTile
                  label="近 10 分钟恢复"
                  value={String(recentWindowSummary.recoveries)}
                  compact
                  icon={<CirclePlay size={16} />}
                />
              </div>
              <div className="overview-health-footnote">
                {recentWindowSummary.quietMinutes === null
                  ? '近 10 分钟未采集到异常事件。'
                  : `最近异常出现在 ${recentWindowSummary.quietMinutes} 分钟前。`}
              </div>
            </div>
          </section>

          <section className="overview-panel overview-primary-alerts">
            <div className="overview-panel-header">
              <div>
                <span className="overview-panel-kicker">活跃告警</span>
                <h2>当前告警与需关注</h2>
              </div>
            </div>
            {activeAlerts.length === 0 ? (
              <div className="overview-empty overview-quiet-empty">当前没有活跃告警，系统处于稳定状态。</div>
            ) : (
              <div className="overview-alert-list">
                {activeAlerts.map((task) => (
                  <div
                    key={task.id}
                    className={`overview-alert-card ${task.status}`}
                    onClick={() => focusScript(task.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        focusScript(task.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    title="查看任务详情"
                  >
                    <div className="overview-alert-card-top">
                      <div className="overview-alert-title">
                        <span className="overview-alert-dot" aria-hidden="true" />
                        <strong>{task.scriptName}</strong>
                      </div>
                      <span className={`overview-status-pill ${task.status}`}>{statusLabel[task.status]}</span>
                    </div>
                    <p className="overview-task-target">{task.targetSummary}</p>
                    <small>{task.warningText || task.latestEventText}</small>
                    <div className="overview-alert-actions">
                      <button
                        className="overview-inline-btn"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void createTicketForTask(task);
                        }}
                        disabled={ticketStateByTask[task.id]?.loading}
                      >
                        <FilePlus2 size={14} />
                        <span>{ticketStateByTask[task.id]?.loading ? '生成中' : '生成工单'}</span>
                      </button>
                      {ticketStateByTask[task.id]?.ticketId ? (
                        <span className="overview-ticket-meta">工单ID {ticketStateByTask[task.id]?.ticketId}</span>
                      ) : null}
                    </div>
                    {ticketStateByTask[task.id]?.error ? (
                      <div className="overview-ticket-error">{ticketStateByTask[task.id]?.error}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="overview-panel overview-events">
          <div className="overview-panel-header">
            <div>
              <span className="overview-panel-kicker">最近动态</span>
              <h2>最近事件流</h2>
            </div>
          </div>
          {recentEvents.length === 0 ? (
            <div className="overview-empty">最近还没有采集到可展示的任务事件。</div>
          ) : (
            <div className="overview-event-feed">
              {recentEvents.map((event) => (
                <div key={event.id} className={`overview-event-item ${event.level}`}>
                  <div className="overview-event-dot" />
                  <div className="overview-event-copy">
                    <div className="overview-event-head">
                      <strong>{event.title}</strong>
                      <span>{event.timeLabel}</span>
                    </div>
                    <p>{event.detail}</p>
                    {event.repeatCount && event.repeatCount > 1 ? (
                      <small>10 分钟内折叠 {event.repeatCount} 条重复事件</small>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="overview-panel overview-task-list">
          <div className="overview-panel-header">
            <div>
              <span className="overview-panel-kicker">监控项</span>
              <h2>任务与目标状态</h2>
            </div>
            <div className="overview-filter-row">
              {[
                { id: 'all', label: '全部' },
                { id: 'healthy', label: '正常' },
                { id: 'attention', label: '需关注' },
                { id: 'alert', label: '异常' },
              ].map((item) => (
                <button
                  key={item.id}
                  className={`overview-filter-btn ${filter === item.id ? 'active' : ''}`}
                  onClick={() => setFilter(item.id as OverviewFilter)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {filteredTasks.length === 0 ? (
            <div className="overview-empty">当前筛选条件下没有匹配的任务。</div>
          ) : (
            <div className="overview-task-list-grid">
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  className={`overview-task-card ${task.status}`}
                  onClick={() => focusScript(task.id)}
                  title="跳转到任务工作台"
                >
                  <div className="overview-task-card-head">
                    <div>
                      <strong>{task.scriptName}</strong>
                      <span className="overview-task-target">{task.targetSummary}</span>
                    </div>
                    <span className={`overview-status-pill ${task.status}`}>{statusLabel[task.status]}</span>
                  </div>
                  <p>{task.summary}</p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const OverviewStatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'neutral' | 'healthy' | 'attention' | 'alert';
  note?: string;
}> = ({ icon, label, value, tone, note }) => (
  <div className={`overview-stat-card ${tone}`}>
    <span className="overview-stat-icon">{icon}</span>
    <div>
      <em>{label}</em>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  </div>
);

const OverviewSummaryTile: React.FC<{ label: string; value: string; compact?: boolean; icon?: React.ReactNode }> = ({
  label,
  value,
  compact = false,
  icon,
}) => (
  <div className={`overview-summary-tile${compact ? ' compact' : ''}`}>
    {icon ? <span className="overview-summary-tile-icon" aria-hidden="true">{icon}</span> : null}
    <div className="overview-summary-tile-copy">
      <div className="overview-summary-tile-head">
        <span className="overview-summary-tile-label">{label}</span>
      </div>
      <strong className="overview-summary-tile-value">{value}</strong>
    </div>
  </div>
);

function matchesFilter(task: DerivedTask, filter: OverviewFilter) {
  if (filter === 'all') return true;
  if (filter === 'healthy') return task.status === 'running' || task.status === 'recovered';
  if (filter === 'attention') return task.status === 'attention';
  return task.status === 'warning' || task.status === 'error';
}

function statusWeight(status: DerivedStatus) {
  switch (status) {
    case 'error':
      return 4;
    case 'warning':
      return 3;
    case 'attention':
      return 2;
    case 'recovered':
      return 1;
    default:
      return 0;
  }
}

function summarizeTask(task: ServerDefinition): DerivedTask {
  const recentLogs = task.capabilities?.recentLogs || [];
  const events = recentLogs
    .map(parseManagedTaskLog)
    .filter((item): item is ParsedTaskEvent => Boolean(item));

  const latestEvent = events[events.length - 1] || null;
  const latestWarning = [...events].reverse().find((event) => event.level === 'warning' || event.level === 'attention' || event.level === 'error') || null;
  const latestRecovered = [...events].reverse().find((event) => event.level === 'recovered') || null;
  const recentAlertCount = events.filter((event) => event.level === 'warning' || event.level === 'attention' || event.level === 'error').length;
  const recentRecoveredCount = events.filter((event) => event.level === 'recovered').length;
  const uniqueTargets = Array.from(
    new Set(
      events
        .map((event) => event.target)
        .filter(Boolean)
    )
  );
  const targetSummary = latestWarning?.target || latestEvent?.target || task.id || summarizeTargets(uniqueTargets);
  const ticketTargetKey = latestWarning?.primaryOfflineDeviceId || latestWarning?.target || latestEvent?.primaryOfflineDeviceId || latestEvent?.target || task.id;

  return {
    id: task.id,
    scriptName: task.entry.split('/').pop() || task.id,
    status: task.status,
    summary: latestWarning
      ? `${latestWarning.message}${latestWarning.detail ? ` · ${latestWarning.detail}` : ''}`
      : latestRecovered
        ? `${latestRecovered.message}${latestRecovered.detail ? ` · ${latestRecovered.detail}` : ''}`
        : latestEvent?.message || '最近暂无事件',
    target: latestEvent?.target || latestWarning?.target || '',
    targetSummary,
    ticketTargetKey,
    latestEventText: latestEvent ? `${latestEvent.message}${latestEvent.detail ? ` · ${latestEvent.detail}` : ''}` : '',
    latestEventAt: latestEvent?.timestamp || null,
    warningText: latestWarning ? `${latestWarning.message}${latestWarning.detail ? ` · ${latestWarning.detail}` : ''}` : '',
    recoveredText: latestRecovered ? `${latestRecovered.message}${latestRecovered.detail ? ` · ${latestRecovered.detail}` : ''}` : '',
    recentLogs,
    latestEventLevel: latestEvent?.level || null,
    recentAlertCount,
    recentRecoveredCount,
    latestAlertMessage: latestWarning?.message || latestEvent?.message || task.description || task.id,
    latestAlertDetail: latestWarning?.detail || latestEvent?.detail || '',
    latestAlertTime: latestWarning?.timestamp
      ? formatTicketDateTime(latestWarning.timestamp)
      : latestEvent?.timestamp
        ? formatTicketDateTime(latestEvent.timestamp)
        : null,
  };
}

function parseToolJson(response: Awaited<ReturnType<typeof callServerTool>>) {
  const text = response.content?.map((item) => item.text || '').join('\n').trim() || '';
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeMissingValue(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('待补充')) {
    return fallback.trim();
  }
  return trimmed;
}

function parseManagedTaskLog(line: string) {
  try {
    const parsed = JSON.parse(line) as {
      time?: string;
      level?: string;
      status?: string;
      message?: string;
      details?: string[];
      total?: number;
      healthy?: number;
      abnormal?: number;
      unknown?: number;
      offline?: Array<{
        deviceId?: string;
        status?: string;
        failCount?: number;
        message?: string;
      }>;
      target?: { host?: string; port?: number; process?: string | null };
    };

    const structuredTarget = parsed.target
      ? parsed.target.host && parsed.target.port
        ? `${parsed.target.host}:${parsed.target.port}`
        : parsed.target.process
          ? `进程 ${parsed.target.process}`
          : parsed.target.host || ''
      : '';

    const offlineDetail = Array.isArray(parsed.offline)
      ? parsed.offline
        .map((item) => {
          const parts = [
            item?.deviceId ? `设备 ${item.deviceId}` : '',
            item?.status ? `状态 ${item.status}` : '',
            typeof item?.failCount === 'number' ? `连续失败 ${item.failCount} 次` : '',
            item?.message || '',
          ].filter(Boolean);
          return parts.join('，');
        })
        .filter(Boolean)
        .join('；')
      : '';
    const primaryOfflineDeviceId = Array.isArray(parsed.offline)
      ? String(parsed.offline.find((item) => item?.deviceId)?.deviceId || '').trim()
      : '';
    const summaryDetail = typeof parsed.total === 'number'
      ? [
        `总数 ${parsed.total}`,
        typeof parsed.healthy === 'number' ? `健康 ${parsed.healthy}` : '',
        typeof parsed.abnormal === 'number' ? `异常 ${parsed.abnormal}` : '',
        typeof parsed.unknown === 'number' ? `未知 ${parsed.unknown}` : '',
      ].filter(Boolean).join('，')
      : '';
    const rawDetail = [
      Array.isArray(parsed.details) ? parsed.details.filter(Boolean).join('；') : '',
      summaryDetail,
      offlineDetail,
    ].filter(Boolean).join('；');
    const fallbackTarget = extractTargetFromText([parsed.message || '', rawDetail].join(' '));
    const target = structuredTarget || fallbackTarget;
    const normalized = normalizeOpsEvent(parsed.message || '托管任务事件', rawDetail, target);
    const normalizedLevel = (parsed.level || parsed.status || 'running') as DerivedStatus;

    return {
      timestamp: parsed.time ? Date.parse(parsed.time) : Date.now(),
      timeLabel: parsed.time ? new Date(parsed.time).toLocaleString('zh-CN', { hour12: false }) : '未知时间',
      level: normalizedLevel,
      message: normalized.message,
      detail: normalized.detail,
      target,
      primaryOfflineDeviceId,
      signature: `${normalizedLevel}|${normalized.message}|${target || 'none'}|${normalized.detail || 'none'}`,
    };
  } catch {
    return null;
  }
}

function buildOverviewEvents(tasks: DerivedTask[], announcementMessages: Array<{ id: string; content: string; timestamp: number }>): OverviewEvent[] {
  const taskEvents: OverviewEvent[] = tasks
    .flatMap((task) =>
      task.recentLogs
        .map(parseManagedTaskLog)
        .filter((item): item is ParsedTaskEvent => Boolean(item))
        .map((event, index) => ({
          id: `${task.id}-${event.timestamp}-${index}`,
          sourceId: task.id,
          title: `${task.scriptName} · ${event.message}`,
          detail: [event.target || task.targetSummary, event.detail].filter(Boolean).join(' · ') || '无附加详情',
          timeLabel: event.timeLabel,
          timestamp: event.timestamp,
          level: (event.level === 'warning' || event.level === 'error'
            ? 'alert'
            : event.level === 'attention'
              ? 'attention'
              : event.level === 'recovered' || event.level === 'running'
                ? 'healthy'
                : 'neutral') as OverviewEvent['level'],
          signature: `${task.id}|${event.signature}`,
        }))
    )
    .sort((a, b) => b.timestamp - a.timestamp);

  const announcementEvents: OverviewEvent[] = announcementMessages
    .slice(-5)
    .map((message) => ({
      id: `announcement-${message.id}`,
      sourceId: SYSTEM_ANNOUNCEMENTS_ID,
      title: '系统通告',
      detail: message.content.replace(/^##\s+/m, '').split('\n').slice(0, 3).join(' · '),
      timeLabel: new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false }),
      timestamp: message.timestamp,
      level: (message.content.includes('恢复')
        ? 'healthy'
        : message.content.includes('告警') || message.content.includes('异常')
          ? 'alert'
          : 'neutral') as OverviewEvent['level'],
      signature: `announcement|${message.content.slice(0, 160)}`,
    }));

  return compressOverviewEvents(
    [...taskEvents, ...announcementEvents]
    .sort((a, b) => b.timestamp - a.timestamp)
  ).slice(0, 5);
}

function compressOverviewEvents(events: OverviewEvent[]) {
  const compressed: OverviewEvent[] = [];
  for (const event of events) {
    const existing = compressed.find(
      (candidate) =>
        candidate.signature === event.signature &&
        Math.abs(candidate.timestamp - event.timestamp) <= 10 * 60_000
    );

    if (existing) {
      existing.repeatCount = (existing.repeatCount || 1) + 1;
      continue;
    }

    compressed.push({ ...event, repeatCount: 1 });
  }
  return compressed;
}

function summarizeTargets(targets: string[]) {
  if (targets.length === 0) return '目标未标注';
  if (targets.length === 1) return targets[0];
  return `${targets.length} 个监控目标`;
}

function extractTargetFromText(text: string) {
  const hostPortMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/);
  if (hostPortMatch) return hostPortMatch[0];
  const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipMatch) return ipMatch[0];
  const processMatch = text.match(/进程\s+([A-Za-z0-9._-]+)/);
  if (processMatch) return `进程 ${processMatch[1]}`;
  return '';
}

function normalizeOpsEvent(message: string, detail: string, target: string) {
  const lowered = `${message} ${detail}`.toLowerCase();
  const conciseTarget = target || extractTargetFromText(detail || message);

  if (lowered.includes('all targets reachable')) {
    return {
      message: '全部目标正常',
      detail: detail || '所有监控目标均可达',
    };
  }

  if (lowered.includes('ping failed') || lowered.includes('network is unreachable') || lowered.includes('host unreachable')) {
    return {
      message: '网络不可达',
      detail: conciseTarget || detail || message,
    };
  }

  if (lowered.includes('connection refused')) {
    return {
      message: '连接被拒绝',
      detail: conciseTarget || detail || message,
    };
  }

  if (lowered.includes('tcp connect failed') || lowered.includes('timed out') || lowered.includes('timeout')) {
    return {
      message: '端口无响应',
      detail: conciseTarget || detail || message,
    };
  }

  if (lowered.includes('recovered')) {
    return {
      message: '服务已恢复',
      detail: conciseTarget || detail || '',
    };
  }

  return {
    message,
    detail,
  };
}

function formatEventTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTicketDateTime(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default OverviewWorkspace;
