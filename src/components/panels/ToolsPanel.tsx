import React from 'react';
import { Play, RefreshCw, Save, Square, Wrench } from 'lucide-react';
import { useAppStore } from '../../stores';
import { callServerTool, listServers, scanSkills, startServer, stopServer, updateServer, updateSkillMeta } from '../../services/runtime';
import type { ServerDefinition } from '../../types';
import { mapSkillRecord } from '../../services/skillRecords';

const getServerTools = (server: ServerDefinition | null | undefined) =>
  Array.isArray(server?.capabilities?.tools) ? server.capabilities.tools : [];

const protocolBadge = (server: ServerDefinition | null) => server?.capabilities?.protocol?.mode || 'unknown';
const stringifyJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2);
const summarizeResult = (result: string) => result.replace(/\s+/g, ' ').trim().slice(0, 180) || '空结果';

type ToolCallHistoryItem = {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  ok: boolean;
  createdAt: string;
  argsText: string;
  resultText: string;
};

const ToolsPanel: React.FC = () => {
  const { skills, skillsLoading, skillsError, setSkills, toggleSkill, setSkillsLoading, setSkillsError, servers, setServers, toolsPanelTab, setToolsPanelTab } = useAppStore();
  const [editingSkill, setEditingSkill] = React.useState<string | null>(null);
  const [skillDescriptionDraft, setSkillDescriptionDraft] = React.useState('');
  const [skillTriggersDraft, setSkillTriggersDraft] = React.useState('');
  const [skillServerIdDraft, setSkillServerIdDraft] = React.useState('');
  const [skillToolNameDraft, setSkillToolNameDraft] = React.useState('');
  const [skillMetaStatus, setSkillMetaStatus] = React.useState('');
  const [selectedServerId, setSelectedServerId] = React.useState('');
  const [selectedToolName, setSelectedToolName] = React.useState('');
  const [toolResult, setToolResult] = React.useState('');
  const [toolArgs, setToolArgs] = React.useState('{}');
  const [toolRunning, setToolRunning] = React.useState(false);
  const [toolCallHistory, setToolCallHistory] = React.useState<ToolCallHistoryItem[]>([]);
  const [serverDraft, setServerDraft] = React.useState({
    description: '',
    command: '',
    args: '',
    url: '',
    headers: '{}',
  });

  const loadSkills = React.useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const raw = await scanSkills();
      const currentSkills = useAppStore.getState().skills;
      const mapped = raw.map((s: any) => mapSkillRecord(s, currentSkills.find(sk => sk.name === s.name)?.enabled ?? true));
      setSkills(mapped);
    } catch (error) {
      console.error('scan skills error:', error);
      setSkillsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillsLoading(false);
    }
  }, [setSkills, setSkillsError, setSkillsLoading]);

  const refreshServers = React.useCallback(async () => {
    try {
      const next = await listServers();
      setServers(next);
    } catch (error) {
      console.error('list servers error:', error);
    }
  }, [setServers]);

  React.useEffect(() => {
    void loadSkills();
    void refreshServers();
  }, [loadSkills, refreshServers]);

  const serverOptions = React.useMemo(
    () => servers.filter((server) => server.enabled !== false),
    [servers],
  );
  const selectedServer = serverOptions.find((server) => server.id === selectedServerId) || serverOptions[0] || null;
  const selectedServerTools = React.useMemo(() => getServerTools(selectedServer), [selectedServer]);
  const selectedTool = selectedServerTools.find((tool) => tool.name === selectedToolName) || selectedServerTools[0] || null;
  const selectedToolSchema = selectedTool?.inputSchema || selectedServer?.capabilities?.inputSchema || {};
  const selectedToolHistory = React.useMemo(
    () => toolCallHistory.filter((item) => item.serverId === selectedServer?.id && item.toolName === selectedTool?.name),
    [toolCallHistory, selectedServer?.id, selectedTool?.name],
  );

  React.useEffect(() => {
    if (!selectedServer) return;
    setSelectedServerId(selectedServer.id);
    setServerDraft({
      description: selectedServer.description || '',
      command: selectedServer.connection?.command || selectedServer.entry,
      args: (selectedServer.connection?.args || []).join(' '),
      url: selectedServer.connection?.url || '',
      headers: JSON.stringify(selectedServer.connection?.headers || {}, null, 2),
    });
    const nextToolName = selectedServerTools[0]?.name || '';
    setSelectedToolName((current) => (selectedServerTools.some((tool) => tool.name === current) ? current : nextToolName));
  }, [selectedServer?.id, selectedServerTools]);

  React.useEffect(() => {
    if (!selectedTool) {
      setToolArgs('{}');
      return;
    }

    setToolArgs((current) => {
      if (current.trim() && current.trim() !== '{}') {
        return current;
      }
      const required = Array.isArray((selectedToolSchema as { required?: unknown }).required)
        ? ((selectedToolSchema as { required?: string[] }).required || [])
        : [];
      const properties = ((selectedToolSchema as { properties?: Record<string, unknown> }).properties) || {};
      const seed = Object.fromEntries(required.map((key) => [key, Array.isArray((properties[key] as { type?: string })?.type) ? '' : '']));
      return stringifyJson(seed);
    });
  }, [selectedTool?.name]);

  const startEditSkill = (skillName: string, description: string, triggers: string[], serverId: string, toolName?: string) => {
    setEditingSkill(skillName);
    setSkillDescriptionDraft(description);
    setSkillTriggersDraft(triggers.join(', '));
    setSkillServerIdDraft(serverId || '');
    setSkillToolNameDraft(toolName || '');
    setSkillMetaStatus('');
  };

  const handleSaveSkillMeta = async (skillName: string) => {
    try {
      const trimmedServerId = skillServerIdDraft.trim();
      if (!trimmedServerId) {
        setSkillMetaStatus('请先选择一个 Server。');
        return;
      }
      if (editingToolSelectionRequired && !skillToolNameDraft.trim()) {
        setSkillMetaStatus('当前 Server 没有唯一默认工具，请显式选择一个 Tool。');
        return;
      }
      const nextTriggers = skillTriggersDraft
        .split(/[,\n，]/)
        .map(item => item.trim())
        .filter(Boolean);
      await updateSkillMeta(skillName, {
        description: skillDescriptionDraft,
        triggers: nextTriggers,
        serverId: trimmedServerId,
        toolName: skillToolNameDraft.trim() || null,
      });
      setSkillMetaStatus('已保存说明和标签');
      await loadSkills();
      setEditingSkill(null);
    } catch (error) {
      setSkillMetaStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const editingServer = serverOptions.find((server) => server.id === skillServerIdDraft) || null;
  const editingServerTools = getServerTools(editingServer);
  const editingDefaultTools = editingServerTools.filter((tool) => tool.isDefault);
  const editingToolSelectionRequired = Boolean(
    editingServer &&
    !(editingDefaultTools.length === 1 || editingServerTools.length === 1),
  );

  const handleRunTool = async () => {
    if (!selectedServer || !selectedTool) return;
    setToolRunning(true);
    try {
      const args = toolArgs.trim() ? JSON.parse(toolArgs) : {};
      const result = await callServerTool(selectedServer.id, selectedTool.name, args);
      const nextResult = JSON.stringify(result, null, 2);
      setToolResult(nextResult);
      setToolCallHistory((current) => [{
        id: `${Date.now()}-${selectedServer.id}-${selectedTool.name}`,
        serverId: selectedServer.id,
        serverName: selectedServer.name,
        toolName: selectedTool.name,
        ok: result?.isError !== true,
        createdAt: new Date().toISOString(),
        argsText: toolArgs,
        resultText: nextResult,
      }, ...current].slice(0, 12));
      await refreshServers();
    } catch (error) {
      const nextResult = error instanceof Error ? error.message : String(error);
      setToolResult(nextResult);
      setToolCallHistory((current) => [{
        id: `${Date.now()}-${selectedServer.id}-${selectedTool.name}`,
        serverId: selectedServer.id,
        serverName: selectedServer.name,
        toolName: selectedTool.name,
        ok: false,
        createdAt: new Date().toISOString(),
        argsText: toolArgs,
        resultText: nextResult,
      }, ...current].slice(0, 12));
    } finally {
      setToolRunning(false);
    }
  };

  const handleSaveServer = async (server: ServerDefinition) => {
    try {
      await updateServer(server.id, {
        description: serverDraft.description.trim(),
        connection: {
          ...(server.connection || {}),
          command: serverDraft.command.trim(),
          args: serverDraft.args.split(/\s+/).filter(Boolean),
          url: serverDraft.url.trim(),
          headers: JSON.parse(serverDraft.headers || '{}'),
        },
      });
      await refreshServers();
      setToolResult('Server 配置已保存');
    } catch (error) {
      setToolResult(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleServer = async (server: ServerDefinition) => {
    try {
      if (server.status === 'running') {
        await stopServer(server.id);
      } else {
        await startServer(server.id, {});
      }
      await refreshServers();
    } catch (error) {
      setToolResult(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="tools-panel">
      <div className="tabbar">
        <button type="button" className={`tab${toolsPanelTab === 'skills' ? ' active' : ''}`} onClick={() => setToolsPanelTab('skills')}>Skills</button>
        <button type="button" className={`tab${toolsPanelTab === 'mcp' ? ' active' : ''}`} onClick={() => setToolsPanelTab('mcp')}>MCP</button>
      </div>

      {toolsPanelTab === 'skills' ? (
        <div className="tools-list">
          <div className="toolbar-row">
            <span className="toolbar-note">{skillsLoading ? '正在同步 Skill...' : `已加载 ${skills.length} 个 Skill`}</span>
            <button type="button" className="toolbar-text-btn" onClick={() => void loadSkills()}>
              <RefreshCw size={14} />
              <span>刷新</span>
            </button>
          </div>
          {skillsError && <div className="error-text">{skillsError}</div>}
          {skills.map((skill) => (
            <div key={skill.name} className="tool-card">
              <div className="tool-card-head">
                <div>
                  <strong>{skill.name}</strong>
                  <p>{skill.description}</p>
                </div>
                <label className="toggle-row tool-enable-switch">
                  <input type="checkbox" checked={skill.enabled} onChange={() => toggleSkill(skill.name)} />
                  <span className="tool-enable-switch-track">
                    <span className="tool-enable-switch-thumb" />
                  </span>
                  <span className="tool-enable-switch-label">{skill.enabled ? '启用' : '关闭'}</span>
                </label>
              </div>
              {editingSkill === skill.name ? (
                <div className="tool-card-body">
                  <textarea className="textarea" rows={3} value={skillDescriptionDraft} onChange={(event) => setSkillDescriptionDraft(event.target.value)} />
                  <input className="input" value={skillTriggersDraft} onChange={(event) => setSkillTriggersDraft(event.target.value)} placeholder="触发词，逗号分隔" />
                  <div className="field">
                    <label>Server</label>
                    <select className="input" value={skillServerIdDraft} onChange={(event) => {
                      const nextServerId = event.target.value;
                      setSkillServerIdDraft(nextServerId);
                      const nextServer = serverOptions.find((server) => server.id === nextServerId) || null;
                      const nextTools = getServerTools(nextServer);
                      const nextDefaults = nextTools.filter((tool) => tool.isDefault);
                      if (nextDefaults.length === 1 || nextTools.length === 1) {
                        setSkillToolNameDraft('');
                      } else {
                        setSkillToolNameDraft('');
                      }
                    }}>
                      <option value="">请选择 Server</option>
                      {serverOptions.map((server) => (
                        <option key={server.id} value={server.id}>{server.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Tool</label>
                    <select className="input" value={skillToolNameDraft} onChange={(event) => setSkillToolNameDraft(event.target.value)} disabled={!editingServer}>
                      <option value="">
                        {editingToolSelectionRequired ? '请选择 Tool' : '使用默认工具'}
                      </option>
                      {editingServerTools.map((tool) => (
                        <option key={tool.name} value={tool.name}>
                          {tool.name}{tool.isDefault ? ' · 默认工具' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  {editingServer && (
                    <div className="toolbar-note">
                      {editingToolSelectionRequired
                        ? '当前 Server 没有唯一默认工具，必须显式选择一个 toolName。'
                        : editingDefaultTools.length === 1
                          ? `当前默认工具：${editingDefaultTools[0].name}`
                          : editingServerTools.length === 1
                            ? `当前唯一工具：${editingServerTools[0].name}`
                            : '当前 Server 可自动解析默认工具。'}
                    </div>
                  )}
                  <div className="toolbar-row">
                    <button type="button" className="toolbar-text-btn" onClick={() => void handleSaveSkillMeta(skill.name)}>
                      <Save size={14} />
                      <span>保存</span>
                    </button>
                    <button type="button" className="toolbar-text-btn" onClick={() => setEditingSkill(null)}>
                      <span>取消</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tool-card-body">
                  <div className="tool-chip-row">
                    {skill.triggers.map((trigger) => <span key={trigger} className="tool-chip">{trigger}</span>)}
                  </div>
                  <div className="toolbar-note">
                    Server：{skill.serverId || '未绑定'} / Tool：{skill.toolName || skill.resolvedToolName || '默认工具'} / 状态：{skill.bindingStatus || 'unknown'}
                  </div>
                  {skill.bindingError && <div className="error-text">{skill.bindingError}</div>}
                  <button type="button" className="toolbar-text-btn" onClick={() => startEditSkill(skill.name, skill.description, skill.triggers, skill.serverId, skill.toolName)}>
                    <span>编辑 Skill</span>
                  </button>
                </div>
              )}
            </div>
          ))}
          {skillMetaStatus && <div className="toolbar-note">{skillMetaStatus}</div>}
        </div>
      ) : (
        <div className="tools-list">
          <div className="toolbar-row">
            <span className="toolbar-note">MCP 面板与任务工作区共享同一套 Server 数据。</span>
            <button type="button" className="toolbar-text-btn" onClick={() => void refreshServers()}>
              <RefreshCw size={14} />
              <span>刷新</span>
            </button>
          </div>

          <div className="field">
            <label>选择 Server</label>
            <select className="input" value={selectedServer?.id || ''} onChange={(event) => setSelectedServerId(event.target.value)}>
              {serverOptions.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} · {server.type}
                </option>
              ))}
            </select>
          </div>

          {selectedServer && (
            <div className="tool-card">
              <div className="tool-card-head">
                <div>
                  <strong>{selectedServer.name}</strong>
                  <p>{selectedServer.description || '暂无说明'}</p>
                  <p>协议：{protocolBadge(selectedServer)} / Schema：{selectedServer.capabilities.schemaSource || '未知'} / 工具数：{selectedServerTools.length}</p>
                </div>
                <button type="button" className="toolbar-text-btn" onClick={() => void handleToggleServer(selectedServer)}>
                  {selectedServer.status === 'running' ? <Square size={14} /> : <Play size={14} />}
                  <span>{selectedServer.status === 'running' ? '断开 / 停止' : '连接 / 启动'}</span>
                </button>
              </div>

              <div className="tool-card-body">
                <div className="mcp-panel-meta-grid">
                  <div className="mcp-panel-meta-item">
                    <span>状态</span>
                    <strong>{selectedServer.status}</strong>
                  </div>
                  <div className="mcp-panel-meta-item">
                    <span>入口</span>
                    <strong>{selectedServer.entry}</strong>
                  </div>
                  <div className="mcp-panel-meta-item">
                    <span>运行时</span>
                    <strong>{selectedServer.runtime}</strong>
                  </div>
                  <div className="mcp-panel-meta-item">
                    <span>最近输出</span>
                    <strong>{selectedServer.runtimeState?.lastOutputAt || '暂无'}</strong>
                  </div>
                </div>
                <div className="field">
                  <label>说明</label>
                  <textarea className="textarea" rows={2} value={serverDraft.description} onChange={(event) => setServerDraft((current) => ({ ...current, description: event.target.value }))} />
                </div>
                <div className="field">
                  <label>Command / Entry</label>
                  <input className="input" value={serverDraft.command} onChange={(event) => setServerDraft((current) => ({ ...current, command: event.target.value }))} />
                </div>
                <div className="field">
                  <label>Args</label>
                  <input className="input" value={serverDraft.args} onChange={(event) => setServerDraft((current) => ({ ...current, args: event.target.value }))} />
                </div>
                <div className="field">
                  <label>URL</label>
                  <input className="input" value={serverDraft.url} onChange={(event) => setServerDraft((current) => ({ ...current, url: event.target.value }))} />
                </div>
                <div className="field">
                  <label>Headers JSON</label>
                  <textarea className="textarea" rows={4} value={serverDraft.headers} onChange={(event) => setServerDraft((current) => ({ ...current, headers: event.target.value }))} />
                </div>
                <button type="button" className="toolbar-text-btn" onClick={() => void handleSaveServer(selectedServer)}>
                  <Save size={14} />
                  <span>保存 Server 配置</span>
                </button>
              </div>
            </div>
          )}

          <div className="mcp-debug-grid">
            <div className="tool-card">
              <div className="tool-card-head">
                <div>
                  <strong>工具目录</strong>
                  <p>浏览当前 Server 暴露的全部工具，而不是默认第一个工具。</p>
                </div>
                <Wrench size={16} />
              </div>
              <div className="tool-card-body">
                {selectedServerTools.length === 0 ? (
                  <div className="toolbar-note">当前 Server 暂无可调用工具。</div>
                ) : (
                  <div className="mcp-tool-list">
                    {selectedServerTools.map((tool) => (
                      <button
                        type="button"
                        key={tool.name}
                        className={`mcp-tool-item${selectedTool?.name === tool.name ? ' active' : ''}`}
                        onClick={() => setSelectedToolName(tool.name)}
                      >
                        <div className="mcp-tool-item-head">
                          <strong>{tool.name}</strong>
                          <div className="mcp-tool-badges">
                            <span className="badge badge-muted">{tool.outputMode || 'unknown'}</span>
                            <span className="badge badge-muted">{tool.execution || 'unknown'}</span>
                            {tool.isDefault && <span className="badge badge-accent">默认工具</span>}
                            {tool.adapter && <span className="badge badge-success">兼容适配</span>}
                          </div>
                        </div>
                        <p>{tool.description || '无描述'}</p>
                        <div className="mcp-tool-item-meta">
                          <span>Schema：{tool.schemaSource || selectedServer?.capabilities?.schemaSource || '未知'}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="tool-card">
              <div className="tool-card-head">
                <div>
                  <strong>工具检视</strong>
                  <p>查看当前工具的说明、Schema 和适配细节。</p>
                </div>
              </div>
              <div className="tool-card-body">
                {!selectedTool ? (
                  <div className="toolbar-note">请先选择一个工具。</div>
                ) : (
                  <>
                    <div className="mcp-tool-inspector-grid">
                      <div className="mcp-panel-meta-item">
                        <span>输出模式</span>
                        <strong>{selectedTool.outputMode || '未声明'}</strong>
                      </div>
                      <div className="mcp-panel-meta-item">
                        <span>执行方式</span>
                        <strong>{selectedTool.execution || '未声明'}</strong>
                      </div>
                      <div className="mcp-panel-meta-item">
                        <span>Schema 来源</span>
                        <strong>{selectedTool.schemaSource || selectedServer?.capabilities?.schemaSource || '未知'}</strong>
                      </div>
                      <div className="mcp-panel-meta-item">
                        <span>协议模式</span>
                        <strong>{selectedServer?.capabilities?.protocol?.mode || '未知'}</strong>
                      </div>
                    </div>
                    <div className="field">
                      <label>工具说明</label>
                      <textarea className="textarea" rows={3} value={selectedTool.description || '无描述'} readOnly />
                    </div>
                    <div className="field">
                      <label>Input Schema</label>
                      <pre className="tool-output mcp-json-block">{stringifyJson(selectedToolSchema)}</pre>
                    </div>
                    <div className="field">
                      <label>Adapter / Protocol</label>
                      <pre className="tool-output mcp-json-block">
                        {stringifyJson({
                          protocol: selectedServer?.capabilities?.protocol || null,
                          adapter: selectedTool.adapter || selectedServer?.capabilities?.adapter || null,
                        })}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="mcp-debug-grid">
            <div className="tool-card">
              <div className="tool-card-head">
                <div>
                  <strong>工具调用</strong>
                  <p>逐工具编辑参数并直接发起调用。</p>
                </div>
                <Wrench size={16} />
              </div>
              <div className="tool-card-body">
                <div className="field">
                  <label>当前工具</label>
                  <input className="input" value={selectedTool?.name || ''} readOnly />
                </div>
                <div className="field">
                  <label>参数 JSON</label>
                  <textarea className="textarea" rows={10} value={toolArgs} onChange={(event) => setToolArgs(event.target.value)} />
                </div>
                <button type="button" className="toolbar-text-btn" onClick={() => void handleRunTool()} disabled={toolRunning || !selectedTool}>
                  <Play size={14} />
                  <span>{toolRunning ? '调用中...' : '执行工具'}</span>
                </button>
                <pre className="tool-output">{toolResult || '工具结果会显示在这里。'}</pre>
              </div>
            </div>

            <div className="tool-card">
              <div className="tool-card-head">
                <div>
                  <strong>调用历史</strong>
                  <p>保留当前工具最近几次调试结果，便于对比入参与返回。</p>
                </div>
              </div>
              <div className="tool-card-body">
                {selectedToolHistory.length === 0 ? (
                  <div className="toolbar-note">当前工具还没有调用历史。</div>
                ) : (
                  <div className="mcp-history-list">
                    {selectedToolHistory.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className="mcp-history-item"
                        onClick={() => {
                          setToolArgs(item.argsText);
                          setToolResult(item.resultText);
                        }}
                      >
                        <div className="mcp-history-head">
                          <strong>{item.toolName}</strong>
                          <span className={`badge ${item.ok ? 'badge-success' : 'badge-muted'}`}>{item.ok ? '成功' : '失败'}</span>
                        </div>
                        <p>{new Date(item.createdAt).toLocaleString()}</p>
                        <p>{summarizeResult(item.resultText)}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ToolsPanel;
