import React from 'react';
import { Clock, Play, Pencil, Trash2, X, ChevronDown, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { deleteSchedule, getScheduleHistory, listSchedules, triggerSchedule } from '../../services/runtime';
import type { ScheduleExecutionHistory, ScheduleRecord } from '../../services/contracts';
import ScheduleEditorModal from './ScheduleEditorModal';

// cron → 人类可读
const cronToHuman = (cron: string): string => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (min === '*' && hour === '*' && dom === '*') return '每分钟';
  const everyN = min.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*' && dom === '*') return `每隔 ${everyN[1]} 分钟`;
  if (/^\d+$/.test(min) && hour === '*') return `每小时第 ${min} 分`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && dow === '*')
    return `每天 ${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
  const W = ['日','一','二','三','四','五','六'];
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && /^\d+$/.test(dow))
    return `每周${W[Number(dow)]} ${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom))
    return `每月 ${dom} 号 ${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
  return cron;
};

const STEP_TYPE_ICONS: Record<string, string> = {
  'instant-script': '🔧',
  'mcp-tool': '🌐',
  'skill-package': '📦',
  'http-request': '📡',
  'delay': '⏳',
  'condition': '🔀',
};

const ScheduleList: React.FC = () => {
  const [schedules, setSchedules] = React.useState<ScheduleRecord[]>([]);
  const [status, setStatus] = React.useState('');
  const [actionPending, setActionPending] = React.useState<string | null>(null);
  const [historyId, setHistoryId] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<ScheduleExecutionHistory[]>([]);
  const [expandedHistory, setExpandedHistory] = React.useState<Set<number>>(() => new Set());
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingSchedule, setEditingSchedule] = React.useState<ScheduleRecord | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const list = await listSchedules();
      setSchedules(list);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadHistory = React.useCallback(async (id: string) => {
    try {
      const h = await getScheduleHistory(id);
      setHistory(h);
      setHistoryId(id);
    } catch {
      setHistory([]);
    }
  }, []);

  const historyIdRef = React.useRef(historyId);
  historyIdRef.current = historyId;

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
      const current = historyIdRef.current;
      if (current) void loadHistory(current);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refresh, loadHistory]);

  const handleTrigger = async (id: string) => {
    setActionPending(id);
    try {
      await triggerSchedule(id);
      await refresh();
      await loadHistory(id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('确定删除这个定时任务吗？')) return;
    setActionPending(id);
    try {
      await deleteSchedule(id);
      if (historyId === id) { setHistoryId(null); setHistory([]); }
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  };

  const formatNextRun = (nextRunAt?: string) => {
    if (!nextRunAt) return '—';
    try {
      const d = new Date(nextRunAt);
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return nextRunAt;
    }
  };

  const historyDot = (h: ScheduleExecutionHistory, index: number) => {
    const color = h.status === 'success' ? 'var(--accent)' : h.status === 'failure' ? 'var(--danger)' : '#f59e0b';
    return (
      <span
        key={index}
        className="schedule-history-dot"
        style={{ background: color }}
        title={`${h.triggeredAt}: ${h.status}`}
      />
    );
  };

  return (
    <>
      <div className="schedule-list-header">
        <div>
          <h2>定时任务</h2>
          <p>{schedules.length} 个任务</p>
        </div>
        <div className="schedule-list-header-actions">
          <button className="toolbar-text-btn" onClick={() => void refresh()} title="刷新">
            <RefreshCw size={14} />
            <span>刷新</span>
          </button>
          <button
            className="btn btn-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={() => { setEditingSchedule(null); setEditorOpen(true); }}
          >
            <Clock size={13} /> 新建定时任务
          </button>
        </div>
      </div>

      {status && <div className="scripts-upload-error">{status}</div>}

      {schedules.length === 0 ? (
        <div className="overview-empty">暂无定时任务，点击右上角按钮新建。</div>
      ) : (
        <div className={`schedule-grid${historyId ? ' has-history' : ''}`}>
          <div className="schedule-cards">
            {schedules.map((s) => (
              <div
                key={s.id}
                className={`schedule-card${historyId === s.id ? ' active' : ''}`}
              >
                <div className="schedule-card-main">
                  <div className="schedule-card-head">
                    <span className={`schedule-enabled-badge ${s.enabled ? 'on' : 'off'}`}>                      
                      {s.enabled ? '启用中' : '已停用'}
                    </span>
                    <span className="schedule-step-count">{s.steps.length} 步</span>
                  </div>
                  <div className="schedule-card-name">{s.name}</div>
                  <div className="schedule-card-meta">
                    <span className="schedule-card-cron">{cronToHuman(s.schedule)}</span>
                    <span className="schedule-card-next">下次: {formatNextRun(s.nextRunAt)}</span>
                  </div>
                  {s.steps.length > 0 && (
                    <div className="schedule-card-steps">
                      {s.steps.slice(0, 4).map((step, i) => (
                        <span key={step.id || i} className="schedule-step-chip" title={step.toolName || step.serverId || step.type}>
                          {STEP_TYPE_ICONS[step.type] || '⚡'} {step.type}
                        </span>
                      ))}
                      {s.steps.length > 4 && <span className="schedule-step-chip">+{s.steps.length - 4}</span>}
                    </div>
                  )}
                </div>
                <div className="schedule-card-actions">
                  <div className="schedule-card-history-row">
                    {(s as any)._recentHistory?.slice(0, 5).map((h: ScheduleExecutionHistory, i: number) => historyDot(h, i))
                      || null}
                  </div>
                  <div className="schedule-card-btns">
                    <button
                      className="toolbar-text-btn"
                      onClick={() => { void handleTrigger(s.id); }}
                      disabled={actionPending === s.id}
                      title="立即执行"
                    >
                      <Play size={13} />
                    </button>
                    <button
                      className="toolbar-text-btn"
                      onClick={() => { setEditingSchedule(s); setEditorOpen(true); }}
                      title="编辑"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="toolbar-text-btn"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => { void handleDelete(s.id); }}
                      disabled={actionPending === s.id}
                      title="删除"
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      className={`toolbar-text-btn${historyId === s.id ? ' active' : ''}`}
                      onClick={() => {
                        if (historyId === s.id) { setHistoryId(null); setHistory([]); return; }
                        void loadHistory(s.id);
                      }}
                      title="执行历史"
                    >
                      <Clock size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {historyId && (
            <div className="schedule-history-drawer">
              <div className="scripts-detail-drawer-head">
                <button type="button" className="scripts-detail-close" onClick={() => { setHistoryId(null); setHistory([]); }}>
                  <X size={16} />
                </button>
              </div>
              <div className="schedule-history-title">执行历史</div>
              {history.length === 0 ? (
                <div className="overview-empty">暂无执行记录</div>
              ) : (
                <div className="schedule-history-list">
                  {history.map((h, index) => (
                    <div key={index} className={`schedule-history-entry ${h.status}`}>
                      <button
                        className="schedule-history-entry-head"
                        onClick={() => {
                          const next = new Set(expandedHistory);
                          if (next.has(index)) next.delete(index); else next.add(index);
                          setExpandedHistory(next);
                        }}
                      >
                        <span className="schedule-history-status-icon">
                          {h.status === 'success' ? <Check size={13} /> : h.status === 'failure' ? <AlertTriangle size={13} /> : <Clock size={13} />}
                        </span>
                        <span className="schedule-history-time">
                          {new Date(h.triggeredAt).toLocaleString('zh-CN')}
                        </span>
                        <span className="schedule-history-elapsed">{h.elapsedMs}ms</span>
                        <ChevronDown size={13} className={`schedule-history-chevron${expandedHistory.has(index) ? ' open' : ''}`} />
                      </button>
                      {expandedHistory.has(index) && (
                        <div className="schedule-history-detail">
                          {h.steps.map((step, si) => (
                            <div key={si} className={`schedule-history-step ${step.ok ? 'ok' : 'fail'}`}>
                              <span className="schedule-history-step-id">{step.stepId}</span>
                              <span className="schedule-history-step-ok">{step.ok ? '✅' : '❌'}</span>
                              <span className="schedule-history-step-elapsed">{step.elapsedMs}ms</span>
                              {step.error && <span className="schedule-history-step-error">{step.error}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {editorOpen && (
        <ScheduleEditorModal
          schedule={editingSchedule}
          onClose={() => { setEditorOpen(false); setEditingSchedule(null); }}
          onSaved={() => { setEditorOpen(false); setEditingSchedule(null); void refresh(); }}
        />
      )}
    </>
  );
};

export default ScheduleList;
