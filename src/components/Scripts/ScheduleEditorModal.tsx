import React from 'react';
import { X, Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../stores';
import { createSchedule, updateSchedule } from '../../services/runtime';
import type { ScheduleRecord, ScheduleStep } from '../../services/contracts';

// ── 直观调度选择器（内部转 cron，用户不感知） ──

type FreqType = 'every-minute' | 'every-n-minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

const FREQ_LABELS: Record<FreqType, string> = {
  'every-minute': '每分钟',
  'every-n-minutes': '每隔 N 分钟',
  'hourly': '每小时',
  'daily': '每天',
  'weekly': '每周',
  'monthly': '每月',
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 从 cron 表达式反推频率类型（编辑已有任务时用）
const parseSchedule = (cronExpr: string): {
  freqType: FreqType;
  everyNMinutes: number;
  hourlyMinute: number;
  dailyHour: number;
  dailyMinute: number;
  weeklyDay: number;
  weeklyHour: number;
  weeklyMinute: number;
  monthlyDay: number;
  monthlyHour: number;
  monthlyMinute: number;
} => {
  const parts = cronExpr.trim().split(/\s+/);
  const defaults = {
    freqType: 'daily' as FreqType,
    everyNMinutes: 5,
    hourlyMinute: 0,
    dailyHour: 9,
    dailyMinute: 0,
    weeklyDay: 1,
    weeklyHour: 9,
    weeklyMinute: 0,
    monthlyDay: 1,
    monthlyHour: 9,
    monthlyMinute: 0,
  };

  if (parts.length !== 5) return defaults;

  const [min, hour, dom, , dow] = parts;

  // 每分钟
  if (min === '*' && hour === '*' && dom === '*' && dow === '*') {
    return { ...defaults, freqType: 'every-minute' };
  }

  // 每隔 N 分钟
  const everyNMatch = min.match(/^\*\/(\d+)$/);
  if (everyNMatch && hour === '*' && dom === '*' && dow === '*') {
    return { ...defaults, freqType: 'every-n-minutes', everyNMinutes: Number(everyNMatch[1]) };
  }

  // 每小时
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && dow === '*') {
    return { ...defaults, freqType: 'hourly', hourlyMinute: Number(min) };
  }

  // 每天
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && dow === '*') {
    return { ...defaults, freqType: 'daily', dailyHour: Number(hour), dailyMinute: Number(min) };
  }

  // 每周
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && /^\d+$/.test(dow)) {
    return {
      ...defaults,
      freqType: 'weekly',
      weeklyDay: Number(dow),
      weeklyHour: Number(hour),
      weeklyMinute: Number(min),
    };
  }

  // 每月
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && dow === '*') {
    return {
      ...defaults,
      freqType: 'monthly',
      monthlyDay: Number(dom),
      monthlyHour: Number(hour),
      monthlyMinute: Number(min),
    };
  }

  return defaults;
};

const toCron = (state: ScheduleFormState): string => {
  switch (state.freqType) {
    case 'every-minute':
      return '* * * * *';
    case 'every-n-minutes':
      return `*/${state.everyNMinutes} * * * *`;
    case 'hourly':
      return `${state.hourlyMinute} * * * *`;
    case 'daily':
      return `${state.dailyMinute} ${state.dailyHour} * * *`;
    case 'weekly':
      return `${state.weeklyMinute} ${state.weeklyHour} * * ${state.weeklyDay}`;
    case 'monthly':
      return `${state.monthlyMinute} ${state.monthlyHour} ${state.monthlyDay} * *`;
    default:
      return '0 9 * * *';
  }
};

const toHumanText = (state: ScheduleFormState): string => {
  switch (state.freqType) {
    case 'every-minute':
      return '每分钟执行一次';
    case 'every-n-minutes':
      return `每隔 ${state.everyNMinutes} 分钟执行一次`;
    case 'hourly':
      return `每小时的第 ${state.hourlyMinute} 分执行`;
    case 'daily':
      return `每天 ${String(state.dailyHour).padStart(2, '0')}:${String(state.dailyMinute).padStart(2, '0')} 执行`;
    case 'weekly':
      return `每${WEEKDAYS[state.weeklyDay] ? '周' + WEEKDAYS[state.weeklyDay] : '周'} ${String(state.weeklyHour).padStart(2, '0')}:${String(state.weeklyMinute).padStart(2, '0')} 执行`;
    case 'monthly':
      return `每月 ${state.monthlyDay} 号 ${String(state.monthlyHour).padStart(2, '0')}:${String(state.monthlyMinute).padStart(2, '0')} 执行`;
    default:
      return '未知';
  }
};

