import React from 'react';
import { Check, FileCode2, Pencil, Play, RefreshCw, ShieldCheck, Square, Trash2, Upload, Waves, Wrench, X } from 'lucide-react';
import { useAppStore } from '../../stores';
import {
  deleteServer,
  listServers,
  restartServer,
  startServer,
  stopServer,
  updateServer,
  uploadServerScript,
} from '../../services/runtime';
import type { ServerCategory, ServerDefinition } from '../../types';

type WorkspaceFilter = 'all' | 'instant' | 'managed';

const filterLabel: Record<WorkspaceFilter, string> = {
  all: '全部',
  instant: '单次任务',
  managed: '托管任务',
};

const categoryLabel: Record<ServerCategory, string> = {
  instant: '单次',
  managed: '托管',
  system: '系统',
};

const statusLabel: Record<ServerDefinition['status'], string> = {
  idle: '待命',
  starting: '启动中',
  running: '运行中',
  attention: '需关注',
  warning: '告警中',
  recovered: '已恢复',
  stopping: '停止中',
  stopped: '已停止',
  error: '异常',
};

type CapabilityToolDraft = {
  draftId: string;
  name: string;
  description: string;
  inputSchemaText: string;
  isDefault: boolean;
};

type CapabilityDraft = {
  tools: CapabilityToolDraft[];
};

type DisplayLogItem = {
  id: string;
  signature: string;
  content: string;
  repeatCount: number;
};

const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
};

