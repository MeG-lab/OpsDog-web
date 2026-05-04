import React from 'react';
import { Play, RefreshCw, ShieldCheck, Square, Waves, FileCode2, Upload, X, FileUp } from 'lucide-react';
import { useAppStore } from '../../stores';
import { executeInstantSkill, listManagedTasks, resolveSkillEntryScript, restartManagedTask, scanSkills, startManagedTask, stopManagedTask, updateSkillMeta, uploadScript, validateSkillArgs } from '../../services/runtime';
import type { ManagedTaskConfig, ManagedTaskInfo } from '../../types';

type ScriptKind = 'instant' | 'managed';
type ScriptStatus = 'idle' | 'running' | 'attention' | 'warning' | 'recovered' | 'stopping' | 'stopped' | 'error';

interface ScriptItem {
  id: string;
  name: string;
  kind: ScriptKind;
  status: ScriptStatus;
  note: string;
  description: string;
  command: string;
  runtime: string;
  defaultArgs: string[];
  path: string;
  recentLogs: string[];
}

const kindLabel: Record<ScriptKind, string> = {
  instant: '即时任务',
  managed: '托管任务',
};

const statusLabel: Record<ScriptStatus, string> = {
  idle: '待命',
  running: '运行中',
  attention: '需关注',
  warning: '告警中',
  recovered: '已恢复',
  stopping: '停止中',
  stopped: '已停止',
  error: '异常退出',
};

