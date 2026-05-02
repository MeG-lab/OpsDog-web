import React from 'react';
import { RefreshCw, Plus, Wifi, WifiOff, Zap, Trash2, Play, PencilLine, Save, X } from 'lucide-react';
import { useAppStore } from '../../stores';
import { isWebRuntime, scanSkills, updateSkillMeta, connectMCPServer, disconnectMCPServer, callMCPTool, listMCPTools, getMCPStatus } from '../../services/runtime';

type TabId = 'skills' | 'mcp';

const ToolsPanel: React.FC = () => {
  const [tab, setTab] = React.useState<TabId>('skills');
  const { skills, skillsLoading, setSkills, toggleSkill, setSkillsLoading, mcpServers, setMCPServers } = useAppStore();
  const [editingSkill, setEditingSkill] = React.useState<string | null>(null);
  const [skillDescriptionDraft, setSkillDescriptionDraft] = React.useState('');
  const [skillTriggersDraft, setSkillTriggersDraft] = React.useState('');
  const [skillMetaStatus, setSkillMetaStatus] = React.useState('');

  // MCP state
  const [showAddMCP, setShowAddMCP] = React.useState(false);
  const [newMCP, setNewMCP] = React.useState({ name: '', command: '', args: '', riskLevel: 'read-only', toolRiskOverrides: '{}' });
  const [mcpTools, setMcpTools] = React.useState<Array<{ name: string; description: string; serverName: string }>>([]);
  const [selectedTool, setSelectedTool] = React.useState('');
  const [toolArgs, setToolArgs] = React.useState('{}');
  const [toolResult, setToolResult] = React.useState('');
  const [toolRunning, setToolRunning] = React.useState(false);
  const [mcpPanelStatus, setMcpPanelStatus] = React.useState('');
  const [mcpOverrideDrafts, setMcpOverrideDrafts] = React.useState<Record<string, string>>({});

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
    setMcpOverrideDrafts(Object.fromEntries(
      mcpServers.map(server => [
        server.name,
        JSON.stringify(server.toolRiskOverrides || {}, null, 2),
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

  const handleMCPConnect = async (idx: number) => {
    if (isWebRuntime) {
      setMcpPanelStatus('网页端当前没有本地 MCP 子进程能力，所以这里还不能真正连接 Server。后续需要把 MCP 迁成服务端代理。');
      return;
    }
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
    if (isWebRuntime) {
      setMcpPanelStatus('网页端当前没有活动的本地 MCP 连接可断开。');
      return;
    }
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
    if (isWebRuntime) {
      setToolResult('网页端当前还不能直接执行 MCP 工具。要保留这项能力，后面需要把 MCP Server 和 tool call 迁到服务端。');
      return;
    }
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

  const updateMcpServer = (index: number, updates: Partial<typeof mcpServers[number]>) => {
    const updated = [...mcpServers];
    updated[index] = { ...updated[index], ...updates };
    setMCPServers(updated);
  };

  const handleMcpOverridesBlur = (index: number, serverName: string) => {
    const draft = mcpOverrideDrafts[serverName] ?? '{}';
    try {
      const parsed = draft.trim() ? JSON.parse(draft) : {};
      updateMcpServer(index, { toolRiskOverrides: parsed });
    } catch (error) {
      console.error('invalid MCP tool risk overrides json:', error);
    }
  };

  return (
    <div>
      <div className="tab-bar" style={{ marginBottom: 12 }}>
        <button className={`tab-btn${tab === 'skills' ? ' active' : ''}`} onClick={() => setTab('skills')}>Skills</button>
        <button className={`tab-btn${tab === 'mcp' ? ' active' : ''}`} onClick={() => setTab('mcp')}>MCP Servers</button>
      </div>

      {tab === 'skills' && (
        <div>
          <div className="skills-help-card" style={{ marginBottom: 8 }}>
            <div className="skills-help-title">当前版本范围</div>
            <div className="skills-help-copy">
              当前网页端支持读取项目内置 Skills、查看说明、启用或停用、编辑说明和标签覆盖层。安装包上传、删除和服务端执行链会在后续后端迁移阶段接入。
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={loadSkills} disabled={skillsLoading}>
              <RefreshCw size={12} className={skillsLoading ? 'animate-spin' : ''} />
              刷新
            </button>
          </div>

          <div className="skills-help-card">
            <div className="skills-help-title">说明和标签怎么自定义</div>
            <div className="skills-help-copy">
              `说明` 对应 `skill.yaml` 里的 `description`，`标签` 对应 `triggers`。现在也可以直接在下方 Skill 卡片里点编辑修改。
            </div>
            <pre className="skills-help-code">{`description: 智能日志分析工具
triggers:
  - 分析日志
  - 日志搜索
  - 查看错误日志`}</pre>
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
          {isWebRuntime && (
            <div className="skills-help-card" style={{ marginBottom: 8 }}>
              <div className="skills-help-title">网页模式说明</div>
              <div className="skills-help-copy">
                浏览器里不能像桌面端那样直接拉起本地 MCP 子进程，所以当前面板以配置展示为主。真正连接和调用工具，后面需要迁到服务端代理。
              </div>
            </div>
          )}

          {mcpPanelStatus && (
            <div className="model-fetch-hint" style={{ marginBottom: 8 }}>
              {mcpPanelStatus}
            </div>
          )}

          {mcpServers.map((s, i) => (
            <div key={s.name} className="tool-card">
              <div className="tool-card-header">
                <span className="tool-card-name">{s.name}</span>
                {s.connected && <span className="badge badge-success"><Zap size={10} /> {s.toolCount} tools</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {s.connected ? (
                    <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--success)' }}
                      onClick={() => handleMCPDisconnect(i)}>
                      <Wifi size={11} /> 已连接
                    </button>
                  ) : (
                    <button className="btn btn-ghost" style={{ fontSize: 11 }}
                      onClick={() => handleMCPConnect(i)} disabled={s.connecting}>
                      <WifiOff size={11} /> {s.connecting ? '连接中...' : '连接'}
                    </button>
                  )}
                  <button className="btn-icon" style={{ width: 22, height: 22, padding: 3, color: 'var(--danger)' }}
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
              <div className="tool-card-desc" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {s.command} {s.args.join(' ')}
              </div>
              <div className="form-row" style={{ marginTop: 8 }}>
                <label className="label">默认风险级别</label>
                <select
                  className="input"
                  value={s.riskLevel || 'read-only'}
                  onChange={e => updateMcpServer(i, { riskLevel: e.target.value as typeof s.riskLevel })}
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
                  value={mcpOverrideDrafts[s.name] ?? '{}'}
                  onChange={e => setMcpOverrideDrafts(current => ({ ...current, [s.name]: e.target.value }))}
                  onBlur={() => handleMcpOverridesBlur(i, s.name)}
                />
              </div>
              {s.statusMessage && (
                <div className={`mcp-status-note ${s.statusLevel || 'idle'}`}>
                  {s.statusMessage}
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
              <div className="form-row"><label className="label">命令</label><input className="input" value={newMCP.command} onChange={e => setNewMCP(s => ({ ...s, command: e.target.value }))} placeholder="npx" /></div>
              <div className="form-row"><label className="label">参数（空格分隔）</label><input className="input" value={newMCP.args} onChange={e => setNewMCP(s => ({ ...s, args: e.target.value }))} placeholder="-y @modelcontextprotocol/server-filesystem" /></div>
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
                    if (!newMCP.name || !newMCP.command) return;
                    let parsedOverrides: Record<string, 'read-only' | 'state-change' | 'destructive'> = {};
                    try {
                      parsedOverrides = newMCP.toolRiskOverrides.trim() ? JSON.parse(newMCP.toolRiskOverrides) : {};
                    } catch (error) {
                      console.error('invalid MCP tool risk overrides json:', error);
                      return;
                    }
                    setMCPServers([
                      ...mcpServers,
                      {
                        name: newMCP.name,
                        command: newMCP.command,
                        args: newMCP.args.split(' ').filter(Boolean),
                        enabled: true,
                        connected: false,
                        connecting: false,
                        toolCount: 0,
                        riskLevel: newMCP.riskLevel as 'read-only' | 'state-change' | 'destructive',
                        toolRiskOverrides: parsedOverrides,
                      },
                    ]);
                    setNewMCP({ name: '', command: '', args: '', riskLevel: 'read-only', toolRiskOverrides: '{}' });
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