const makeDraftId = () => `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prettyJson = (value: unknown) => JSON.stringify(value ?? emptySchema, null, 2);

const buildCapabilityDraft = (server: ServerDefinition): CapabilityDraft => {
  const tools = (server.capabilities?.tools || []).map((tool, index) => ({
    draftId: `${tool.name}-${index}`,
    name: tool.name || `${server.id}_${index + 1}`,
    description: tool.description || '',
    inputSchemaText: prettyJson(tool.inputSchema || server.capabilities?.inputSchema || emptySchema),
    isDefault: tool.isDefault === true,
  }));
  const normalizedTools = tools.length > 0
    ? tools
    : [{
        draftId: makeDraftId(),
        name: server.id,
        description: server.description || '',
        inputSchemaText: prettyJson(server.capabilities?.inputSchema || emptySchema),
        isDefault: true,
      }];
  const hasDefault = normalizedTools.some((tool) => tool.isDefault);
  const finalizedTools = normalizedTools.map((tool, index) => ({
    ...tool,
    isDefault: hasDefault ? tool.isDefault : index === 0,
  }));
  return {
    tools: finalizedTools,
  };
};

const getProtocolModeForCategory = (category: ServerCategory) =>
  category === 'managed' ? 'json-stream' : 'json-tool';

const getProtocolIo = (category: ServerCategory) => ({
  stdin: 'json',
  stdout:
    category === 'managed'
      ? 'json-events'
      : 'json-object',
  stderr: 'text',
});

const getToolOutputMode = (category: ServerCategory) =>
  category === 'managed' ? 'json-events' : 'json-object';

const ScriptsWorkspace: React.FC = () => {
  const focusedScriptId = useAppStore((state) => state.focusedScriptId);
  const focusScript = useAppStore((state) => state.focusScript);
  const servers = useAppStore((state) => state.servers);
  const setServers = useAppStore((state) => state.setServers);
  const [activeFilter, setActiveFilter] = React.useState<WorkspaceFilter>('all');
  const [selectedId, setSelectedId] = React.useState('');
  const [selectedSnapshot, setSelectedSnapshot] = React.useState<ServerDefinition | null>(null);
  const [, setWorkspaceStatus] = React.useState('');
  const [uploadKind, setUploadKind] = React.useState<'instant' | 'managed' | null>(null);
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [uploadDescription, setUploadDescription] = React.useState('');
  const [uploadTriggers, setUploadTriggers] = React.useState('');
  const [uploadPending, setUploadPending] = React.useState(false);
  const [uploadError, setUploadError] = React.useState('');
  const [actionPending, setActionPending] = React.useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = React.useState('');
  const [descriptionEditing, setDescriptionEditing] = React.useState(false);
  const [descriptionStatus, setDescriptionStatus] = React.useState('');
  const [capabilityDraft, setCapabilityDraft] = React.useState<CapabilityDraft | null>(null);
  const [capabilityOpen, setCapabilityOpen] = React.useState(false);
  const [capabilityPending, setCapabilityPending] = React.useState(false);
  const [capabilityError, setCapabilityError] = React.useState('');
  const uploadFileInputRef = React.useRef<HTMLInputElement | null>(null);

  const refreshServers = React.useCallback(async () => {
    try {
      const next = await listServers();
      setServers(next);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : String(error));
    }
  }, [setServers]);

  React.useEffect(() => {
    void refreshServers();
    const timer = window.setInterval(() => {
      void refreshServers();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refreshServers]);

  const filteredServers = React.useMemo(() => {
    const visibleServers = servers.filter((server) => server.category !== 'system');
    return visibleServers.filter((server) => activeFilter === 'all' || server.category === activeFilter);
  }, [servers, activeFilter]);

  const selectedServer = React.useMemo(() => {
    const matched = filteredServers.find((server) => server.id === selectedId);
    if (matched) return matched;
    if (selectedSnapshot && filteredServers.some((server) => server.id === selectedSnapshot.id)) {
      return selectedSnapshot;
    }
    return null;
  }, [filteredServers, selectedId, selectedSnapshot]);
  const selectedRecentLogs = selectedServer?.capabilities?.recentLogs || [];
  const normalizedRecentLogs = React.useMemo(
    () => selectedRecentLogs.flatMap((line) => line.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)),
    [selectedRecentLogs],
  );
  const displayRecentLogs = React.useMemo(() => {
    const compressed: DisplayLogItem[] = [];
    normalizedRecentLogs
      .slice()
      .reverse()
      .forEach((line, index) => {
        const normalizedLine = line.trim();
        const previous = compressed[compressed.length - 1];
        if (previous && previous.signature === normalizedLine) {
          previous.repeatCount += 1;
          return;
        }
        compressed.push({
          id: `${selectedServer?.id || 'server'}-${index}`,
          signature: normalizedLine,
          content: normalizedLine,
          repeatCount: 1,
        });
      });
    return compressed;
  }, [normalizedRecentLogs, selectedServer?.id]);

  const selectServer = React.useCallback((server: ServerDefinition) => {
    setSelectedId(server.id);
    setSelectedSnapshot(server);
  }, []);

  React.useEffect(() => {
    if (!selectedId) {
      return;
    }
    const matched = filteredServers.find((server) => server.id === selectedId);
    if (matched) {
      setSelectedSnapshot(matched);
      return;
    }
    setSelectedId('');
    setSelectedSnapshot(null);
  }, [filteredServers, selectedId]);

  React.useEffect(() => {
    if (!focusedScriptId) return;
    const target = servers.find((server) => server.id === focusedScriptId);
    if (!target) return;
    setActiveFilter(target.category === 'managed' ? 'managed' : target.category === 'instant' ? 'instant' : 'all');
    selectServer(target);
    focusScript(null);
  }, [focusedScriptId, servers, focusScript, selectServer]);

  React.useEffect(() => {
    setDescriptionDraft(selectedServer?.description || '');
    setDescriptionEditing(false);
    setDescriptionStatus('');
    setCapabilityOpen(false);
    setCapabilityDraft(null);
    setCapabilityError('');
  }, [selectedServer?.id, selectedServer?.description]);

  const stats = React.useMemo(() => ({
    total: servers.filter((server) => server.category !== 'system').length,
    instant: servers.filter((server) => server.category === 'instant').length,
    managed: servers.filter((server) => server.category === 'managed').length,
  }), [servers]);

  const closeUploadModal = React.useCallback(() => {
    setUploadKind(null);
    setUploadFile(null);
    setUploadDescription('');
    setUploadTriggers('');
    setUploadError('');
    setUploadPending(false);
    if (uploadFileInputRef.current) {
      uploadFileInputRef.current.value = '';
    }
  }, []);

  const handleUpload = async () => {
    if (!uploadKind) return;
    if (!uploadFile) {
      setUploadError('请选择一个 .py 文件。');
      return;
    }
    if (!uploadDescription.trim()) {
      setUploadError('请填写描述。');
      return;
    }
    const triggers = uploadTriggers
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (triggers.length === 0) {
      setUploadError('请至少填写一个触发词。');
      return;
    }

    setUploadPending(true);
    setUploadError('');
    try {
      const created = await uploadServerScript(uploadKind, uploadFile, uploadDescription.trim(), triggers);
      await refreshServers();
      setActiveFilter(created.category === 'managed' ? 'managed' : 'instant');
      setSelectedId(created.id);
      setSelectedSnapshot(created);
      setWorkspaceStatus(`任务与同名 Skill 已创建：${created.name}`);
      closeUploadModal();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadPending(false);
    }
  };

  const runServerAction = async (action: 'start' | 'stop' | 'restart' | 'delete' | 'save-description') => {
    if (!selectedServer) return;
    setActionPending(action);
    try {
      if (action === 'start') {
        await startServer(selectedServer.id, {});
        setWorkspaceStatus(`已启动 ${selectedServer.name}`);
      } else if (action === 'stop') {
        await stopServer(selectedServer.id);
        setWorkspaceStatus(`已停止 ${selectedServer.name}`);
      } else if (action === 'restart') {
        await restartServer(selectedServer.id, {});
        setWorkspaceStatus(`已重启 ${selectedServer.name}`);
      } else if (action === 'delete') {
        await deleteServer(selectedServer.id);
        setWorkspaceStatus(`已删除 ${selectedServer.name}`);
        setSelectedId('');
        setSelectedSnapshot(null);
      } else if (action === 'save-description') {
        await updateServer(selectedServer.id, { description: descriptionDraft.trim() });
        setWorkspaceStatus(`已更新 ${selectedServer.name} 的说明`);
        setDescriptionStatus('说明已保存');
        setDescriptionEditing(false);
      }
      await refreshServers();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkspaceStatus(message);
      if (action === 'save-description') {
        setDescriptionStatus(message);
      }
    } finally {
      setActionPending(null);
    }
  };

  const runServerActionForServer = async (
    server: ServerDefinition,
    action: 'start' | 'stop',
  ) => {
    setActionPending(`${action}:${server.id}`);
    try {
      if (action === 'start') {
        await startServer(server.id, {});
        setWorkspaceStatus(`已启动 ${server.name}`);
      } else {
        await stopServer(server.id);
        setWorkspaceStatus(`已停止 ${server.name}`);
      }
      await refreshServers();
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  };

  const openCapabilityEditor = React.useCallback(() => {
    if (!selectedServer || selectedServer.type !== 'python-script') return;
    setCapabilityDraft(buildCapabilityDraft(selectedServer));
    setCapabilityError('');
    setCapabilityOpen(true);
  }, [selectedServer]);

  const closeCapabilityEditor = React.useCallback(() => {
    setCapabilityOpen(false);
    setCapabilityPending(false);
    setCapabilityError('');
    setCapabilityDraft(null);
  }, []);

  const updateDraftTool = React.useCallback((draftId: string, updater: (tool: CapabilityToolDraft) => CapabilityToolDraft) => {
    setCapabilityDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        tools: current.tools.map((tool) => tool.draftId === draftId ? updater(tool) : tool),
      };
    });
  }, []);

  const saveCapabilityDraft = React.useCallback(async () => {
    if (!selectedServer || !capabilityDraft) return;

    const trimmedTools = capabilityDraft.tools.map((tool) => ({
      ...tool,
      name: tool.name.trim(),
      description: tool.description.trim(),
      inputSchemaText: tool.inputSchemaText.trim(),
    }));

    if (trimmedTools.length === 0) {
      setCapabilityError('至少需要保留一个工具。');
      return;
    }

    const usedNames = new Set<string>();
    const parsedTools = [];
    for (const tool of trimmedTools) {
      if (!tool.name) {
        setCapabilityError('工具名称不能为空。');
        return;
      }
      if (usedNames.has(tool.name)) {
        setCapabilityError(`工具名称重复：${tool.name}`);
        return;
      }
      usedNames.add(tool.name);

      let parsedSchema: Record<string, unknown>;
      try {
        parsedSchema = JSON.parse(tool.inputSchemaText || '{}');
      } catch {
        setCapabilityError(`工具 ${tool.name} 的参数定义不是合法 JSON。`);
        return;
      }

      parsedTools.push({
        ...tool,
        parsedSchema,
      });
    }

    const defaultToolIndex = parsedTools.findIndex((tool) => tool.isDefault);
    const normalizedTools = parsedTools.map((tool, index) => ({
      ...tool,
      isDefault: defaultToolIndex >= 0 ? tool.isDefault : index === 0,
    }));
    const protocolMode = getProtocolModeForCategory(selectedServer.category);
    const outputMode = getToolOutputMode(selectedServer.category);

    setCapabilityPending(true);
    setCapabilityError('');
    try {
      await updateServer(selectedServer.id, {
        capabilities: {
          protocol: {
            mode: protocolMode,
            version: 1,
            io: getProtocolIo(selectedServer.category),
          },
          inputSchema: normalizedTools.find((tool) => tool.isDefault)?.parsedSchema || normalizedTools[0]?.parsedSchema || emptySchema,
          schemaSource: 'server-metadata',
          adapter: undefined,
          tools: normalizedTools.map((tool) => ({
            name: tool.name,
            description: tool.description || selectedServer.description || tool.name,
            inputSchema: tool.parsedSchema,
            outputMode,
            execution: selectedServer.category === 'managed' ? 'managed' : 'oneshot',
            schemaSource: 'server-metadata',
            isDefault: tool.isDefault,
            adapter: undefined,
          })),
        },
      });
      await refreshServers();
      setWorkspaceStatus(`已更新 ${selectedServer.name} 的调用配置`);
      closeCapabilityEditor();
    } catch (error) {
      setCapabilityError(error instanceof Error ? error.message : String(error));
    } finally {
      setCapabilityPending(false);
    }
  }, [capabilityDraft, closeCapabilityEditor, refreshServers, selectedServer]);

  const updateSchemaJsonText = React.useCallback((draftId: string, nextText: string) => {
    setCapabilityDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        tools: current.tools.map((tool) => {
          if (tool.draftId !== draftId) return tool;
          return {
            ...tool,
            inputSchemaText: nextText,
          };
        }),
      };
    });
  }, []);

  return (
    <div className="scripts-workspace">
      <div className="scripts-hero">
        <div>
          <div className="scripts-kicker">Task Workspace</div>
          <h1>任务区</h1>
          <p>查看任务状态、配置、上传和日志。</p>
        </div>
          <div className="scripts-hero-stats">
            <div className="scripts-stat-card">
              <span>全部</span>
              <strong>{stats.total}</strong>
            </div>
            <div className="scripts-stat-card">
            <span>单次</span>
              <strong>{stats.instant}</strong>
            </div>
          <div className="scripts-stat-card">
            <span>托管</span>
            <strong>{stats.managed}</strong>
          </div>
        </div>
      </div>

      <div className="scripts-shell">
        <aside className="scripts-sidebar">
          <div className="scripts-section-title">任务分类</div>
          <button className={`scripts-filter-btn${activeFilter === 'all' ? ' active' : ''}`} onClick={() => setActiveFilter('all')}>
            <FileCode2 size={14} />
            <span>{filterLabel.all}</span>
          </button>
          <div className="scripts-filter-row">
            <button className={`scripts-filter-btn${activeFilter === 'instant' ? ' active' : ''}`} onClick={() => setActiveFilter('instant')}>
              <Play size={14} />
              <span>{filterLabel.instant}</span>
            </button>
            <button className="scripts-upload-trigger" title="上传单次任务脚本" onClick={() => setUploadKind('instant')}>
              <Upload size={14} />
            </button>
          </div>
          <div className="scripts-filter-row">
            <button className={`scripts-filter-btn${activeFilter === 'managed' ? ' active' : ''}`} onClick={() => setActiveFilter('managed')}>
              <Waves size={14} />
              <span>{filterLabel.managed}</span>
            </button>
            <button className="scripts-upload-trigger" title="上传托管任务脚本" onClick={() => setUploadKind('managed')}>
              <Upload size={14} />
            </button>
          </div>
          <div className="scripts-section-title scripts-section-gap">说明</div>
          <div className="scripts-note-card">
            <ShieldCheck size={14} />
            <p>单次任务用于按需执行一次并返回结果；托管任务用于持续运行、轮询和监控。</p>
          </div>
        </aside>

        <div className={`scripts-main-stage${selectedServer ? ' has-detail' : ''}`}>
          <section className="scripts-list-pane">
            <div className="scripts-pane-header">
              <div>
                <h2>{filterLabel[activeFilter]}</h2>
                <p>{filteredServers.length} 个任务</p>
              </div>
              <button className="toolbar-text-btn" onClick={() => void refreshServers()} title="刷新任务列表">
                <RefreshCw size={14} />
                <span>刷新</span>
              </button>
            </div>
            <div className="scripts-task-table-head">
              <div>任务名称</div>
              <div>任务类型</div>
              <div>状态</div>
              <div>操作</div>
            </div>
            <div className="scripts-list">
              {filteredServers.map((server) => (
                <div
                  key={server.id}
                  className={`script-card script-card-compact script-row${selectedServer?.id === server.id ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className="script-row-select"
                    onMouseDown={() => selectServer(server)}
                    onClick={() => selectServer(server)}
                  >
                    <div className="script-row-main">
                      <div className="script-row-name">{server.name}</div>
                      <div className="script-row-type">{categoryLabel[server.category]}任务</div>
                      <div className="script-row-status">
                        <span className={`overview-status-pill ${server.status}`}>{statusLabel[server.status]}</span>
                      </div>
                    </div>
                  </button>
                  <div className="script-row-toggle">
                    {['running', 'starting', 'attention', 'warning', 'recovered'].includes(server.status) ? (
                      <button
                        type="button"
                        className="toolbar-text-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          void runServerActionForServer(server, 'stop');
                        }}
                        disabled={actionPending !== null}
                      >
                        <Square size={14} />
                        <span>停止</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="toolbar-text-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          void runServerActionForServer(server, 'start');
                        }}
                        disabled={actionPending !== null}
                      >
                        <Play size={14} />
                        <span>启动</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {filteredServers.length === 0 && (
                <div className="overview-empty">当前分类下还没有任务。</div>
              )}
            </div>
          </section>

          <section className={`scripts-detail-pane scripts-detail-drawer${selectedServer ? ' open' : ''}`}>
          {selectedServer ? (
              <div key={selectedServer.id}>
                <div className="scripts-detail-drawer-head">
                  <button type="button" className="scripts-detail-close" onClick={() => {
                    setSelectedId('');
                    setSelectedSnapshot(null);
                  }} aria-label="收起详情">
                    <X size={16} />
                  </button>
                </div>
                <div className="scripts-task-table-head scripts-task-table-head-detail">
                  <div>任务名称</div>
                  <div>任务类型</div>
                  <div>状态</div>
                  <div>操作</div>
                </div>
                <div className="scripts-detail-summary-row">
                  <div className="scripts-detail-summary-name">
                    <h2>{selectedServer.name}</h2>
                    <p>{selectedServer.entry}</p>
                  </div>
                  <div className="scripts-detail-summary-type">{categoryLabel[selectedServer.category]}任务</div>
                  <div className="scripts-detail-summary-status">
                    <span className={`overview-status-pill ${selectedServer.status}`}>{statusLabel[selectedServer.status]}</span>
                  </div>
                  <div className="scripts-detail-summary-action">
                    {['running', 'starting', 'attention', 'warning', 'recovered'].includes(selectedServer.status) ? (
                      <button className="toolbar-text-btn" onClick={() => void runServerAction('stop')} disabled={actionPending !== null}>
                        <Square size={14} />
                        <span>停止</span>
                      </button>
                    ) : (
                      <button className="toolbar-text-btn" onClick={() => void runServerAction('start')} disabled={actionPending !== null}>
                        <Play size={14} />
                        <span>启动</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="scripts-detail-actions">
                  {selectedServer.type === 'python-script' && (
                    <button className="toolbar-text-btn" onClick={openCapabilityEditor} disabled={actionPending !== null}>
                      <Wrench size={14} />
                      <span>配置调用</span>
                    </button>
                  )}
                  <button className="toolbar-text-btn" onClick={() => void runServerAction('restart')} disabled={actionPending !== null}>
                    <RefreshCw size={14} />
                    <span>重启</span>
                  </button>
                  <button className="toolbar-text-btn" onClick={() => void runServerAction('delete')} disabled={actionPending !== null}>
                    <Trash2 size={14} />
                    <span>删除</span>
                  </button>
                </div>

              <div className="script-description-section-head">
                <div className="scripts-section-title script-description-title">说明</div>
                <span className="script-description-count">{descriptionDraft.trim().length} 字</span>
              </div>
              <section className="script-description-section">
                {descriptionEditing ? (
                  <textarea
                    className="script-description-textarea"
                    rows={4}
                    value={descriptionDraft}
                    onChange={(event) => setDescriptionDraft(event.target.value)}
                    placeholder="补充一句说明"
                  />
                ) : (
                  <div className={`script-description-display${descriptionDraft.trim() ? '' : ' empty'}`}>
                    {descriptionDraft.trim() || '暂无说明'}
                  </div>
                )}
                <div className="script-description-footer">
                  <span className="script-description-hint">
                    {actionPending === 'save-description' ? '正在保存...' : descriptionStatus || ' '}
                  </span>
                  <div className="script-description-actions">
                    {descriptionEditing && (
                      <button
                        className="toolbar-text-btn"
                        onClick={() => {
                          setDescriptionDraft(selectedServer?.description || '');
                          setDescriptionEditing(false);
                          setDescriptionStatus('');
                        }}
                        disabled={actionPending !== null}
                      >
                        <span>取消</span>
                      </button>
                    )}
                    <button
                      className="toolbar-text-btn"
                      onClick={() => {
                        if (descriptionEditing) {
                          void runServerAction('save-description');
                          return;
                        }
                        setDescriptionEditing(true);
                        setDescriptionStatus('');
                      }}
                      disabled={actionPending !== null}
                    >
                      {descriptionEditing ? <Check size={14} /> : <Pencil size={14} />}
                      <span>{descriptionEditing ? '完成编辑' : '编辑说明'}</span>
                    </button>
                  </div>
                </div>
              </section>

              <div className="scripts-section-title scripts-section-gap">最近日志</div>
              <div className="scripts-log-list">
                {displayRecentLogs.length === 0 ? (
                  <div className="overview-empty">暂无日志。</div>
                ) : (
                  displayRecentLogs.map((item) => (
                    <div key={item.id} className="scripts-log-entry">
                      <div className="scripts-log-entry-head">
                        <span className="scripts-log-entry-label">JSON 日志</span>
                        {item.repeatCount > 1 ? (
                          <span className="scripts-log-repeat-badge">{item.repeatCount} 条</span>
                        ) : null}
                      </div>
                      <pre className="scripts-log-entry-content">{item.content}</pre>
                    </div>
                  ))
                )}
              </div>
              </div>
          ) : null}
          </section>
        </div>
      </div>

      {uploadKind && (
        <div className="scripts-upload-modal-backdrop" onClick={closeUploadModal}>
          <div className="scripts-upload-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">{uploadKind === 'managed' ? 'Managed Task' : 'Single Task'}</span>
                <h3>上传{uploadKind === 'managed' ? '托管' : '单次'}任务</h3>
              </div>
              <button className="scripts-upload-modal-close" type="button" onClick={closeUploadModal} aria-label="关闭上传弹窗">
                <X size={18} />
              </button>
            </div>

            <div className="scripts-upload-modal-body">
              <label className="scripts-upload-field">
                <span>Python 文件</span>
                <div className={`scripts-upload-file-picker${uploadFile ? ' has-file' : ''}`}>
                  <input
                    ref={uploadFileInputRef}
                    className="scripts-upload-native-input"
                    type="file"
                    accept=".py"
                    onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                  />
                  <button
                    className="scripts-upload-file-picker-action"
                    type="button"
                    onClick={() => uploadFileInputRef.current?.click()}
                  >
                    <Upload size={16} />
                    选择文件
                  </button>
                  <span className="scripts-upload-file-picker-name">{uploadFile ? uploadFile.name : '未选择任何文件'}</span>
                </div>
                <small>仅支持 `.py` 文件。</small>
              </label>

              <label className="scripts-upload-field">
                <span>描述</span>
                <textarea
                  value={uploadDescription}
                  onChange={(event) => setUploadDescription(event.target.value)}
                  rows={4}
                  maxLength={160}
                  placeholder="描述这个脚本的用途"
                />
                <small>{uploadDescription.trim().length}/160</small>
              </label>

              <label className="scripts-upload-field">
                <span>触发词</span>
                <input
                  value={uploadTriggers}
                  onChange={(event) => setUploadTriggers(event.target.value)}
                  placeholder="例如：现在几点，查询当前时间"
                />
                <small>多个触发词用逗号分隔。上传后会自动生成同名 Skill 并默认启用。</small>
              </label>

              {uploadError && <div className="scripts-upload-error">{uploadError}</div>}
            </div>

            <div className="scripts-upload-modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeUploadModal} disabled={uploadPending}>
                取消
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void handleUpload()} disabled={uploadPending}>
                <Upload size={14} />
                {uploadPending ? '上传中...' : '上传并注册'}
              </button>
            </div>
          </div>
        </div>
      )}

      {capabilityOpen && selectedServer && capabilityDraft && (
        <div className="scripts-upload-modal-backdrop" onClick={closeCapabilityEditor}>
          <div className="scripts-upload-modal scripts-capability-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">Task Understanding</span>
                <h3>配置调用</h3>
              </div>
              <button className="scripts-upload-modal-close" type="button" onClick={closeCapabilityEditor} aria-label="关闭能力配置">
                <X size={18} />
              </button>
            </div>

            <div className="scripts-upload-modal-body">
              <div className="scripts-capability-tool-list">
                {capabilityDraft.tools.map((tool) => (
                  <div key={tool.draftId} className="scripts-capability-tool-card">
                    <div className="scripts-capability-tool-card-head">
                      <span className="scripts-capability-default-tag">默认工具</span>
                    </div>

                    <div className="scripts-capability-inline-grid">
                      <label className="scripts-upload-field">
                        <span>工具名称</span>
                        <input
                          className="scripts-capability-input"
                          value={tool.name}
                          onChange={(event) => updateDraftTool(tool.draftId, (current) => ({ ...current, name: event.target.value }))}
                          placeholder="例如 ping_check"
                        />
                      </label>
                    </div>

                    <label className="scripts-upload-field">
                      <span>功能说明</span>
                      <textarea
                        value={tool.description}
                        onChange={(event) => updateDraftTool(tool.draftId, (current) => ({ ...current, description: event.target.value }))}
                        rows={3}
                        placeholder="一句话说明用途"
                      />
                      <small>需要时可在下方直接编辑 JSON。</small>
                    </label>

                    <label className="scripts-upload-field">
                      <span>高级 JSON</span>
                      <div className="scripts-schema-raw scripts-schema-raw-open">
                        <textarea
                          value={tool.inputSchemaText}
                          onChange={(event) => updateSchemaJsonText(tool.draftId, event.target.value)}
                          rows={10}
                          placeholder='{"type":"object","properties":{}}'
                        />
                      </div>
                      <small>这里填写 JSON Schema。后续聊天、Skill、MCP 调试都会按它理解参数。</small>
                    </label>
                  </div>
                ))}
              </div>

              {capabilityError && <div className="scripts-upload-error">{capabilityError}</div>}
            </div>

            <div className="scripts-upload-modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeCapabilityEditor} disabled={capabilityPending}>
                取消
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void saveCapabilityDraft()} disabled={capabilityPending}>
                <Wrench size={14} />
                {capabilityPending ? '保存中...' : '保存调用配置'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScriptsWorkspace;
