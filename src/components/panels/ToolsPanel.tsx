import React from 'react';
import { Cable, FileJson, Package2, Pencil, Plus, RefreshCw, Save, ShoppingBag, Trash2, Upload } from 'lucide-react';
import { useAppStore } from '../../stores';
import {
  connectMCPServerByName,
  createMCPServer,
  createSkill,
  deleteMCPServer,
  deleteSkill,
  disconnectMCPServerByName,
  importMCPServerDxt,
  importMCPServersJson,
  installMCPMarketItem,
  listMCPMarket,
  listMCPServers,
  listServers,
  scanSkills,
  updateMCPServer,
  updateSkillMeta,
} from '../../services/runtime';
import type { MCPMarketItem, MCPServerRecord, ServerDefinition } from '../../types';
import { mapSkillRecord } from '../../services/skillRecords';

const getServerTools = (server: ServerDefinition | null | undefined) =>
  Array.isArray(server?.capabilities?.tools) ? server.capabilities.tools : [];

const parseLineList = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const parseKeyValueLines = (value: string) => Object.fromEntries(
  parseLineList(value)
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator === -1) return null;
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
    .filter(Boolean) as Array<[string, string]>,
);
const stringifyKeyValueLines = (value: Record<string, string> | null | undefined) =>
  Object.entries(value || {}).map(([key, item]) => `${key}=${item}`).join('\n');
const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== 'string') {
      reject(new Error('文件读取失败。'));
      return;
    }
    const marker = 'base64,';
    const markerIndex = result.indexOf(marker);
    if (markerIndex === -1) {
      reject(new Error('文件读取失败。'));
      return;
    }
    resolve(result.slice(markerIndex + marker.length));
  };
  reader.onerror = () => reject(new Error('文件读取失败。'));
  reader.readAsDataURL(file);
});

const emptyMcpDraft = {
  name: '',
  description: '',
  transport: 'stdio' as 'stdio' | 'streamable-http',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '{}',
  riskLevel: 'read-only' as 'read-only' | 'state-change' | 'destructive',
};

const providerItems = [
  { id: 'aliyun', name: '阿里云百炼', description: '当前默认推荐模型提供商。' },
  { id: 'custom', name: '自定义 OpenAI 兼容源', description: '适用于自建或第三方兼容接口。' },
];

