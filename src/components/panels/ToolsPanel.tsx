import React from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Plus, RefreshCw, Wifi, WifiOff, Zap, Trash2, Play, PencilLine, Save, X } from 'lucide-react';
import { useAppStore } from '../../stores';
import { scanSkills, updateSkillMeta, connectMCPServer, disconnectMCPServer, callMCPTool, listMCPTools, getMCPStatus } from '../../services/runtime';
import type { MCPServer } from '../../types';

type TabId = 'skills' | 'mcp';

const ToolsPanel: React.FC = () => {
  const [tab, setTab] = React.useState<TabId>('skills');
  const { skills, skillsLoading, setSkills, toggleSkill, setSkillsLoading, mcpServers, setMCPServers } = useAppStore();
  const [editingSkill, setEditingSkill] = React.useState<string | null>(null);
  const [skillDescriptionDraft, setSkillDescriptionDraft] = React.useState('');
  const [skillTriggersDraft, setSkillTriggersDraft] = React.useState('');
  const [skillMetaStatus, setSkillMetaStatus] = React.useState('');
  const [showSkillUploadInfo, setShowSkillUploadInfo] = React.useState(false);

  // MCP state
  const [showAddMCP, setShowAddMCP] = React.useState(false);
  const [newMCP, setNewMCP] = React.useState({
    name: '',
    transport: 'streamable-http',
    command: '',
    args: '',
    url: '',
    headers: '{}',
    riskLevel: 'read-only',
    toolRiskOverrides: '{}',
  });
  const [mcpTools, setMcpTools] = React.useState<Array<{ name: string; description: string; serverName: string }>>([]);
  const [selectedTool, setSelectedTool] = React.useState('');
  const [toolArgs, setToolArgs] = React.useState('{}');
  const [toolResult, setToolResult] = React.useState('');
  const [toolRunning, setToolRunning] = React.useState(false);
  const [expandedMCP, setExpandedMCP] = React.useState<Record<string, boolean>>({});
  const [editingMCP, setEditingMCP] = React.useState<string | null>(null);
  const [mcpEditDrafts, setMcpEditDrafts] = React.useState<Record<string, {
    transport: 'stdio' | 'streamable-http';
    command: string;
    args: string;
    url: string;
    headers: string;
    riskLevel: 'read-only' | 'state-change' | 'destructive';
    toolRiskOverrides: string;
  }>>({});

  const loadSkills = React.useCallback(async () => {
    setSkillsLoading(true);
    try {
      const raw = await scanSkills();
      const currentSkills = useAppStore.getState().skills;
      const mapped = raw.map((s: any) => ({
        name: s.name, version: s.version, description: s.description,
        taskKind: s.taskKind || s.task_kind || 'instant',
        triggers: s.triggers, entryScript: s.entryScript || s.entry_script || '',
        timeoutSeconds: s.timeoutSeconds || s.timeout_seconds || 60, dependencies: s.dependencies || [],
        defaultArgs: s.defaultArgs || s.default_args || [],
        enabled: currentSkills.find(sk => sk.name === s.name)?.enabled ?? true,
        path: s.path,
      }));
      setSkills(mapped);
    } catch (e) { console.error('scan skills error:', e); }
    finally { setSkillsLoading(false); }
  }, [setSkills, setSkillsLoading]);

  React.useEffect(() => { loadSkills(); }, [loadSkills]);

  React.useEffect(() => {
    setMcpEditDrafts(Object.fromEntries(
      mcpServers.map(server => [
        server.name,
        {
          transport: server.transport || 'stdio',
          command: server.command || '',
          args: (server.args || []).join(' '),
          url: server.url || '',
          headers: JSON.stringify(server.headers || {}, null, 2),
          riskLevel: server.riskLevel || 'read-only',
          toolRiskOverrides: JSON.stringify(server.toolRiskOverrides || {}, null, 2),
        },
      ])
    ));
  }, [mcpServers]);

  React.useEffect(() => {
    const syncMcpStatus = async () => {
      try {
        const statuses = await getMCPStatus();
        const statusMap = new Map(statuses.map(status => [status.name, status]));
        setMCPServers(mcpServers.map(server => {
          const status = statusMap.get(server.name);
          return {
            ...server,
            connected: status?.connected ?? false,
            connecting: false,
            toolCount: status?.toolCount ?? 0,
          };
        }));
      } catch (error) {
        console.error('get mcp status error:', error);
      }
    };

    void syncMcpStatus();
    void refreshMCPTools();
  }, []);

  const refreshMCPTools = React.useCallback(async () => {
    try {
      const tools = await listMCPTools();
      const normalized = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        serverName: tool.serverName,
      }));
      setMcpTools(normalized);
      if (normalized[0] && !normalized.some(tool => `${tool.serverName}:${tool.name}` === selectedTool)) {
        setSelectedTool(`${normalized[0].serverName}:${normalized[0].name}`);
      }
    } catch (error) {
      console.error('list mcp tools error:', error);
      setMcpTools([]);
    }
  }, [selectedTool]);

  const updateMcpServer = (index: number, updates: Partial<MCPServer>) => {
    const updated = [...mcpServers];
    updated[index] = { ...updated[index], ...updates };
    setMCPServers(updated);
  };

  const handleMCPConnect = async (idx: number) => {
    const s = mcpServers[idx];
    const updated = [...mcpServers];
    updated[idx] = { ...s, connecting: true, statusMessage: '正在连接...', statusLevel: 'info' };
    setMCPServers(updated);
    try {
      const tools = await connectMCPServer({
        name: s.name,
        command: s.command,
        args: s.args,
        env: {},
        transport: s.transport,
        url: s.url,
        headers: s.headers,
        riskLevel: s.riskLevel,
        toolRiskOverrides: s.toolRiskOverrides,
      });
      updated[idx] = {
        ...updated[idx],
        connected: true,
        connecting: false,
        toolCount: tools.length,
        statusMessage: `连接成功，发现 ${tools.length} 个工具`,
        statusLevel: 'success',
      };
      await refreshMCPTools();
    } catch (e) {
      updated[idx] = {
        ...updated[idx],
        connecting: false,
        connected: false,
        toolCount: 0,
        statusMessage: `连接失败：${e instanceof Error ? e.message : String(e)}`,
        statusLevel: 'error',
      };
    }
    setMCPServers([...updated]);
  };

  const handleMCPDisconnect = async (idx: number) => {
    const s = mcpServers[idx];
    try {
      await disconnectMCPServer(s.name);
    } catch (error) {
      const updated = [...mcpServers];
      updated[idx] = {
        ...s,
        statusMessage: `断开失败：${error instanceof Error ? error.message : String(error)}`,
        statusLevel: 'error',
      };
      setMCPServers(updated);
      return;
    }
    const updated = [...mcpServers];
    updated[idx] = {
      ...s,
      connected: false,
      connecting: false,
      toolCount: 0,
      statusMessage: '已断开连接',
      statusLevel: 'info',
    };
    setMCPServers(updated);
    await refreshMCPTools();
  };

  const startEditSkill = (skillName: string, description: string, triggers: string[]) => {
    setEditingSkill(skillName);
    setSkillDescriptionDraft(description);
    setSkillTriggersDraft(triggers.join(', '));
    setSkillMetaStatus('');
  };

  const handleSaveSkillMeta = async (skillName: string) => {
    try {
      const nextTriggers = skillTriggersDraft
        .split(/[,\n，]/)
        .map(item => item.trim())
        .filter(Boolean);
      await updateSkillMeta(skillName, skillDescriptionDraft, nextTriggers);
      setSkillMetaStatus('已保存说明和标签');
      await loadSkills();
      setEditingSkill(null);
    } catch (error) {
      setSkillMetaStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToolRun = async () => {
    if (!selectedTool) return;
    const [serverName, toolName] = selectedTool.split(':');
    if (!serverName || !toolName) return;

    setToolRunning(true);
    try {
      const args = toolArgs.trim() ? JSON.parse(toolArgs) : {};
      const result = await callMCPTool(serverName, toolName, args);
      setToolResult(JSON.stringify(result, null, 2));
    } catch (error) {
      setToolResult(error instanceof Error ? error.message : String(error));
    } finally {
      setToolRunning(false);
    }
  };

  const toggleMcpExpanded = (serverName: string) => {
    setExpandedMCP(current => ({ ...current, [serverName]: !current[serverName] }));
  };

  const beginEditMcp = (server: MCPServer) => {
    setExpandedMCP(current => ({ ...current, [server.name]: true }));
    setEditingMCP(server.name);
    setMcpEditDrafts(current => ({
      ...current,
      [server.name]: {
        transport: server.transport || 'stdio',
        command: server.command || '',
        args: (server.args || []).join(' '),
        url: server.url || '',
        headers: JSON.stringify(server.headers || {}, null, 2),
        riskLevel: server.riskLevel || 'read-only',
        toolRiskOverrides: JSON.stringify(server.toolRiskOverrides || {}, null, 2),
      },
    }));
  };

  const cancelEditMcp = (server: MCPServer) => {
    setEditingMCP(current => (current === server.name ? null : current));
    setMcpEditDrafts(current => ({
      ...current,
      [server.name]: {
        transport: server.transport || 'stdio',
        command: server.command || '',
        args: (server.args || []).join(' '),
        url: server.url || '',
        headers: JSON.stringify(server.headers || {}, null, 2),
        riskLevel: server.riskLevel || 'read-only',
        toolRiskOverrides: JSON.stringify(server.toolRiskOverrides || {}, null, 2),
      },
    }));
  };

  const saveMcpEdit = (index: number, server: MCPServer) => {
    const draft = mcpEditDrafts[server.name];
    if (!draft) return;
    let parsedHeaders: Record<string, string> = {};
    let parsedOverrides: Record<string, 'read-only' | 'state-change' | 'destructive'> = {};
    try {
      parsedHeaders = draft.headers.trim() ? JSON.parse(draft.headers) : {};
      parsedOverrides = draft.toolRiskOverrides.trim() ? JSON.parse(draft.toolRiskOverrides) : {};
    } catch (error) {
      console.error('invalid MCP edit JSON:', error);
      updateMcpServer(index, {
        statusMessage: `保存失败：${error instanceof Error ? error.message : String(error)}`,
        statusLevel: 'error',
      });
      return;
    }

    updateMcpServer(index, {
      transport: draft.transport,
      command: draft.command.trim(),
      args: draft.args.split(' ').filter(Boolean),
      url: draft.transport === 'streamable-http' ? (draft.url.trim() || undefined) : undefined,
      headers: draft.transport === 'streamable-http' && Object.keys(parsedHeaders).length ? parsedHeaders : undefined,
      riskLevel: draft.riskLevel,
      toolRiskOverrides: parsedOverrides,
      statusMessage: '已保存 MCP 配置',
      statusLevel: 'success',
    });
    setEditingMCP(current => (current === server.name ? null : current));
  };

  return (
    <div>
      <div className="tab-bar" style={{ marginBottom: 12 }}>
        <button className={`tab-btn${tab === 'skills' ? ' active' : ''}`} onClick={() => setTab('skills')}>Skills</button>
        <button className={`tab-btn${tab === 'mcp' ? ' active' : ''}`} onClick={() => setTab('mcp')}>MCP Servers</button>
      </div>

      {tab === 'skills' && (
        <div>
          <div className="skills-toolbar">
            <div className="skills-upload-rail">
              <div className="skills-upload-copy">
                <span className="skills-upload-title">上传 Skill</span>
              </div>
              <div className="skills-upload-actions">
                <div className="skills-upload-info-wrap">
                  <button
                    className="skills-upload-info-btn"
                    type="button"
                    aria-label="查看 Skill 上传说明"
                    onClick={() => setShowSkillUploadInfo(value => !value)}
                  >
                    <AlertCircle size={14} />
                  </button>
                  {showSkillUploadInfo && (
                    <div className="skills-upload-tooltip">
                      当前支持读取项目内置 Skills、启用或停用，以及编辑说明和标签。Skill 安装包上传和服务端执行链会在后续后端迁移阶段接入。
                    </div>
                  )}
                </div>
                <button className="btn btn-ghost skills-upload-btn" type="button" disabled title="上传能力将在后端执行链接入后开放">
                  <Plus size={12} />
                  上传
                </button>
              </div>
            </div>

            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={loadSkills} disabled={skillsLoading}>
              <RefreshCw size={12} className={skillsLoading ? 'animate-spin' : ''} />
              刷新
            </button>
          </div>

          {skillMetaStatus && (
            <div className={skillMetaStatus === '已保存说明和标签' ? 'model-fetch-hint' : 'model-fetch-error'} style={{ marginBottom: 8 }}>
              {skillMetaStatus}
            </div>
          )}

          {skills.length === 0 && !skillsLoading && (
            <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
              未找到 Skills<br />
              <span style={{ fontSize: 11 }}>当前会扫描项目内置 Skills；后续服务端接入后再补安装与执行链。</span>
            </div>
          )}

          {skills.map(sk => (
            <div key={sk.name} className="tool-card">
              <div className="tool-card-header">
                <span className="tool-card-name">{sk.name}</span>
                <span className="badge badge-muted">v{sk.version}</span>
                <label className="toggle" style={{ marginLeft: 'auto' }}>
                  <input type="checkbox" checked={sk.enabled} onChange={() => toggleSkill(sk.name)} />
                  <div className="toggle-track" />
                  <div className="toggle-thumb" />
                </label>
                <button className="btn-icon" onClick={() => startEditSkill(sk.name, sk.description, sk.triggers)} title="编辑说明和标签">
                  <PencilLine size={12} />
                </button>
              </div>
              {editingSkill === sk.name ? (
                <div className="skill-meta-editor">
                  <div className="form-row">
                    <label className="label">说明</label>
                    <textarea
                      className="input"
                      style={{ minHeight: 72, padding: 12, resize: 'vertical' }}
                      value={skillDescriptionDraft}
                      onChange={e => setSkillDescriptionDraft(e.target.value)}
                      placeholder="描述这个 Skill 的用途"
                    />
                  </div>
                  <div className="form-row">
                    <label className="label">标签</label>
                    <input
                      className="input"
                      value={skillTriggersDraft}
                      onChange={e => setSkillTriggersDraft(e.target.value)}
                      placeholder="用逗号分隔，例如：分析日志, 日志搜索"
                    />
                  </div>
                  <div className="skill-meta-editor-actions">
                    <button className="btn btn-ghost" onClick={() => setEditingSkill(null)}>
                      <X size={12} />
                      取消
                    </button>
                    <button className="btn btn-primary" onClick={() => handleSaveSkillMeta(sk.name)}>
                      <Save size={12} />
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="tool-card-desc">{sk.description}</div>
                  {sk.triggers.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {sk.triggers.slice(0, 4).map(t => (
                        <span key={t} className="badge badge-muted" style={{ fontSize: 10 }}>{t}</span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'mcp' && (
        <div>
          {mcpServers.map((s, i) => (
            <div key={s.name} className={`tool-card mcp-server-card${expandedMCP[s.name] ? ' expanded' : ' collapsed'}`}>
              <div className="tool-card-header mcp-server-summary">
                <div className="mcp-server-summary-main">
                  <span className="tool-card-name">{s.name}</span>
                  <div className="mcp-server-tags">
                    <span className="badge badge-muted">{s.transport || 'stdio'}</span>
                    {s.connected
                      ? <span className="badge badge-success"><Zap size={10} /> {s.toolCount} tools</span>
                      : <span className="badge badge-muted">未连接</span>}
                  </div>
                </div>
                <div className="mcp-server-actions">
                  {s.connected ? (
                    <button className="btn-icon" title="断开 MCP Server" onClick={() => handleMCPDisconnect(i)}>
                      <Wifi size={12} />
                    </button>
                  ) : (
                    <button className="btn-icon" title={s.connecting ? '连接中...' : '连接 MCP Server'} onClick={() => handleMCPConnect(i)} disabled={s.connecting}>
                      <WifiOff size={12} />
                    </button>
                  )}
                  <button className="btn-icon" title="编辑 MCP Server" onClick={() => beginEditMcp(s)}>
                    <PencilLine size={12} />
                  </button>
                  <button className="btn-icon" title={expandedMCP[s.name] ? '收起' : '展开'} onClick={() => toggleMcpExpanded(s.name)}>
                    {expandedMCP[s.name] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <button className="btn-icon" style={{ color: 'var(--danger)' }} title="删除 MCP Server"
                    onClick={async () => {
                      if (s.connected) {
                        await handleMCPDisconnect(i);
                      }
                      setMCPServers(mcpServers.filter((_, idx) => idx !== i));
                    }}>
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>

              {expandedMCP[s.name] && (
                <div className="mcp-server-body">
                  {editingMCP === s.name ? (
                    <>
                      <div className="form-row">
                        <label className="label">传输方式</label>
                        <select
                          className="input"
                          value={mcpEditDrafts[s.name]?.transport || 'stdio'}
                          onChange={e => setMcpEditDrafts(current => ({
                            ...current,
                            [s.name]: { ...current[s.name], transport: e.target.value as 'stdio' | 'streamable-http' },
                          }))}
                        >
                          <option value="streamable-http">streamable-http</option>
                          <option value="stdio">stdio</option>
                        </select>
                      </div>
                      {(mcpEditDrafts[s.name]?.transport || 'stdio') === 'streamable-http' ? (
                        <>
                          <div className="form-row">
                            <label className="label">URL</label>
                            <input
                              className="input"
                              value={mcpEditDrafts[s.name]?.url || ''}
                              onChange={e => setMcpEditDrafts(current => ({
                                ...current,
                                [s.name]: { ...current[s.name], url: e.target.value },
                              }))}
                              placeholder="https://example.com/mcp"
                            />
                          </div>
                          <div className="form-row">
                            <label className="label">请求头（JSON）</label>
                            <textarea
                              className="input"
                              style={{ minHeight: 84, padding: 12, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                              value={mcpEditDrafts[s.name]?.headers || '{}'}
                              onChange={e => setMcpEditDrafts(current => ({
                                ...current,
                                [s.name]: { ...current[s.name], headers: e.target.value },
                              }))}
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="form-row">
                            <label className="label">命令</label>
                            <input
                              className="input"
                              value={mcpEditDrafts[s.name]?.command || ''}
                              onChange={e => setMcpEditDrafts(current => ({
                                ...current,
                                [s.name]: { ...current[s.name], command: e.target.value },
                              }))}
                              placeholder="npx"
                            />
                          </div>
                          <div className="form-row">
                            <label className="label">参数（空格分隔）</label>
                            <input
                              className="input"
                              value={mcpEditDrafts[s.name]?.args || ''}
                              onChange={e => setMcpEditDrafts(current => ({
                                ...current,
                                [s.name]: { ...current[s.name], args: e.target.value },
                              }))}
                              placeholder="-y @modelcontextprotocol/server-filesystem"
                            />
                          </div>
                        </>
                      )}
                      <div className="form-row">
                        <label className="label">默认风险级别</label>
                        <select
                          className="input"
                          value={mcpEditDrafts[s.name]?.riskLevel || 'read-only'}
                          onChange={e => setMcpEditDrafts(current => ({
                            ...current,
                            [s.name]: { ...current[s.name], riskLevel: e.target.value as 'read-only' | 'state-change' | 'destructive' },
                          }))}
                        >
                          <option value="read-only">只读</option>
                          <option value="state-change">状态变更</option>
                          <option value="destructive">高风险</option>
                        </select>
                      </div>
                      <div className="form-row">
                        <label className="label">工具风险覆盖（JSON）</label>
                        <textarea
                          className="input"
                          style={{ minHeight: 84, padding: 12, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                          value={mcpEditDrafts[s.name]?.toolRiskOverrides || '{}'}
                          onChange={e => setMcpEditDrafts(current => ({
                            ...current,
                            [s.name]: { ...current[s.name], toolRiskOverrides: e.target.value },
                          }))}
                        />
                      </div>
                      <div className="skill-meta-editor-actions">
                        <button className="btn btn-ghost" onClick={() => cancelEditMcp(s)}>
                          <X size={12} />
                          取消
                        </button>
                        <button className="btn btn-primary" onClick={() => saveMcpEdit(i, s)}>
                          <Save size={12} />
                          保存
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="tool-card-desc mcp-server-desc" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {s.transport === 'streamable-http'
                          ? `streamable-http ${s.url || '(未配置 URL)'}`
                          : `${s.command} ${s.args.join(' ')}`}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        {s.url && <span className="badge badge-muted">{s.url}</span>}
                        <span className="badge badge-muted">{s.riskLevel === 'destructive' ? '高风险' : s.riskLevel === 'state-change' ? '状态变更' : '只读'}</span>
                      </div>
                    </>
                  )}
                  {s.statusMessage && (
                    <div className={`mcp-status-note ${s.statusLevel || 'idle'}`}>
                      {s.statusMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {mcpTools.length > 0 && (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginTop: 10 }}>
              <div className="form-row">
                <label className="label">已发现工具</label>
                <select className="input" value={selectedTool} onChange={e => setSelectedTool(e.target.value)}>
                  {mcpTools.map(tool => (
                    <option key={`${tool.serverName}:${tool.name}`} value={`${tool.serverName}:${tool.name}`}>
                      {tool.serverName} / {tool.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="label">参数（JSON）</label>
                <textarea
                  className="input"
                  style={{ minHeight: 92, padding: 12, resize: 'vertical' }}
                  value={toolArgs}
                  onChange={e => setToolArgs(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button className="btn btn-primary" onClick={handleToolRun} disabled={toolRunning || !selectedTool}>
                  <Play size={12} />
                  {toolRunning ? '执行中...' : '执行工具'}
                </button>
              </div>
              {toolResult && (
                <pre className="tool-result-block">{toolResult}</pre>
              )}
            </div>
          )}

          {showAddMCP ? (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 4 }}>
              <div className="form-row"><label className="label">名称</label><input className="input" value={newMCP.name} onChange={e => setNewMCP(s => ({ ...s, name: e.target.value }))} placeholder="filesystem" /></div>
              <div className="form-row"><label className="label">传输方式</label>
                <select className="input" value={newMCP.transport} onChange={e => setNewMCP(s => ({ ...s, transport: e.target.value }))}>
                  <option value="streamable-http">streamable-http</option>
                  <option value="stdio">stdio</option>
                </select>
              </div>
              {newMCP.transport === 'streamable-http' ? (
                <>
                  <div className="form-row"><label className="label">URL</label><input className="input" value={newMCP.url} onChange={e => setNewMCP(s => ({ ...s, url: e.target.value }))} placeholder="https://example.com/mcp" /></div>
                  <div className="form-row"><label className="label">请求头（JSON）</label>
                    <textarea
                      className="input"
                      style={{ minHeight: 84, padding: 12, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                      value={newMCP.headers}
                      onChange={e => setNewMCP(s => ({ ...s, headers: e.target.value }))}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row"><label className="label">命令</label><input className="input" value={newMCP.command} onChange={e => setNewMCP(s => ({ ...s, command: e.target.value }))} placeholder="npx" /></div>
                  <div className="form-row"><label className="label">参数（空格分隔）</label><input className="input" value={newMCP.args} onChange={e => setNewMCP(s => ({ ...s, args: e.target.value }))} placeholder="-y @modelcontextprotocol/server-filesystem" /></div>
                </>
              )}
              <div className="form-row"><label className="label">默认风险级别</label>
                <select className="input" value={newMCP.riskLevel} onChange={e => setNewMCP(s => ({ ...s, riskLevel: e.target.value }))}>
                  <option value="read-only">只读</option>
                  <option value="state-change">状态变更</option>
                  <option value="destructive">高风险</option>
                </select>
              </div>
              <div className="form-row"><label className="label">工具风险覆盖（JSON）</label>
                <textarea
                  className="input"
                  style={{ minHeight: 84, padding: 12, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  value={newMCP.toolRiskOverrides}
                  onChange={e => setNewMCP(s => ({ ...s, toolRiskOverrides: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddMCP(false)}>取消</button>
                <button className="btn btn-primary" style={{ flex: 1 }}
                  onClick={() => {
                    if (!newMCP.name) return;
                    let parsedOverrides: Record<string, 'read-only' | 'state-change' | 'destructive'> = {};
                    let parsedHeaders: Record<string, string> = {};
                    try {
                      parsedOverrides = newMCP.toolRiskOverrides.trim() ? JSON.parse(newMCP.toolRiskOverrides) : {};
                    } catch (error) {
                      console.error('invalid MCP tool risk overrides json:', error);
                      return;
                    }
                    try {
                      parsedHeaders = newMCP.headers.trim() ? JSON.parse(newMCP.headers) : {};
                    } catch (error) {
                      console.error('invalid MCP headers json:', error);
                      return;
                    }
                    if (newMCP.transport === 'streamable-http' && !newMCP.url.trim()) return;
                    if (newMCP.transport === 'stdio' && !newMCP.command.trim()) return;
                    setMCPServers([
                      ...mcpServers,
                      {
                        name: newMCP.name,
                        transport: newMCP.transport as MCPServer['transport'],
                        command: newMCP.command,
                        args: newMCP.args.split(' ').filter(Boolean),
                        url: newMCP.url.trim() || undefined,
                        headers: Object.keys(parsedHeaders).length ? parsedHeaders : undefined,
                        enabled: true,
                        connected: false,
                        connecting: false,
                        toolCount: 0,
                        riskLevel: newMCP.riskLevel as 'read-only' | 'state-change' | 'destructive',
                        toolRiskOverrides: parsedOverrides,
                      },
                    ]);
                    setNewMCP({ name: '', transport: 'streamable-http', command: '', args: '', url: '', headers: '{}', riskLevel: 'read-only', toolRiskOverrides: '{}' });
                    setShowAddMCP(false);
                  }}>添加</button>
              </div>
            </div>
          ) : (
            <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 6, borderStyle: 'dashed', border: '1px dashed var(--border)' }}
              onClick={() => setShowAddMCP(true)}>
              <Plus size={12} /> 添加 MCP Server
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolsPanel;