const ScriptsWorkspace: React.FC = () => {
  const focusedScriptId = useAppStore((state) => state.focusedScriptId);
  const focusScript = useAppStore((state) => state.focusScript);
  const [activeKind, setActiveKind] = React.useState<'all' | ScriptKind>('all');
  const [selectedId, setSelectedId] = React.useState('');
  const [managedTasks, setManagedTasks] = React.useState<Record<string, ManagedTaskInfo>>({});
  const [taskActionPending, setTaskActionPending] = React.useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = React.useState('');
  const [descriptionSaving, setDescriptionSaving] = React.useState(false);
  const [descriptionStatus, setDescriptionStatus] = React.useState('');
  const [workspaceStatus, setWorkspaceStatus] = React.useState('');
  const [uploadKind, setUploadKind] = React.useState<ScriptKind | null>(null);
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [uploadDescription, setUploadDescription] = React.useState('');
  const [uploadPending, setUploadPending] = React.useState(false);
  const [uploadError, setUploadError] = React.useState('');
  const uploadFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { skills, setSkills, setSkillsLoading, managedTaskConfigs, setManagedTaskConfig } = useAppStore();

  const loadSkills = React.useCallback(async () => {
    setSkillsLoading(true);
    try {
      const raw = await scanSkills();
      const currentSkills = useAppStore.getState().skills;
      const mapped = raw.map((s: any) => ({
        name: s.name,
        version: s.version,
        description: s.description,
        taskKind: s.taskKind || s.task_kind || 'instant',
        triggers: s.triggers,
        entryScript: s.entryScript || s.entry_script || '',
        timeoutSeconds: s.timeoutSeconds || s.timeout_seconds || 60,
        dependencies: s.dependencies || [],
        defaultArgs: s.defaultArgs || s.default_args || [],
        enabled: currentSkills.find(sk => sk.name === s.name)?.enabled ?? true,
        path: s.path,
      }));
      setSkills(mapped);
    } finally {
      setSkillsLoading(false);
    }
  }, [setSkills, setSkillsLoading]);

  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const refreshManagedTasks = React.useCallback(async () => {
    try {
      const tasks = await listManagedTasks();
      setManagedTasks(Object.fromEntries(tasks.map(task => [task.taskId, task])));
    } catch (error) {
      console.error('list managed tasks error:', error);
    }
  }, []);

  React.useEffect(() => {
    void refreshManagedTasks();
    const timer = window.setInterval(() => {
      void refreshManagedTasks();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshManagedTasks]);

  const scriptItems: ScriptItem[] = skills.map(skill => {
    const task = managedTasks[skill.name];
    const kind: ScriptKind = skill.taskKind === 'managed' ? 'managed' : 'instant';
    const status: ScriptStatus = kind === 'managed'
      ? (task?.status as ScriptStatus | undefined) || (skill.enabled ? 'idle' : 'stopped')
      : (skill.enabled ? 'idle' : 'stopped');

    const runtime = kind === 'managed'
      ? buildManagedRuntimeLabel(task, skill.enabled)
      : (skill.enabled ? '已启用 · 等待触发' : '未启用');

    const commandSuffix = (skill.defaultArgs || []).join(' ');

    return {
      id: skill.name,
      name: skill.entryScript.split('/').pop() || skill.name,
      kind,
      status,
      note: skill.description,
      description: skill.description,
      command: `python ${skill.entryScript}${commandSuffix ? ` ${commandSuffix}` : ''}`,
      runtime,
      defaultArgs: skill.defaultArgs || [],
      path: skill.path,
      recentLogs: task?.recentLogs || [],
    };
  });

  const filteredScripts = scriptItems.filter(script => activeKind === 'all' || script.kind === activeKind);
  const selectedScript = filteredScripts.find(script => script.id === selectedId) || filteredScripts[0];
  const hasActiveAlert = selectedScript && ['attention', 'warning', 'error'].includes(selectedScript.status);

  React.useEffect(() => {
    if (!selectedScript && scriptItems[0]) {
      setSelectedId(scriptItems[0].id);
    }
    if (selectedScript && selectedScript.id !== selectedId) {
      setSelectedId(selectedScript.id);
    }
  }, [scriptItems, selectedId, selectedScript]);

  React.useEffect(() => {
    if (!focusedScriptId) return;
    const match = scriptItems.find((item) => item.id === focusedScriptId);
    if (!match) return;
    setActiveKind(match.kind);
    setSelectedId(match.id);
    focusScript(null);
  }, [focusedScriptId, scriptItems, focusScript]);

  React.useEffect(() => {
    skills
      .filter(skill => skill.taskKind === 'managed')
      .forEach(skill => {
        if (!managedTaskConfigs[skill.name]) {
          const task = managedTasks[skill.name];
          setManagedTaskConfig(skill.name, parseManagedTaskDraft(task?.args?.length ? task.args : (skill.defaultArgs || [])));
        }
      });
  }, [skills, managedTasks, managedTaskConfigs, setManagedTaskConfig]);

  React.useEffect(() => {
    setDescriptionDraft(selectedScript?.description || '');
    setDescriptionStatus('');
    setWorkspaceStatus('');
  }, [selectedScript?.id, selectedScript?.description]);

  const stats = {
    total: scriptItems.length,
    instant: scriptItems.filter(script => script.kind === 'instant').length,
    managed: scriptItems.filter(script => script.kind === 'managed').length,
  };

  const closeUploadModal = React.useCallback(() => {
    setUploadKind(null);
    setUploadFile(null);
    setUploadDescription('');
    setUploadError('');
    setUploadPending(false);
    if (uploadFileInputRef.current) {
      uploadFileInputRef.current.value = '';
    }
  }, []);

  React.useEffect(() => {
    if (!uploadKind) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeUploadModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [uploadKind, closeUploadModal]);

  const handleStartManagedTask = async () => {
    if (!selectedScript || selectedScript.kind !== 'managed') return;
    setTaskActionPending(selectedScript.id);
    try {
      const scriptPath = await resolveSkillEntryScript(selectedScript.path, skills.find(skill => skill.name === selectedScript.id)?.entryScript || '');
      const draft = managedTaskConfigs[selectedScript.id] || parseManagedTaskDraft(selectedScript.defaultArgs);
      const args = buildManagedTaskArgs(draft);
      const validated = await validateSkillArgs(selectedScript.path, args);
      if (!validated.valid) {
        throw new Error(validated.errors.join('；'));
      }
      const info = await startManagedTask(selectedScript.id, scriptPath, validated.normalizedArgs);
      setManagedTasks(current => ({ ...current, [info.taskId]: info }));
      setWorkspaceStatus(`已启动托管任务：${selectedScript.name}`);
    } catch (error) {
      console.error('start managed task error:', error);
      setWorkspaceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskActionPending(null);
      void refreshManagedTasks();
    }
  };

  const handleStopManagedTask = async () => {
    if (!selectedScript || selectedScript.kind !== 'managed') return;
    setTaskActionPending(selectedScript.id);
    try {
      const info = await stopManagedTask(selectedScript.id);
      setManagedTasks(current => ({ ...current, [info.taskId]: info }));
      setWorkspaceStatus(`已停止托管任务：${selectedScript.name}`);
    } catch (error) {
      console.error('stop managed task error:', error);
      setWorkspaceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskActionPending(null);
      void refreshManagedTasks();
    }
  };

  const handleRestartManagedTask = async () => {
    if (!selectedScript || selectedScript.kind !== 'managed') return;
    setTaskActionPending(selectedScript.id);
    try {
      const scriptPath = await resolveSkillEntryScript(
        selectedScript.path,
        skills.find(skill => skill.name === selectedScript.id)?.entryScript || '',
      );
      const draft = managedTaskConfigs[selectedScript.id] || parseManagedTaskDraft(selectedScript.defaultArgs);
      const args = buildManagedTaskArgs(draft);
      const validated = await validateSkillArgs(selectedScript.path, args);
      if (!validated.valid) {
        throw new Error(validated.errors.join('；'));
      }
      const info = await restartManagedTask(selectedScript.id, scriptPath, validated.normalizedArgs);
      setManagedTasks(current => ({ ...current, [info.taskId]: info }));
      setWorkspaceStatus(`已重启托管任务：${selectedScript.name}`);
    } catch (error) {
      console.error('restart managed task error:', error);
      setWorkspaceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskActionPending(null);
      void refreshManagedTasks();
    }
  };

  const handleRunInstantTask = async () => {
    if (!selectedScript || selectedScript.kind !== 'instant') return;
    setTaskActionPending(selectedScript.id);
    setWorkspaceStatus('');
    try {
      const result = await executeInstantSkill(selectedScript.id, selectedScript.defaultArgs);
      if (result.exitCode === 0) {
        setWorkspaceStatus(`即时任务执行完成：${selectedScript.name}${result.stdout ? `\n\n${result.stdout}` : ''}`);
      } else {
        const errorText = result.stderr || result.stdout || `exit ${result.exitCode}`;
        setWorkspaceStatus(`即时任务执行失败：${selectedScript.name}\n\n${errorText}`);
      }
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTaskActionPending(null);
    }
  };

  const updateManagedDraft = (taskId: string, field: keyof ManagedTaskConfig, value: string) => {
    setManagedTaskConfig(taskId, {
      ...(managedTaskConfigs[taskId] || parseManagedTaskDraft([])),
      [field]: value,
    });
  };

  const handleSaveDescription = async () => {
    if (!selectedScript) return;
    const skill = skills.find(item => item.name === selectedScript.id);
    if (!skill) return;

    setDescriptionSaving(true);
    setDescriptionStatus('');
    try {
      await updateSkillMeta(skill.name, descriptionDraft.trim(), skill.triggers);
      await loadSkills();
      setDescriptionStatus('说明已保存');
    } catch (error) {
      setDescriptionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setDescriptionSaving(false);
    }
  };

  const handleSubmitUpload = async () => {
    if (!uploadKind) return;
    if (!uploadFile) {
      setUploadError('请选择一个 .py 脚本文件。');
      return;
    }
    if (!uploadDescription.trim()) {
      setUploadError('请补充一句脚本用途说明。');
      return;
    }

    setUploadPending(true);
    setUploadError('');
    try {
      const result = await uploadScript(uploadKind, uploadFile, uploadDescription.trim());
      await loadSkills();
      await refreshManagedTasks();
      setWorkspaceStatus(`脚本已上传：${result.scriptPath}\n\n当前已作为脚本资产保存，后续接入 Skill 生成链路后才会出现在任务体系中。`);
      setActiveKind(uploadKind);
      closeUploadModal();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadPending(false);
    }
  };

  return (
    <div className="scripts-workspace">
      <div className="scripts-hero">
        <div>
          <div className="scripts-kicker">Task Workspace</div>
          <h1>任务空间</h1>
          <p>{'即时任务和托管任务以 Skill 元数据分类，当前网页端已开始通过本地后端承接执行链。'}
          </p>
        </div>
        <div className="scripts-hero-stats">
          <div className="scripts-stat-card">
            <span>全部任务</span>
            <strong>{stats.total}</strong>
          </div>
          <div className="scripts-stat-card">
            <span>即时任务</span>
            <strong>{stats.instant}</strong>
          </div>
          <div className="scripts-stat-card">
            <span>托管任务</span>
            <strong>{stats.managed}</strong>
          </div>
        </div>
      </div>

      <div className="scripts-shell">
        <aside className="scripts-sidebar">
          <div className="scripts-section-title">任务类型</div>
          <button
            className={`scripts-filter-btn${activeKind === 'all' ? ' active' : ''}`}
            onClick={() => setActiveKind('all')}
          >
            <FileCode2 size={14} />
            <span>全部任务</span>
          </button>
          <div className="scripts-filter-row">
            <button
              className={`scripts-filter-btn${activeKind === 'instant' ? ' active' : ''}`}
              onClick={() => setActiveKind('instant')}
            >
              <Play size={14} />
              <span>即时任务</span>
            </button>
            <button
              className="scripts-upload-trigger"
              type="button"
              title="上传即时任务脚本"
              aria-label="上传即时任务脚本"
              onClick={() => {
                setUploadKind('instant');
                setUploadFile(null);
                setUploadDescription('');
                setUploadError('');
              }}
            >
              <Upload size={14} />
            </button>
          </div>
          <div className="scripts-filter-row">
            <button
              className={`scripts-filter-btn${activeKind === 'managed' ? ' active' : ''}`}
              onClick={() => setActiveKind('managed')}
            >
              <Waves size={14} />
              <span>托管任务</span>
            </button>
            <button
              className="scripts-upload-trigger"
              type="button"
              title="上传托管任务脚本"
              aria-label="上传托管任务脚本"
              onClick={() => {
                setUploadKind('managed');
                setUploadFile(null);
                setUploadDescription('');
                setUploadError('');
              }}
            >
              <Upload size={14} />
            </button>
          </div>

          <div className="scripts-section-title scripts-section-gap">当前规则</div>
          <div className="scripts-note-card">
            <ShieldCheck size={14} />
            <p>Skill 的 `task_kind` 决定它属于即时任务还是托管任务，后续对话调度会直接复用这层定义。</p>
          </div>
        </aside>

        <section className="scripts-list-pane">
          <div className="scripts-pane-header">
            <div>
              <h2>{activeKind === 'all' ? '任务目录' : kindLabel[activeKind]}</h2>
              <p>这里展示的是当前可识别的 Skill 入口能力，而不是静态示例数据。</p>
            </div>
            <button className="btn btn-ghost" onClick={() => void loadSkills()}>
              <RefreshCw size={13} />
              刷新
            </button>
          </div>

          <div className="scripts-list">
            {filteredScripts.map(script => (
              <button
                key={script.id}
                className={`script-card${selectedScript?.id === script.id ? ' active' : ''}${
                  ['attention', 'warning', 'error'].includes(script.status)
                    ? ' alert'
                    : ['running', 'recovered'].includes(script.status)
                      ? ' healthy'
                      : ''
                }`}
                onClick={() => setSelectedId(script.id)}
              >
                <div className="script-card-top">
                  <div>
                    <div className="script-card-name">{script.name}</div>
                    <div className="script-card-kind">{kindLabel[script.kind]}</div>
                  </div>
                  {!['idle', 'stopped'].includes(script.status) && (
                    <span className={`script-status-badge ${script.status}`}>{statusLabel[script.status]}</span>
                  )}
                </div>
                <p className="script-card-desc">{script.note}</p>
              </button>
            ))}

            {filteredScripts.length === 0 && (
              <div className="scripts-note-card">
                <ShieldCheck size={14} />
                <p>当前没有匹配到这类任务。先在 Skills 中上传或启用对应 Skill。</p>
              </div>
            )}
          </div>
        </section>

        <aside className="scripts-detail-pane">
          <div className="scripts-section-title">任务详情</div>
          {selectedScript ? (
            <div className={`script-detail-card${hasActiveAlert ? ' alert' : ''}`}>
              <div className="script-detail-header">
                <div>
                  <h3>{selectedScript.name}</h3>
                  <p>{selectedScript.description}</p>
                </div>
                <span className={`script-status-badge ${selectedScript.status}`}>{statusLabel[selectedScript.status]}</span>
              </div>

              {hasActiveAlert && (
                <div className="script-alert-banner">
                  当前托管任务处于{statusLabel[selectedScript.status]}，请尽快检查最近日志和目标服务状态。
                </div>
              )}

              {workspaceStatus && (
                <div className="script-alert-banner" style={{ background: 'var(--color-bg-secondary)', borderColor: 'var(--color-border-light)', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {workspaceStatus}
                </div>
              )}

              <div className="script-detail-grid">
                <div>
                  <span className="script-detail-label">类型</span>
                  <strong>{kindLabel[selectedScript.kind]}</strong>
                </div>
                <div>
                  <span className="script-detail-label">当前状态</span>
                  <strong>{selectedScript.runtime}</strong>
                </div>
              </div>

              <div className="script-detail-block">
                <span className="script-detail-label">执行入口</span>
                <code>{selectedScript.command}</code>
              </div>

              <div className="script-detail-block">
                <span className="script-detail-label">说明</span>
                <div className="managed-description-editor">
                  <textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    placeholder="填写任务说明"
                    rows={3}
                  />
                  <div className="managed-description-footer">
                    <button className="btn btn-ghost" onClick={handleSaveDescription} disabled={descriptionSaving}>
                      {descriptionSaving ? '保存中...' : '保存说明'}
                    </button>
                    {descriptionStatus && <span className="managed-description-status">{descriptionStatus}</span>}
                  </div>
                </div>
              </div>

              {selectedScript.kind === 'managed' && (
                <div className="script-detail-block">
                  <span className="script-detail-label">托管配置</span>
                  <div className="managed-config-grid">
                    {usesManagedTargets(selectedScript.defaultArgs) && (
                      <label className="managed-config-field managed-config-field-wide">
                        <span>目标地址</span>
                        <input
                          value={managedTaskConfigs[selectedScript.id]?.targets || ''}
                          onChange={(e) => updateManagedDraft(selectedScript.id, 'targets', e.target.value)}
                          placeholder="多个地址用空格分隔，例如 192.168.11.1 192.168.11.2"
                        />
                      </label>
                    )}
                    <label className="managed-config-field">
                      <span>主机</span>
                      <input
                        value={managedTaskConfigs[selectedScript.id]?.host || ''}
                        onChange={(e) => updateManagedDraft(selectedScript.id, 'host', e.target.value)}
                        placeholder="127.0.0.1"
                      />
                    </label>
                    <label className="managed-config-field">
                      <span>端口</span>
                      <input
                        value={managedTaskConfigs[selectedScript.id]?.port || ''}
                        onChange={(e) => updateManagedDraft(selectedScript.id, 'port', e.target.value)}
                        placeholder="7001"
                      />
                    </label>
                    <label className="managed-config-field">
                      <span>间隔(秒)</span>
                      <input
                        value={managedTaskConfigs[selectedScript.id]?.interval || ''}
                        onChange={(e) => updateManagedDraft(selectedScript.id, 'interval', e.target.value)}
                        placeholder="3"
                      />
                    </label>
                    <label className="managed-config-field">
                      <span>失败阈值</span>
                      <input
                        value={managedTaskConfigs[selectedScript.id]?.maxFailures || ''}
                        onChange={(e) => updateManagedDraft(selectedScript.id, 'maxFailures', e.target.value)}
                        placeholder="3"
                      />
                    </label>
                    <label className="managed-config-field managed-config-field-wide">
                      <span>日志文件</span>
                      <input
                        value={managedTaskConfigs[selectedScript.id]?.logFile || ''}
                        onChange={(e) => updateManagedDraft(selectedScript.id, 'logFile', e.target.value)}
                        placeholder="可选，例如 /logs/service_watchdog.log"
                      />
                    </label>
                  </div>
                </div>
              )}

              {selectedScript.kind === 'managed' && (
                <div className="script-detail-block">
                  <span className="script-detail-label">最近日志</span>
                  <pre className="script-log-block">
                    {(selectedScript.recentLogs.length > 0 ? selectedScript.recentLogs : ['暂时没有日志输出']).join('\n')}
                  </pre>
                </div>
              )}

              <div className="script-detail-actions">
                <button
                  className="btn btn-primary"
                  onClick={
                    selectedScript.kind === 'instant'
                      ? handleRunInstantTask
                      : selectedScript.kind === 'managed' && isManagedRunning(selectedScript.status)
                        ? handleStopManagedTask
                        : handleStartManagedTask
                  }
                  disabled={taskActionPending === selectedScript.id}
                >
                  {selectedScript.kind === 'managed' && isManagedRunning(selectedScript.status) ? <Square size={13} /> : <Play size={13} />}
                  {selectedScript.kind === 'managed'
                    ? (isManagedRunning(selectedScript.status) ? '停止托管' : '启动托管')
                    : '立即运行'}
                </button>
                {selectedScript.kind === 'managed' && (
                  <button
                    className="btn btn-ghost"
                    onClick={handleRestartManagedTask}
                    disabled={taskActionPending === selectedScript.id}
                  >
                    <RefreshCw size={13} />
                    重启托管
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="scripts-note-card">
              <ShieldCheck size={14} />
              <p>还没有可展示的 Skill 任务。</p>
            </div>
          )}
        </aside>
      </div>

      {uploadKind && (
        <div className="scripts-upload-modal-backdrop" onClick={closeUploadModal}>
          <div className="scripts-upload-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">{uploadKind === 'instant' ? '即时任务' : '托管任务'}</span>
                <h3>上传脚本</h3>
              </div>
              <button className="scripts-upload-modal-close" type="button" onClick={closeUploadModal} aria-label="关闭上传弹窗">
                <X size={18} />
              </button>
            </div>

            <div className="scripts-upload-modal-body">
              <label className="scripts-upload-field">
                <span>脚本文件</span>
                <input
                  ref={uploadFileInputRef}
                  className="scripts-upload-native-input"
                  type="file"
                  accept=".py"
                  onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                />
                <div className={`scripts-upload-file-picker${uploadFile ? ' has-file' : ''}`}>
                  <button
                    className="scripts-upload-file-picker-action"
                    type="button"
                    onClick={() => uploadFileInputRef.current?.click()}
                  >
                    <FileUp size={16} />
                    选择文件
                  </button>
                  <span className="scripts-upload-file-picker-name">{uploadFile ? uploadFile.name : '未选择文件'}</span>
                </div>
                <small>仅支持 `.py` 文件，不覆盖同名脚本。</small>
              </label>

              <label className="scripts-upload-field">
                <span>一句说明</span>
                <textarea
                  value={uploadDescription}
                  onChange={(event) => setUploadDescription(event.target.value)}
                  rows={3}
                  maxLength={140}
                  placeholder={uploadKind === 'instant' ? '例如：快速检查一批地址的连通性。' : '例如：持续检测某服务端口与进程状态。'}
                />
                <small>{uploadDescription.trim().length}/140</small>
              </label>

              {uploadError && <div className="scripts-upload-error">{uploadError}</div>}
            </div>

            <div className="scripts-upload-modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeUploadModal} disabled={uploadPending}>
                关闭
              </button>
              <button className="btn btn-primary" type="button" onClick={handleSubmitUpload} disabled={uploadPending}>
                {uploadPending ? '上传中...' : '确认上传'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function isManagedRunning(status: ScriptStatus) {
  return ['running', 'attention', 'warning', 'recovered', 'stopping'].includes(status);
}

function buildManagedRuntimeLabel(task: ManagedTaskInfo | undefined, enabled: boolean) {
  if (!enabled) return '未启用';
  if (!task) return '已启用 · 尚未启动';
  if (task.status === 'running') return '运行中 · 持续检测';
  if (task.status === 'recovered') return '已恢复 · 持续检测';
  if (task.status === 'attention') return '异常中 · 等待升级';
  if (task.status === 'warning') return '告警中 · 连续失败';
  if (task.status === 'stopping') return '停止中';
  if (task.status === 'stopped') return '已停止';
  if (task.status === 'error') return '异常退出';
  return '已启用 · 尚未启动';
}

function parseManagedTaskDraft(args: string[]): ManagedTaskConfig {
  const draft: ManagedTaskConfig = {
    targets: '',
    host: '127.0.0.1',
    port: '',
    interval: '3',
    maxFailures: '3',
    logFile: '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--targets') {
      const targets: string[] = [];
      let j = i + 1;
      while (j < args.length && !args[j].startsWith('--')) {
        targets.push(args[j]);
        j += 1;
      }
      draft.targets = targets.join(' ');
      i = j - 1;
      continue;
    }

    if (!next) continue;

    if (arg === '--host') draft.host = next;
    if (arg === '--port') draft.port = next;
    if (arg === '--interval') draft.interval = next;
    if (arg === '--max-failures') draft.maxFailures = next;
    if (arg === '--log-file') draft.logFile = next;
  }

  return draft;
}

function buildManagedTaskArgs(draft: ManagedTaskConfig): string[] {
  const args: string[] = [];
  const targets = (draft.targets || '')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);

  const host = draft.host.trim() || '127.0.0.1';
  const port = draft.port.trim();
  const interval = draft.interval.trim() || '3';
  const maxFailures = draft.maxFailures.trim() || '3';
  const logFile = draft.logFile.trim();

  if (targets.length > 0) {
    args.push('--targets', ...targets);
  } else {
    args.push('--host', host);
    if (port) {
      args.push('--port', port);
    }
  }
  args.push('--interval', interval);
  args.push('--max-failures', maxFailures);
  if (logFile) {
    args.push('--log-file', logFile);
  }

  return args;
}

function usesManagedTargets(defaultArgs: string[]) {
  return defaultArgs.includes('--targets');
}

export default ScriptsWorkspace;