const ToolsPanel: React.FC = () => {
  const {
    skills,
    skillsLoading,
    skillsError,
    setSkills,
    toggleSkill,
    setSkillsLoading,
    setSkillsError,
    servers,
    setServers,
    toolsPanelTab,
    setToolsPanelTab,
  } = useAppStore();

  const [editingSkill, setEditingSkill] = React.useState<string | null>(null);
  const [newSkillNameDraft, setNewSkillNameDraft] = React.useState('');
  const [skillDescriptionDraft, setSkillDescriptionDraft] = React.useState('');
  const [skillTriggersDraft, setSkillTriggersDraft] = React.useState('');
  const [skillServerIdDraft, setSkillServerIdDraft] = React.useState('');
  const [skillToolNameDraft, setSkillToolNameDraft] = React.useState('');
  const [skillMetaStatus, setSkillMetaStatus] = React.useState('');

  const [mcpView, setMcpView] = React.useState<'servers' | 'builtins' | 'market' | 'providers'>('servers');
  const [mcpServers, setMcpServers] = React.useState<MCPServerRecord[]>([]);
  const [mcpMarket, setMcpMarket] = React.useState<MCPMarketItem[]>([]);
  const [mcpLoading, setMcpLoading] = React.useState(false);
  const [mcpMessage, setMcpMessage] = React.useState('');
  const [selectedMcpName, setSelectedMcpName] = React.useState('');
  const [selectedBuiltinId, setSelectedBuiltinId] = React.useState('');
  const [editingMcpName, setEditingMcpName] = React.useState<string | null>(null);
  const [showJsonImport, setShowJsonImport] = React.useState(false);
  const [showDxtImport, setShowDxtImport] = React.useState(false);
  const [jsonImportText, setJsonImportText] = React.useState('');
  const [dxtFile, setDxtFile] = React.useState<File | null>(null);
  const [mcpDraft, setMcpDraft] = React.useState(emptyMcpDraft);
  const mcpMessageTone = React.useMemo<'info' | 'success' | 'error'>(() => {
    const text = mcpMessage.toLowerCase();
    if (!text) return 'info';
    if (text.includes('成功') || text.includes('已') || text.includes('created') || text.includes('saved')) return 'success';
    if (text.includes('error') || text.includes('失败') || text.includes('not found') || text.includes('route')) return 'error';
    return 'info';
  }, [mcpMessage]);

  const loadSkills = React.useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const raw = await scanSkills();
      const currentSkills = useAppStore.getState().skills;
      const mapped = raw.map((s: any) => mapSkillRecord(s, currentSkills.find(sk => sk.name === s.name)?.enabled ?? true));
      setSkills(mapped);
    } catch (error) {
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

  const refreshMcp = React.useCallback(async () => {
    setMcpLoading(true);
    try {
      const [nextServers, nextMarket] = await Promise.all([listMCPServers(), listMCPMarket()]);
      setMcpServers(nextServers);
      setMcpMarket(nextMarket);
      if (!selectedMcpName && nextServers[0]) {
        setSelectedMcpName(nextServers[0].name);
      }
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMcpLoading(false);
    }
  }, [selectedMcpName]);

  React.useEffect(() => {
    void loadSkills();
    void refreshServers();
    void refreshMcp();
  }, [loadSkills, refreshServers, refreshMcp]);

  const serverOptions = React.useMemo(
    () => servers.filter((server) => server.enabled !== false),
    [servers],
  );

  const startEditSkill = (skillName: string, description: string, triggers: string[], serverId: string, toolName?: string) => {
    setEditingSkill(skillName);
    setSkillDescriptionDraft(description);
    setSkillTriggersDraft(triggers.join(', '));
    setSkillServerIdDraft(serverId || '');
    setSkillToolNameDraft(toolName || '');
    setSkillMetaStatus('');
  };

  const startCreateSkill = () => {
    setEditingSkill('__new__');
    setNewSkillNameDraft('');
    setSkillDescriptionDraft('');
    setSkillTriggersDraft('');
    setSkillServerIdDraft(serverOptions[0]?.id || '');
    setSkillToolNameDraft('');
    setSkillMetaStatus('');
  };

  const editingServer = serverOptions.find((server) => server.id === skillServerIdDraft) || null;
  const editingServerTools = getServerTools(editingServer);
  const editingDefaultTools = editingServerTools.filter((tool) => tool.isDefault);
  const editingToolSelectionRequired = Boolean(
    editingServer &&
    !(editingDefaultTools.length === 1 || editingServerTools.length === 1),
  );

  const handleSaveSkillMeta = async (skillName: string) => {
    try {
      const creating = skillName === '__new__';
      const nextSkillName = newSkillNameDraft.trim();
      if (creating && !nextSkillName) {
        setSkillMetaStatus('请先填写 Skill 名称。');
        return;
      }
      const trimmedServerId = skillServerIdDraft.trim();
      if (!trimmedServerId) {
        setSkillMetaStatus('请先选择一个 Server。');
        return;
      }
      if (editingToolSelectionRequired && !skillToolNameDraft.trim()) {
        setSkillMetaStatus('当前 Server 没有唯一默认工具，请显式选择一个 Tool。');
        return;
      }
      const nextTriggers = skillTriggersDraft.split(/[,\n，]/).map(item => item.trim()).filter(Boolean);
      if (creating) {
        await createSkill({
          name: nextSkillName,
          description: skillDescriptionDraft,
          triggers: nextTriggers,
          serverId: trimmedServerId,
          toolName: skillToolNameDraft.trim() || null,
        });
        setSkillMetaStatus('已创建 Skill');
      } else {
        await updateSkillMeta(skillName, {
          description: skillDescriptionDraft,
          triggers: nextTriggers,
          serverId: trimmedServerId,
          toolName: skillToolNameDraft.trim() || null,
        });
        setSkillMetaStatus('已保存 Skill');
      }
      await loadSkills();
      setEditingSkill(null);
    } catch (error) {
      setSkillMetaStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDeleteSkill = async (skillName: string) => {
    if (!window.confirm(`确定删除 Skill ${skillName} 吗？这会删除对应的 Skill 文件夹。`)) return;
    try {
      await deleteSkill(skillName);
      setSkillMetaStatus(`已删除 Skill：${skillName}`);
      if (editingSkill === skillName) setEditingSkill(null);
      await loadSkills();
    } catch (error) {
      setSkillMetaStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const selectedMcp = mcpServers.find((server) => server.name === selectedMcpName) || mcpServers[0] || null;
  const builtinServers = React.useMemo(
    () => servers.filter((server) => server.category === 'system'),
    [servers],
  );
  const selectedBuiltin = builtinServers.find((server) => server.id === selectedBuiltinId) || builtinServers[0] || null;
  const showMcpSplitPane = Boolean(mcpServers.length > 0 || editingMcpName || selectedMcp);

  React.useEffect(() => {
    if (!selectedMcp) return;
    if (!selectedMcpName) {
      setSelectedMcpName(selectedMcp.name);
    }
    if (editingMcpName !== selectedMcp.name) return;
    setMcpDraft({
      name: selectedMcp.name,
      description: selectedMcp.description || '',
      transport: selectedMcp.transport,
      command: selectedMcp.command || '',
      argsText: (selectedMcp.args || []).join('\n'),
      envText: stringifyKeyValueLines(selectedMcp.env),
      url: selectedMcp.url || '',
      headersText: JSON.stringify(selectedMcp.headers || {}, null, 2),
      riskLevel: selectedMcp.riskLevel || 'read-only',
    });
  }, [selectedMcp, selectedMcpName, editingMcpName]);

  React.useEffect(() => {
    if (!selectedBuiltin) return;
    if (!selectedBuiltinId) {
      setSelectedBuiltinId(selectedBuiltin.id);
    }
  }, [selectedBuiltin, selectedBuiltinId]);

  const startCreateMcp = () => {
    setEditingMcpName('__new__');
    setSelectedMcpName('');
    setMcpDraft(emptyMcpDraft);
    setMcpMessage('');
  };

  const startEditMcp = (record: MCPServerRecord) => {
    setEditingMcpName(record.name);
    setSelectedMcpName(record.name);
    setMcpDraft({
      name: record.name,
      description: record.description || '',
      transport: record.transport,
      command: record.command || '',
      argsText: (record.args || []).join('\n'),
      envText: stringifyKeyValueLines(record.env),
      url: record.url || '',
      headersText: JSON.stringify(record.headers || {}, null, 2),
      riskLevel: record.riskLevel || 'read-only',
    });
    setMcpMessage('');
  };

  const saveMcp = async () => {
    try {
      const payload = {
        name: mcpDraft.name.trim(),
        description: mcpDraft.description.trim(),
        transport: mcpDraft.transport,
        command: mcpDraft.command.trim(),
        args: parseLineList(mcpDraft.argsText),
        env: parseKeyValueLines(mcpDraft.envText),
        url: mcpDraft.url.trim(),
        headers: JSON.parse(mcpDraft.headersText || '{}'),
        riskLevel: mcpDraft.riskLevel,
      };
      if (editingMcpName === '__new__') {
        const created = await createMCPServer(payload);
        setSelectedMcpName(created.name);
        setMcpMessage(`已创建 MCP 服务：${created.name}`);
      } else if (editingMcpName) {
        const updated = await updateMCPServer(editingMcpName, payload);
        setSelectedMcpName(updated.name);
        setMcpMessage(`已保存 MCP 服务：${updated.name}`);
      }
      setEditingMcpName(null);
      await refreshMcp();
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDeleteMcp = async (name: string) => {
    if (!window.confirm(`确定删除 MCP 服务 ${name} 吗？`)) return;
    try {
      await deleteMCPServer(name);
      setMcpMessage(`已删除 MCP 服务：${name}`);
      if (selectedMcpName === name) setSelectedMcpName('');
      if (editingMcpName === name) setEditingMcpName(null);
      await refreshMcp();
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleConnection = async (record: MCPServerRecord) => {
    try {
      if (record.connected) {
        await disconnectMCPServerByName(record.name);
        setMcpMessage(`已断开：${record.name}`);
      } else {
        await connectMCPServerByName(record.name);
        setMcpMessage(`已连接：${record.name}`);
      }
      await refreshMcp();
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleJsonImport = async () => {
    try {
      const result = await importMCPServersJson({ content: jsonImportText });
      setMcpMessage(`JSON 导入完成：成功 ${result.created.length} 个，失败 ${result.errors.length} 个。`);
      setShowJsonImport(false);
      setJsonImportText('');
      await refreshMcp();
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDxtImport = async () => {
    if (!dxtFile) {
      setMcpMessage('请先选择一个 .dxt 或 .mcpb 文件。');
      return;
    }
    try {
      const fileContentBase64 = await fileToBase64(dxtFile);
      const result = await importMCPServerDxt({ fileName: dxtFile.name, fileContentBase64 });
      setMcpMessage(`DXT 导入完成：成功 ${result.created.length} 个。`);
      setShowDxtImport(false);
      setDxtFile(null);
      await refreshMcp();
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleInstallMarket = async (itemId: string) => {
    try {
      const created = await installMCPMarketItem(itemId);
      setSelectedMcpName(created.name);
      setMcpMessage(`已从市场安装：${created.name}`);
      await refreshMcp();
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : String(error));
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
            <div className="toolbar-row">
              <button type="button" className="toolbar-text-btn" onClick={startCreateSkill}><Plus size={14} /><span>新增 Skill</span></button>
              <button type="button" className="toolbar-text-btn" onClick={() => void loadSkills()}><RefreshCw size={14} /><span>刷新</span></button>
            </div>
          </div>
          {skillsError && <div className="error-text">{skillsError}</div>}
          {editingSkill === '__new__' && (
            <div className="tool-card">
              <div className="tool-card-head"><div><strong>新建 Skill</strong><p>创建后会生成对应的 Skill 文件夹和 skill.yaml。</p></div></div>
              <div className="tool-card-body">
                <div className="field"><label>Skill 名称</label><input className="input" value={newSkillNameDraft} onChange={(event) => setNewSkillNameDraft(event.target.value)} placeholder="例如 current_time" /></div>
                <textarea className="textarea" rows={3} value={skillDescriptionDraft} onChange={(event) => setSkillDescriptionDraft(event.target.value)} placeholder="一句话描述用途" />
                <input className="input" value={skillTriggersDraft} onChange={(event) => setSkillTriggersDraft(event.target.value)} placeholder="触发词，逗号分隔" />
                <div className="field"><label>Server</label><select className="input" value={skillServerIdDraft} onChange={(event) => setSkillServerIdDraft(event.target.value)}><option value="">请选择 Server</option>{serverOptions.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></div>
                <div className="field"><label>Tool</label><select className="input" value={skillToolNameDraft} onChange={(event) => setSkillToolNameDraft(event.target.value)} disabled={!editingServer}><option value="">{editingToolSelectionRequired ? '请选择 Tool' : '使用默认工具'}</option>{editingServerTools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}{tool.isDefault ? ' · 默认工具' : ''}</option>)}</select></div>
                <div className="toolbar-row"><button type="button" className="toolbar-text-btn" onClick={() => void handleSaveSkillMeta('__new__')}><Save size={14} /><span>创建</span></button><button type="button" className="toolbar-text-btn" onClick={() => { setEditingSkill(null); }}><span>取消</span></button></div>
              </div>
            </div>
          )}
          {skills.map((skill) => (
            <div key={skill.name} className="tool-card">
              <div className="tool-card-head">
                <div><strong>{skill.name}</strong><p>{skill.description}</p></div>
                <label className="toggle-row tool-enable-switch"><input type="checkbox" checked={skill.enabled} onChange={() => toggleSkill(skill.name)} /><span className="tool-enable-switch-track"><span className="tool-enable-switch-thumb" /></span><span className="tool-enable-switch-label">{skill.enabled ? '启用' : '关闭'}</span></label>
              </div>
              {editingSkill === skill.name ? (
                <div className="tool-card-body">
                  <textarea className="textarea" rows={3} value={skillDescriptionDraft} onChange={(event) => setSkillDescriptionDraft(event.target.value)} />
                  <input className="input" value={skillTriggersDraft} onChange={(event) => setSkillTriggersDraft(event.target.value)} placeholder="触发词，逗号分隔" />
                  <div className="field"><label>Server</label><select className="input" value={skillServerIdDraft} onChange={(event) => { setSkillServerIdDraft(event.target.value); setSkillToolNameDraft(''); }}><option value="">请选择 Server</option>{serverOptions.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></div>
                  <div className="field"><label>Tool</label><select className="input" value={skillToolNameDraft} onChange={(event) => setSkillToolNameDraft(event.target.value)} disabled={!editingServer}><option value="">{editingToolSelectionRequired ? '请选择 Tool' : '使用默认工具'}</option>{editingServerTools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}{tool.isDefault ? ' · 默认工具' : ''}</option>)}</select></div>
                  {editingServer && <div className="toolbar-note">{editingToolSelectionRequired ? '当前 Server 没有唯一默认工具，必须显式选择一个 toolName。' : editingDefaultTools.length === 1 ? `当前默认工具：${editingDefaultTools[0].name}` : editingServerTools.length === 1 ? `当前唯一工具：${editingServerTools[0].name}` : '当前 Server 可自动解析默认工具。'}</div>}
                  <div className="toolbar-row"><button type="button" className="toolbar-text-btn" onClick={() => void handleSaveSkillMeta(skill.name)}><Save size={14} /><span>保存</span></button><button type="button" className="toolbar-text-btn" onClick={() => setEditingSkill(null)}><span>取消</span></button></div>
                </div>
              ) : (
                <div className="tool-card-body">
                  <div className="tool-chip-row">{skill.triggers.map((trigger) => <span key={trigger} className="tool-chip">{trigger}</span>)}</div>
                  <div className="toolbar-note">Server：{skill.serverId || '未绑定'} / Tool：{skill.toolName || skill.resolvedToolName || '默认工具'} / 状态：{skill.bindingStatus || 'unknown'}</div>
                  {skill.bindingError && <div className="error-text">{skill.bindingError}</div>}
                  <div className="toolbar-row"><button type="button" className="toolbar-text-btn" onClick={() => startEditSkill(skill.name, skill.description, skill.triggers, skill.serverId, skill.toolName)}><span>编辑 Skill</span></button><button type="button" className="toolbar-text-btn" onClick={() => void handleDeleteSkill(skill.name)}><Trash2 size={14} /><span>删除</span></button></div>
                </div>
              )}
            </div>
          ))}
          {skillMetaStatus && <div className="toolbar-note">{skillMetaStatus}</div>}
        </div>
      ) : (
        <div className="mcp-center">
          <div className="mcp-sidebar">
            <div className="mcp-nav-group">
              <div className="mcp-nav-group-title">发现</div>
              <button type="button" className={`mcp-nav-btn${mcpView === 'servers' ? ' active' : ''}`} onClick={() => setMcpView('servers')}>
                <Cable size={16} />
                <span>MCP 服务器</span>
              </button>
              <button type="button" className={`mcp-nav-btn${mcpView === 'builtins' ? ' active' : ''}`} onClick={() => setMcpView('builtins')}>
                <Package2 size={16} />
                <span>内置服务器</span>
              </button>
              <button type="button" className={`mcp-nav-btn${mcpView === 'market' ? ' active' : ''}`} onClick={() => setMcpView('market')}>
                <ShoppingBag size={16} />
                <span>市场</span>
              </button>
            </div>
            <div className="mcp-nav-group">
              <div className="mcp-nav-group-title">提供商</div>
              <button type="button" className={`mcp-nav-btn${mcpView === 'providers' ? ' active' : ''}`} onClick={() => setMcpView('providers')}>
                <Package2 size={16} />
                <span>提供商</span>
              </button>
            </div>
          </div>
          <div className="mcp-main">
            <div className="mcp-main-header">
              <div className="mcp-main-heading">
                <strong>{mcpView === 'servers' ? 'MCP 服务器' : mcpView === 'builtins' ? '内置服务器' : mcpView === 'market' ? '市场' : '提供商'}</strong>
              </div>
              <div className="mcp-toolbar-actions">
                {mcpView === 'servers' && (
                  <div className="mcp-toolbar-group">
                    {selectedMcp && <button type="button" className="toolbar-text-btn" onClick={() => startEditMcp(selectedMcp)}><Pencil size={14} /><span>编辑</span></button>}
                    <button type="button" className="toolbar-text-btn" onClick={startCreateMcp}><Plus size={14} /><span>新建</span></button>
                  </div>
                )}
                {mcpView === 'servers' && (
                  <div className="mcp-toolbar-group">
                    <button type="button" className="toolbar-text-btn" onClick={() => setShowJsonImport(true)}><FileJson size={14} /><span>JSON</span></button>
                    <button type="button" className="toolbar-text-btn" onClick={() => setShowDxtImport(true)}><Upload size={14} /><span>DXT</span></button>
                  </div>
                )}
                <button type="button" className="toolbar-text-btn mcp-refresh-btn" onClick={() => void refreshMcp()}><RefreshCw size={14} /><span>刷新</span></button>
              </div>
            </div>

            {mcpMessage && <div className={`mcp-status-note ${mcpMessageTone}`}>{mcpMessage}</div>}

            {mcpView === 'servers' && (
              <div className={`mcp-layout${showMcpSplitPane ? '' : ' single'}`}>
                <div className="mcp-server-list">
                  {mcpLoading ? <div className="toolbar-note">正在加载 MCP 服务...</div> : null}
                  {mcpServers.length === 0 ? <div className="mcp-empty-state">未配置 MCP 服务器。</div> : null}
                  {mcpServers.map((record) => (
                    <div key={record.name} className={`tool-card mcp-server-card${selectedMcpName === record.name ? ' active' : ''}`}>
                      <button type="button" className="mcp-server-select" onClick={() => setSelectedMcpName(record.name)}>
                        <div className="tool-card-head"><div><strong>{record.name}</strong><p>{record.description || '暂无描述'}</p></div></div>
                        <div className="toolbar-note">{record.transport} · {record.connected ? `已连接 (${record.toolCount})` : '未连接'}</div>
                      </button>
                      <div className="toolbar-row mcp-server-row">
                        <div className="mcp-inline-actions">
                          <button type="button" className="toolbar-text-btn" onClick={() => void handleToggleConnection(record)}><span>{record.connected ? '断开' : '连接'}</span></button>
                          <button type="button" className="toolbar-text-btn" onClick={() => startEditMcp(record)}><Pencil size={14} /></button>
                          <button type="button" className="toolbar-text-btn" onClick={() => void handleDeleteMcp(record.name)}><Trash2 size={14} /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mcp-editor-pane">
                  {editingMcpName ? (
                    <div className="tool-card">
                      <div className="tool-card-head"><div><strong>{editingMcpName === '__new__' ? '新建 MCP 服务' : `编辑 ${editingMcpName}`}</strong><p>这里管理真实 MCP 接入配置，不包含系统 Server 或 Python 脚本。</p></div></div>
                      <div className="tool-card-body">
                        <div className="field"><label>名称</label><input className="input" value={mcpDraft.name} onChange={(event) => setMcpDraft((current) => ({ ...current, name: event.target.value }))} /></div>
                        <div className="field"><label>描述</label><textarea className="textarea" rows={3} value={mcpDraft.description} onChange={(event) => setMcpDraft((current) => ({ ...current, description: event.target.value }))} /></div>
                        <div className="field"><label>类型</label><select className="input" value={mcpDraft.transport} onChange={(event) => setMcpDraft((current) => ({ ...current, transport: event.target.value as 'stdio' | 'streamable-http' }))}><option value="stdio">标准输入 / 输出 (stdio)</option><option value="streamable-http">streamable-http</option></select></div>
                        {mcpDraft.transport === 'stdio' ? (
                          <>
                            <div className="field"><label>命令</label><input className="input" value={mcpDraft.command} onChange={(event) => setMcpDraft((current) => ({ ...current, command: event.target.value }))} placeholder="uvx or npx" /></div>
                            <div className="field"><label>参数</label><textarea className="textarea" rows={4} value={mcpDraft.argsText} onChange={(event) => setMcpDraft((current) => ({ ...current, argsText: event.target.value }))} placeholder={'每行一个参数\n-y\n@modelcontextprotocol/server-filesystem\n.'} /></div>
                            <div className="field"><label>环境变量</label><textarea className="textarea" rows={4} value={mcpDraft.envText} onChange={(event) => setMcpDraft((current) => ({ ...current, envText: event.target.value }))} placeholder={'KEY=value'} /></div>
                          </>
                        ) : (
                          <>
                            <div className="field"><label>URL</label><input className="input" value={mcpDraft.url} onChange={(event) => setMcpDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" /></div>
                            <div className="field"><label>Headers JSON</label><textarea className="textarea" rows={4} value={mcpDraft.headersText} onChange={(event) => setMcpDraft((current) => ({ ...current, headersText: event.target.value }))} /></div>
                          </>
                        )}
                        <div className="field"><label>风险等级</label><select className="input" value={mcpDraft.riskLevel} onChange={(event) => setMcpDraft((current) => ({ ...current, riskLevel: event.target.value as 'read-only' | 'state-change' | 'destructive' }))}><option value="read-only">read-only</option><option value="state-change">state-change</option><option value="destructive">destructive</option></select></div>
                        <div className="toolbar-row"><button type="button" className="toolbar-text-btn" onClick={() => void saveMcp()}><Save size={14} /><span>保存</span></button><button type="button" className="toolbar-text-btn" onClick={() => setEditingMcpName(null)}><span>取消</span></button></div>
                      </div>
                    </div>
                  ) : selectedMcp ? (
                    <div className="tool-card">
                      <div className="tool-card-head"><div><strong>{selectedMcp.name}</strong><p>{selectedMcp.description || '暂无描述'}</p></div></div>
                      <div className="tool-card-body">
                        <div className="mcp-summary-grid">
                          <div className="mcp-summary-item"><span>类型</span><strong>{selectedMcp.transport}</strong></div>
                          <div className="mcp-summary-item"><span>连接</span><strong>{selectedMcp.connected ? '已连接' : '未连接'}</strong></div>
                          <div className="mcp-summary-item"><span>工具数</span><strong>{selectedMcp.toolCount}</strong></div>
                        </div>
                        {selectedMcp.lastError ? <div className="error-text">{selectedMcp.lastError}</div> : null}
                        <div className="field"><label>最近日志</label><pre className="tool-output">{selectedMcp.recentLogs.join('\n') || '暂无日志'}</pre></div>
                      </div>
                    </div>
                  ) : (showMcpSplitPane ? <div className="mcp-empty-state">请选择或创建一个 MCP 服务。</div> : null)}
                </div>
              </div>
            )}

            {mcpView === 'builtins' && (
              <div className={`mcp-layout${builtinServers.length > 0 ? '' : ' single'}`}>
                <div className="mcp-server-list">
                  {builtinServers.length === 0 ? <div className="mcp-empty-state">当前没有内置服务器。</div> : null}
                  {builtinServers.map((record) => (
                    <div key={record.id} className={`tool-card mcp-server-card${selectedBuiltin?.id === record.id ? ' active' : ''}`}>
                      <button type="button" className="mcp-server-select" onClick={() => setSelectedBuiltinId(record.id)}>
                        <div className="tool-card-head"><div><strong>{record.name}</strong><p>{record.description || '暂无描述'}</p></div></div>
                        <div className="toolbar-note">{record.transport} · {record.status === 'running' ? `已连接 (${record.runtimeState?.toolCount || record.capabilities?.tools?.length || 0})` : '未连接'}</div>
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mcp-editor-pane">
                  {selectedBuiltin ? (
                    <div className="tool-card">
                      <div className="tool-card-head"><div><strong>{selectedBuiltin.name}</strong><p>系统内置 MCP。这里是只读展示，不在独立 MCP 仓储中管理。</p></div></div>
                      <div className="tool-card-body">
                        <div className="mcp-summary-grid">
                          <div className="mcp-summary-item"><span>类型</span><strong>{selectedBuiltin.transport}</strong></div>
                          <div className="mcp-summary-item"><span>连接</span><strong>{selectedBuiltin.status === 'running' ? '已连接' : '未连接'}</strong></div>
                          <div className="mcp-summary-item"><span>工具数</span><strong>{selectedBuiltin.runtimeState?.toolCount || selectedBuiltin.capabilities?.tools?.length || 0}</strong></div>
                          <div className="mcp-summary-item"><span>分类</span><strong>内置</strong></div>
                        </div>
                        <div className="field"><label>最近日志</label><pre className="tool-output">{(selectedBuiltin.capabilities?.recentLogs || []).join('\n') || '暂无日志'}</pre></div>
                      </div>
                    </div>
                  ) : (
                    <div className="mcp-empty-state">请选择一个内置服务器。</div>
                  )}
                </div>
              </div>
            )}

            {mcpView === 'market' && (
              <div className="mcp-market-grid">
                {mcpMarket.map((item) => (
                  <div key={item.id} className="tool-card">
                    <div className="tool-card-head"><div><strong>{item.name}</strong><p>{item.description}</p></div></div>
                    <div className="tool-card-body">
                      <div className="toolbar-note">{item.transport} · {item.sourceType}</div>
                      {item.homepage ? <a className="toolbar-note" href={item.homepage} target="_blank" rel="noreferrer">{item.homepage}</a> : null}
                      <button type="button" className="toolbar-text-btn" onClick={() => void handleInstallMarket(item.id)}><Plus size={14} /><span>安装</span></button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {mcpView === 'providers' && (
              <div className="mcp-market-grid">
                {providerItems.map((item) => (
                  <div key={item.id} className="tool-card">
                    <div className="tool-card-head"><div><strong>{item.name}</strong><p>{item.description}</p></div></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {showJsonImport && (
            <div className="modal-backdrop">
              <div className="modal-card mcp-modal-card">
                <div className="modal-header"><strong>从 JSON 导入</strong><button type="button" className="modal-close" onClick={() => setShowJsonImport(false)}>×</button></div>
                <div className="field"><label>请粘贴 mcpServers JSON</label><textarea className="textarea" rows={16} value={jsonImportText} onChange={(event) => setJsonImportText(event.target.value)} placeholder='{"mcpServers":{"example":{"command":"npx","args":["-y","pkg"]}}}' /></div>
                <div className="toolbar-row"><button type="button" className="toolbar-text-btn" onClick={() => void handleJsonImport()}><Save size={14} /><span>导入</span></button><button type="button" className="toolbar-text-btn" onClick={() => setShowJsonImport(false)}><span>取消</span></button></div>
              </div>
            </div>
          )}

          {showDxtImport && (
            <div className="modal-backdrop">
              <div className="modal-card mcp-modal-card">
                <div className="modal-header"><strong>导入 DXT 包</strong><button type="button" className="modal-close" onClick={() => setShowDxtImport(false)}>×</button></div>
                <div className="field"><label>选择 .dxt 或 .mcpb 文件</label><input className="input" type="file" accept=".dxt,.mcpb" onChange={(event) => setDxtFile(event.target.files?.[0] || null)} /></div>
                <div className="toolbar-note">当前只导入能直接解析出 MCP 启动配置的包。</div>
                <div className="toolbar-row"><button type="button" className="toolbar-text-btn" onClick={() => void handleDxtImport()}><Save size={14} /><span>导入</span></button><button type="button" className="toolbar-text-btn" onClick={() => setShowDxtImport(false)}><span>取消</span></button></div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolsPanel;