interface ScheduleFormState {
  freqType: FreqType;
  everyNMinutes: number;
  hourlyMinute: number;
  dailyHour: number;
  dailyMinute: number;
  weeklyDay: number;
  weeklyHour: number;
  weeklyMinute: number;
  monthlyDay: number;
  monthlyHour: number;
  monthlyMinute: number;
}

const STEP_TYPE_OPTIONS = [
  { value: 'instant-script', label: '即时脚本', icon: '🔧' },
  { value: 'mcp-tool', label: 'MCP 工具', icon: '🌐' },
  { value: 'skill-package', label: 'Skill 包', icon: '📦' },
  { value: 'http-request', label: 'HTTP 请求', icon: '📡' },
  { value: 'delay', label: '等待延迟', icon: '⏳' },
  { value: 'condition', label: '条件分支', icon: '🔀' },
] as const;

const newStepId = () => `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const defaultStep = (): ScheduleStep => ({
  id: newStepId(),
  type: 'instant-script',
  args: {},
  timeoutMs: 30000,
  onFailure: 'stop',
});

interface Props {
  schedule: ScheduleRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

const ScheduleEditorModal: React.FC<Props> = ({ schedule, onClose, onSaved }) => {
  const servers = useAppStore(s => s.servers);
  const skillPackages = useAppStore(s => s.skillPackages);
  const instantServers = servers.filter(s => s.category === 'instant' && s.type === 'python-script');
  const enabledSkillPkgs = skillPackages.filter(p => p.enabled !== false && p.kind === 'executable');

  const isEdit = !!schedule;
  const initial = schedule?.schedule
    ? parseSchedule(schedule.schedule)
    : { freqType: 'daily' as FreqType, everyNMinutes: 5, hourlyMinute: 0, dailyHour: 9, dailyMinute: 0, weeklyDay: 1, weeklyHour: 9, weeklyMinute: 0, monthlyDay: 1, monthlyHour: 9, monthlyMinute: 0 };

  const [name, setName] = React.useState(schedule?.name || '');
  const [freqType, setFreqType] = React.useState<FreqType>(initial.freqType);
  const [everyNMinutes, setEveryNMinutes] = React.useState(initial.everyNMinutes);
  const [hourlyMinute, setHourlyMinute] = React.useState(initial.hourlyMinute);
  const [dailyHour, setDailyHour] = React.useState(initial.dailyHour);
  const [dailyMinute, setDailyMinute] = React.useState(initial.dailyMinute);
  const [weeklyDay, setWeeklyDay] = React.useState(initial.weeklyDay);
  const [weeklyHour, setWeeklyHour] = React.useState(initial.weeklyHour);
  const [weeklyMinute, setWeeklyMinute] = React.useState(initial.weeklyMinute);
  const [monthlyDay, setMonthlyDay] = React.useState(initial.monthlyDay);
  const [monthlyHour, setMonthlyHour] = React.useState(initial.monthlyHour);
  const [monthlyMinute, setMonthlyMinute] = React.useState(initial.monthlyMinute);
  const [enabled, setEnabled] = React.useState(schedule?.enabled !== false);
  const [steps, setSteps] = React.useState<ScheduleStep[]>(
    schedule?.steps?.length ? schedule.steps.map(s => ({ ...s })) : [defaultStep()],
  );
  const [retryCount, setRetryCount] = React.useState(schedule?.errorHandling?.retryCount ?? 2);
  const [retryBackoff, setRetryBackoff] = React.useState(schedule?.errorHandling?.retryBackoffMs ?? 5000);
  const [notifyOnFailure, setNotifyOnFailure] = React.useState(schedule?.errorHandling?.notifyOnFailure ?? true);
  const [expandedSteps, setExpandedSteps] = React.useState<Set<string>>(() => new Set());
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const toggleStepExpand = (stepId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
  };

  const formState: ScheduleFormState = { freqType, everyNMinutes, hourlyMinute, dailyHour, dailyMinute, weeklyDay, weeklyHour, weeklyMinute, monthlyDay, monthlyHour, monthlyMinute };

  const updateStep = (index: number, updater: (step: ScheduleStep) => ScheduleStep) => {
    setSteps(current => current.map((s, i) => i === index ? updater(s) : s));
  };

  const removeStep = (index: number) => {
    setSteps(current => current.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    setSteps(current => {
      const next = [...current];
      const target = index + dir;
      if (target < 0 || target >= next.length) return next;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addStep = () => {
    setSteps(current => [...current, defaultStep()]);
  };

  const handleSave = async () => {
    if (!name.trim()) { setError('名称不能为空'); return; }

    setSaving(true);
    setError('');
    try {
      const data = {
        name: name.trim(),
        enabled,
        schedule: toCron(formState),
        timezone: 'Asia/Shanghai',
        steps,
        errorHandling: { retryCount, retryBackoffMs: retryBackoff, notifyOnFailure },
      };
      if (isEdit && schedule) {
        await updateSchedule(schedule.id, data);
      } else {
        await createSchedule(data as any);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const renderStepForm = (step: ScheduleStep, index: number) => {
    const isExpanded = expandedSteps.has(step.id);
    return (
      <div className={`schedule-step-card${isExpanded ? ' expanded' : ''}`} key={step.id}>
        <button
          className="schedule-step-card-head"
          type="button"
          onClick={() => toggleStepExpand(step.id)}
        >
          <span className="schedule-step-chevron">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="schedule-step-index">Step {index + 1}</span>
          <span className="schedule-step-summary">
            {STEP_TYPE_OPTIONS.find(o => o.value === step.type)?.icon} {STEP_TYPE_OPTIONS.find(o => o.value === step.type)?.label}
            {step.type === 'instant-script' && step.serverId && (
              <span className="schedule-step-detail"> · {instantServers.find(s => s.id === step.serverId)?.name || step.serverId}</span>
            )}
            {step.type === 'mcp-tool' && step.serverName && (
              <span className="schedule-step-detail"> · {step.serverName}/{step.toolName}</span>
            )}
            {step.type === 'skill-package' && step.skillPackageId && (
              <span className="schedule-step-detail"> · {step.skillPackageId}</span>
            )}
            {step.type === 'http-request' && step.url && (
              <span className="schedule-step-detail"> · {step.url}</span>
            )}
            {step.type === 'delay' && (
              <span className="schedule-step-detail"> · {step.ms}ms</span>
            )}
            {step.type === 'condition' && step.condition && (
              <span className="schedule-step-detail"> · {step.condition.slice(0, 40)}{step.condition.length > 40 ? '…' : ''}</span>
            )}
          </span>
          <div className="schedule-step-actions" onClick={e => e.stopPropagation()}>
            <button className="btn-icon" onClick={() => moveStep(index, -1)} disabled={index === 0} title="上移">
              <ChevronUp size={14} />
            </button>
            <button className="btn-icon" onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} title="下移">
              <ChevronDown size={14} />
            </button>
            <button className="btn-icon" style={{ color: 'var(--danger)' }} onClick={() => removeStep(index)} title="删除">
              <Trash2 size={14} />
            </button>
          </div>
        </button>

        {isExpanded && (
        <div className="schedule-step-body">
          <div className="schedule-step-fields">
            <label className="label">任务类型</label>
            <select
              className="input"
              value={step.type}
              onChange={e => updateStep(index, s => ({ ...s, type: e.target.value as ScheduleStep['type'], serverId: '', serverName: '', skillPackageId: '', toolName: '', url: '', ms: undefined, condition: '', args: {} }))}
            >
              {STEP_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.icon} {opt.label}</option>
              ))}
            </select>
          </div>
          {step.type === 'instant-script' && (
            <div className="schedule-step-fields">
              <label className="label">选择脚本</label>
              <select
                className="input"
                value={step.serverId || ''}
                onChange={e => {
                  if (!e.target.value) return;
                  const srv = instantServers.find(s => s.id === e.target.value);
                  updateStep(index, s => ({
                    ...s,
                    serverId: e.target.value,
                    toolName: (srv?.capabilities?.tools?.[0]?.name) || 'run',
                  }));
                }}
              >
                <option value="">— 选择即时脚本 —</option>
                {instantServers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {step.type === 'mcp-tool' && (
            <>
              <div className="schedule-step-fields">
                <label className="label">MCP 服务器</label>
                <input
                  className="input"
                  value={step.serverName || ''}
                  onChange={e => updateStep(index, s => ({ ...s, serverName: e.target.value }))}
                  placeholder="例如 fetch"
                />
              </div>
              <div className="schedule-step-fields">
                <label className="label">工具名称</label>
                <input
                  className="input"
                  value={step.toolName || ''}
                  onChange={e => updateStep(index, s => ({ ...s, toolName: e.target.value }))}
                  placeholder="例如 fetch"
                />
              </div>
            </>
          )}

          {step.type === 'skill-package' && (
            <div className="schedule-step-fields">
              <label className="label">选择 Skill 包</label>
              <select
                className="input"
                value={step.skillPackageId || ''}
                onChange={e => {
                  const pkg = enabledSkillPkgs.find(p => p.id === e.target.value);
                  updateStep(index, s => ({
                    ...s,
                    skillPackageId: e.target.value,
                    toolName: pkg?.tools?.[0]?.name || '',
                  }));
                }}
              >
                <option value="">— 选择 Skill 包 —</option>
                {enabledSkillPkgs.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {step.type === 'http-request' && (
            <>
              <div className="schedule-step-fields">
                <label className="label">URL</label>
                <input
                  className="input"
                  value={step.url || ''}
                  onChange={e => updateStep(index, s => ({ ...s, url: e.target.value }))}
                  placeholder="https://example.com/api/status"
                />
              </div>
              <div className="schedule-step-fields">
                <label className="label">Method</label>
                <select
                  className="input"
                  value={(step.options as any)?.method || 'GET'}
                  onChange={e => updateStep(index, s => ({ ...s, options: { ...(s.options || {}), method: e.target.value } }))}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
            </>
          )}

          {step.type === 'delay' && (
            <div className="schedule-step-fields">
              <label className="label">等待毫秒数</label>
              <input
                className="input"
                type="number"
                value={step.ms || 1000}
                onChange={e => updateStep(index, s => ({ ...s, ms: Number(e.target.value) || 1000 }))}
                min={100}
                max={60000}
              />
            </div>
          )}

          {step.type === 'condition' && (
            <div className="schedule-step-fields">
              <label className="label">条件表达式（JavaScript，用 context.step_N.output 引用上游结果）</label>
              <input
                className="input"
                value={step.condition || ''}
                onChange={e => updateStep(index, s => ({ ...s, condition: e.target.value }))}
                placeholder='例如: context.step_1.output.includes("ok")'
              />
            </div>
          )}

          {step.type !== 'condition' && step.type !== 'delay' && (
            <>
              <div className="schedule-step-fields">
                <label className="label">参数（JSON）</label>
                <textarea
                  className="input"
                  rows={3}
                  value={JSON.stringify(step.args || {}, null, 2)}
                  onChange={e => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      updateStep(index, s => ({ ...s, args: parsed }));
                    } catch { /* user still editing JSON */ }
                  }}
                  placeholder='{"key": "value"}'
                />
              </div>
              <div className="schedule-step-fields">
                <label className="label">超时（毫秒）</label>
                <input
                  className="input"
                  type="number"
                  value={step.timeoutMs || 30000}
                  onChange={e => updateStep(index, s => ({ ...s, timeoutMs: Number(e.target.value) || 30000 }))}
                />
              </div>
              <div className="schedule-step-fields">
                <label className="label">失败处理</label>
                <select
                  className="input"
                  value={step.onFailure || 'stop'}
                  onChange={e => updateStep(index, s => ({ ...s, onFailure: e.target.value as 'stop' | 'continue' }))}
                >
                  <option value="stop">停止执行</option>
                  <option value="continue">继续下一步</option>
                </select>
              </div>
            </>
          )}
        </div>
        )}
      </div>
    );
  };

  return (
    <div className="scripts-upload-modal-backdrop" onClick={onClose}>
      <div className="scripts-upload-modal schedule-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="scripts-upload-modal-head">
          <div>
            <span className="scripts-upload-modal-kicker">Scheduled Task</span>
            <h3>{isEdit ? '编辑定时任务' : '新建定时任务'}</h3>
          </div>
          <button className="scripts-upload-modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="scripts-upload-modal-body">
          {/* 基本信息 */}
          <div className="schedule-basic-section">
            <div className="form-row">
              <label className="label">任务名称</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="例如 每日巡检+通知" />
            </div>

            <div className="form-row">
              <label className="label">执行频率</label>
              <select
                className="input"
                value={freqType}
                onChange={e => setFreqType(e.target.value as FreqType)}
              >
                {Object.entries(FREQ_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>

            {/* 根据频率类型显示子选项 */}
            {freqType === 'every-n-minutes' && (
              <div className="form-row">
                <label className="label">每隔多少分钟</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={1440}
                  value={everyNMinutes}
                  onChange={e => setEveryNMinutes(Math.max(1, Number(e.target.value) || 5))}
                />
              </div>
            )}

            {freqType === 'hourly' && (
              <div className="form-row">
                <label className="label">在第几分钟执行</label>
                <select className="input" value={hourlyMinute} onChange={e => setHourlyMinute(Number(e.target.value))}>
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                    <option key={m} value={m}>{m} 分</option>
                  ))}
                </select>
              </div>
            )}

            {(freqType === 'daily' || freqType === 'weekly' || freqType === 'monthly') && (
              <div className="schedule-time-picker-row">
                <div className="form-row" style={{ flex: 1 }}>
                  <label className="label">小时</label>
                  <select
                    className="input"
                    value={freqType === 'daily' ? dailyHour : freqType === 'weekly' ? weeklyHour : monthlyHour}
                    onChange={e => {
                      const v = Number(e.target.value);
                      if (freqType === 'daily') setDailyHour(v);
                      else if (freqType === 'weekly') setWeeklyHour(v);
                      else setMonthlyHour(v);
                    }}
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
                    ))}
                  </select>
                </div>
                <span className="schedule-time-sep">:</span>
                <div className="form-row" style={{ flex: 1 }}>
                  <label className="label">分钟</label>
                  <select
                    className="input"
                    value={freqType === 'daily' ? dailyMinute : freqType === 'weekly' ? weeklyMinute : monthlyMinute}
                    onChange={e => {
                      const v = Number(e.target.value);
                      if (freqType === 'daily') setDailyMinute(v);
                      else if (freqType === 'weekly') setWeeklyMinute(v);
                      else setMonthlyMinute(v);
                    }}
                  >
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                      <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {freqType === 'weekly' && (
              <div className="form-row">
                <label className="label">星期几</label>
                <div className="schedule-weekday-picker">
                  {WEEKDAYS.map((label, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`schedule-weekday-btn${weeklyDay === i ? ' active' : ''}`}
                      onClick={() => setWeeklyDay(i)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {freqType === 'monthly' && (
              <div className="form-row">
                <label className="label">每月几号</label>
                <select className="input" value={monthlyDay} onChange={e => setMonthlyDay(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d} 号</option>
                  ))}
                </select>
              </div>
            )}

            <div className="schedule-human-preview">
              ⏱️ {toHumanText(formState)}
            </div>

            <label className="toggle-row schedule-enabled-toggle">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              <span>创建后立即启用</span>
            </label>
          </div>

          {/* 编排链 */}
          <div className="schedule-steps-section">
            <div className="schedule-steps-head">
              <span className="label">编排链 ({steps.length} 步)</span>
              <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={addStep}>
                <Plus size={12} /> 添加步骤
              </button>
            </div>
            <div className="schedule-steps-list">
              {steps.map((step, i) => renderStepForm(step, i))}
            </div>
          </div>

          {/* 错误处理 */}
          <div className="schedule-error-section">
            <div className="schedule-section-title">错误处理</div>
            <div className="form-row">
              <label className="label">失败重试次数</label>
              <input className="input" type="number" min={0} max={10} value={retryCount} onChange={e => setRetryCount(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label className="label">重试间隔（毫秒）</label>
              <input className="input" type="number" min={1000} max={60000} value={retryBackoff} onChange={e => setRetryBackoff(Number(e.target.value))} />
            </div>
            <label className="toggle-row">
              <input type="checkbox" checked={notifyOnFailure} onChange={e => setNotifyOnFailure(e.target.checked)} />
              <span>失败时发送系统通知</span>
            </label>
          </div>

          {error && <div className="scripts-upload-error">{error}</div>}
        </div>

        <div className="scripts-upload-modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <RefreshCw size={14} /> : null}
            {saving ? '保存中...' : isEdit ? '保存修改' : '创建定时任务'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScheduleEditorModal;
