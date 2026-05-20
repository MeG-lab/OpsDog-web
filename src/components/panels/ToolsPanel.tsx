import React from 'react';
import {
  AlertTriangle,
  Cable,
  ChevronDown,
  CheckCircle2,
  FileArchive,
  FileJson,
  Package2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShoppingBag,
  Trash2,
  Upload,
} from 'lucide-react';
import { useAppStore } from '../../stores';
import {
  connectMCPServerByName,
  createMCPServer,
  deleteSkillPackage,
  deleteMCPServer,
  disconnectMCPServerByName,
  importMCPServerDxt,
  importMCPServersJson,
  installSkillPackage,
  installSkillPackageDependencies,
  installMCPMarketItem,
  listSkillPackages,
  listMCPMarket,
  listMCPServers,
  listServers,
  previewSkillPackage,
  updateSkillPackage,
  updateMCPServer,
} from '../../services/runtime';
import type { MCPMarketItem, MCPServerRecord, SkillPackageRecord } from '../../types';

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

const skillPackageKindLabel: Record<SkillPackageRecord['kind'], string> = {
  executable: '可执行',
  'instruction-only': '上下文',
};

const dependencyStatusLabel: Record<SkillPackageRecord['dependencyStatus'], string> = {
  none: '无需依赖',
  pending: '待安装',
  installing: '安装中',
  installed: '已安装',
  failed: '失败',
};

const hasSkillPackageDetails = (record: SkillPackageRecord) =>
  Boolean(
    record.requiredEnv?.length ||
    record.dependencies?.length ||
    record.dependencyLog ||
    record.warnings?.length ||
    record.dependencyFiles?.length ||
    record.instructionFiles?.length ||
    record.serverIds?.length ||
    record.permissions?.network ||
    record.permissions?.filesystem,
  );

const ToolsPanel: React.FC = () => {
  const {
    servers,
    setServers,
    skillPackages,
    setSkillPackages,
    toolsPanelTab,
    setToolsPanelTab,
  } = useAppStore();

  const [mcpView, setMcpView] = React.useState<'servers' | 'builtins' | 'market' | 'providers'>('servers');
  const [skillPackageLoading, setSkillPackageLoading] = React.useState(false);
  const [skillPackageMessage, setSkillPackageMessage] = React.useState('');
  const [skillPackageFile, setSkillPackageFile] = React.useState<File | null>(null);
  const [skillPackagePreview, setSkillPackagePreview] = React.useState<SkillPackageRecord | null>(null);
  const [skillPackagePending, setSkillPackagePending] = React.useState(false);
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
  const skillPackageFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const mcpMessageTone = React.useMemo<'info' | 'success' | 'error'>(() => {
    const text = mcpMessage.toLowerCase();
    if (!text) return 'info';
    if (text.includes('成功') || text.includes('已') || text.includes('created') || text.includes('saved')) return 'success';
    if (text.includes('error') || text.includes('失败') || text.includes('not found') || text.includes('route')) return 'error';
    return 'info';
  }, [mcpMessage]);
  const skillPackageMessageTone = React.useMemo<'info' | 'success' | 'error'>(() => {
    const text = skillPackageMessage.toLowerCase();
    if (!text) return 'info';
    if (text.includes('成功') || text.includes('完成') || text.includes('已')) return 'success';
    if (text.includes('error') || text.includes('失败') || text.includes('请先')) return 'error';
    return 'info';
  }, [skillPackageMessage]);

  const loadSkillPackages = React.useCallback(async () => {
    setSkillPackageLoading(true);
    try {
      const nextPackages = await listSkillPackages();
      setSkillPackages(nextPackages);
    } catch (error) {
      setSkillPackageMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillPackageLoading(false);
    }
  }, [setSkillPackages]);

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
    void loadSkillPackages();
    void refreshServers();
    void refreshMcp();
  }, [loadSkillPackages, refreshServers, refreshMcp]);

  const selectedMcp = mcpServers.find((server) => server.name === selectedMcpName) || mcpServers[0] || null;
  const builtinServers = React.useMemo(
    () => servers.filter((server) => server.category === 'system'),
    [servers],
  );
  const selectedBuiltin = builtinServers.find((server) => server.id === selectedBuiltinId) || builtinServers[0] || null;
  const showMcpSplitPane = Boolean(mcpServers.length > 0 || editingMcpName || selectedMcp);
  const enabledSkillPackageCount = skillPackages.filter((record) => record.enabled).length;
  const executableSkillPackageCount = skillPackages.filter((record) => record.kind === 'executable').length;
  const dependencyAttentionCount = skillPackages.filter((record) => (
    record.dependencyStatus === 'pending' || record.dependencyStatus === 'failed'
  )).length;

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

  const handlePreviewSkillPackage = async () => {
    if (!skillPackageFile) {
      setSkillPackageMessage('请先选择一个 zip 格式 Skill 包。');
      return;
    }
    setSkillPackagePending(true);
    setSkillPackageMessage('');
    try {
      const preview = await previewSkillPackage(skillPackageFile);
      setSkillPackagePreview(preview);
      setSkillPackageMessage(`预览完成：${preview.name}`);
    } catch (error) {
      setSkillPackageMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillPackagePending(false);
    }
  };

  const handleInstallSkillPackage = async () => {
    if (!skillPackagePreview?.importId) {
      setSkillPackageMessage('请先预览 Skill 包。');
      return;
    }
    setSkillPackagePending(true);
    try {
      const installed = await installSkillPackage(skillPackagePreview.importId);
      setSkillPackageMessage(`Skill 包已安装：${installed.name}`);
      setSkillPackageFile(null);
      setSkillPackagePreview(null);
      if (skillPackageFileInputRef.current) {
        skillPackageFileInputRef.current.value = '';
      }
      await Promise.all([loadSkillPackages(), refreshServers()]);
    } catch (error) {
      setSkillPackageMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillPackagePending(false);
    }
  };

  const handleToggleSkillPackage = async (record: SkillPackageRecord) => {
    try {
      await updateSkillPackage(record.id, { enabled: !record.enabled });
      await Promise.all([loadSkillPackages(), refreshServers()]);
    } catch (error) {
      setSkillPackageMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleInstallDependencies = async (record: SkillPackageRecord) => {
    if (!window.confirm(`确认安装 ${record.name} 的 Python 依赖吗？这会执行 pip install。`)) return;
    setSkillPackagePending(true);
    setSkillPackageMessage(`正在安装依赖：${record.name}`);
    try {
      const updated = await installSkillPackageDependencies(record.id);
      setSkillPackageMessage(`依赖安装完成：${updated.name}`);
      await Promise.all([loadSkillPackages(), refreshServers()]);
    } catch (error) {
      setSkillPackageMessage(error instanceof Error ? error.message : String(error));
      await loadSkillPackages();
    } finally {
      setSkillPackagePending(false);
    }
  };

  const handleDeleteSkillPackage = async (record: SkillPackageRecord) => {
    if (record.protected || record.builtin) {
      setSkillPackageMessage(`内置 Skill 包不能删除：${record.name}`);
      return;
    }
    if (!window.confirm(`确定删除 Skill 包 ${record.name} 吗？`)) return;
    try {
      await deleteSkillPackage(record.id);
      setSkillPackageMessage(`已删除 Skill 包：${record.name}`);
      await Promise.all([loadSkillPackages(), refreshServers()]);
    } catch (error) {
      setSkillPackageMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
      <div className="tools-panel">
        <div className="tabbar">
        <button type="button" className={`tab${toolsPanelTab === 'skillPackages' ? ' active' : ''}`} onClick={() => setToolsPanelTab('skillPackages')}>Skill 包</button>
        <button type="button" className={`tab${toolsPanelTab === 'mcp' ? ' active' : ''}`} onClick={() => setToolsPanelTab('mcp')}>MCP</button>
      </div>

      {toolsPanelTab === 'skillPackages' ? (
        <div className="skill-packages-panel">
          <div className="skill-package-hero">
            <div className="skill-package-hero-copy">
              <span className="skill-package-eyebrow">Skill Packages</span>
              <strong>Skill 包</strong>
              <p>{skillPackageLoading ? '正在同步本地 Skill 包...' : '管理模型上下文与可执行能力包。'}</p>
            </div>
            <div className="skill-package-hero-actions">
              <button type="button" className="toolbar-text-btn" onClick={() => void loadSkillPackages()} disabled={skillPackageLoading}>
                <RefreshCw size={14} />
                <span>{skillPackageLoading ? '同步中' : '刷新'}</span>
              </button>
            </div>
            <div className="skill-package-metrics">
              <div className="skill-package-metric">
                <span>已安装</span>
                <strong>{skillPackages.length}</strong>
              </div>
              <div className="skill-package-metric">
                <span>已启用</span>
                <strong>{enabledSkillPackageCount}</strong>
              </div>
              <div className="skill-package-metric">
                <span>可执行</span>
                <strong>{executableSkillPackageCount}</strong>
              </div>
              <div className={`skill-package-metric${dependencyAttentionCount > 0 ? ' attention' : ''}`}>
                <span>依赖待处理</span>
                <strong>{dependencyAttentionCount}</strong>
              </div>
            </div>
          </div>

          {skillPackageMessage && (
            <div className={`skill-package-status ${skillPackageMessageTone}`}>
              {skillPackageMessageTone === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
              <span>{skillPackageMessage}</span>
            </div>
          )}

          <section className="skill-package-import-card">
            <div className="skill-package-section-head">
              <div>
                <span>导入</span>
                <strong>上传 Skill 包</strong>
              </div>
              {skillPackagePreview ? <span className="skill-package-ready-pill">预览就绪</span> : null}
            </div>

            <div className="skill-package-import-grid">
              <div className={`skill-package-file-box${skillPackageFile ? ' has-file' : ''}`}>
                <FileArchive size={22} />
                <div>
                  <strong>{skillPackageFile ? skillPackageFile.name : '选择 zip 包'}</strong>
                  <span>{skillPackageFile ? `${Math.max(1, Math.round(skillPackageFile.size / 1024))} KB` : '上传后先预览，再确认安装。'}</span>
                </div>
                <input
                  ref={skillPackageFileInputRef}
                  className="skill-package-file-input"
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => {
                    setSkillPackageFile(event.target.files?.[0] || null);
                    setSkillPackagePreview(null);
                    setSkillPackageMessage('');
                  }}
                />
                <button type="button" className="toolbar-text-btn" onClick={() => skillPackageFileInputRef.current?.click()}>
                  <Upload size={14} />
                  <span>选择文件</span>
                </button>
              </div>

              <div className="skill-package-import-actions">
                <button
                  type="button"
                  className="toolbar-text-btn"
                  disabled={!skillPackageFile || skillPackagePending}
                  onClick={() => void handlePreviewSkillPackage()}
                >
                  <Upload size={14} />
                  <span>{skillPackagePending ? '处理中' : '预览'}</span>
                </button>
                <button
                  type="button"
                  className="toolbar-text-btn primary"
                  disabled={!skillPackagePreview || skillPackagePending}
                  onClick={() => void handleInstallSkillPackage()}
                >
                  <Package2 size={14} />
                  <span>确认安装</span>
                </button>
              </div>
            </div>

            {skillPackagePreview && (
              <div className="skill-package-preview-card">
                <div className="skill-package-preview-main">
                  <strong>{skillPackagePreview.name}</strong>
                  <p>{skillPackagePreview.description || '暂无说明'}</p>
                </div>
                <div className="skill-package-preview-grid">
                  <div><span>类型</span><strong>{skillPackageKindLabel[skillPackagePreview.kind]}</strong></div>
                  <div><span>工具</span><strong>{skillPackagePreview.tools?.length || 0}</strong></div>
                  <div><span>依赖</span><strong>{skillPackagePreview.dependencies?.length || 0}</strong></div>
                  <div><span>网络</span><strong>{skillPackagePreview.permissions?.network ? '需要' : '不需要'}</strong></div>
                </div>
                {skillPackagePreview.tools?.length > 0 && (
                  <div className="skill-package-inline-list">
                    {skillPackagePreview.tools.map((tool) => <span key={tool.name}>{tool.name}</span>)}
                  </div>
                )}
                {skillPackagePreview.warnings?.length ? (
                  <div className="skill-package-warning-list">
                    {skillPackagePreview.warnings.map((warning) => (
                      <span key={warning}><AlertTriangle size={13} />{warning}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="skill-package-list-section">
            <div className="skill-package-section-head">
              <div>
                <span>已安装</span>
                <strong>{skillPackages.length} 个 Skill 包</strong>
              </div>
            </div>

            <div className="skill-package-list">
              {skillPackages.length === 0 && (
                <div className="skill-package-empty">当前还没有安装 Skill 包。</div>
              )}
              {skillPackages.map((record) => {
                const canDelete = !record.protected && !record.builtin;
                const showDetails = hasSkillPackageDetails(record);
                return (
                  <article key={record.id} className={`skill-package-card${record.enabled ? ' enabled' : ''}`}>
                    <div className="skill-package-card-icon">
                      <Package2 size={18} />
                    </div>
                    <div className="skill-package-card-main">
                      <div className="skill-package-card-title">
                        <div>
                          <strong>{record.name}</strong>
                          <p>{record.description || '暂无说明'}</p>
                        </div>
                        <span className={`skill-package-state-pill${record.enabled ? ' enabled' : ''}`}>
                          {record.enabled ? '已启用' : '已停用'}
                        </span>
                      </div>

                      <div className="skill-package-chip-row">
                        <span>{skillPackageKindLabel[record.kind]} Skill</span>
                        {record.builtin ? <span>内置</span> : null}
                        {record.protected ? <span>受保护</span> : null}
                        <span>依赖：{dependencyStatusLabel[record.dependencyStatus] || record.dependencyStatus}</span>
                        <span>来源：{record.manifestSource}</span>
                        {record.tools?.length > 0 ? <span>工具：{record.tools.length}</span> : null}
                      </div>

                      {record.tools?.length > 0 && (
                        <div className="skill-package-inline-list">
                          {record.tools.map((tool) => <span key={tool.name}>{tool.name}</span>)}
                        </div>
                      )}

                      {showDetails && (
                        <details className="skill-package-details">
                          <summary>
                            <span>更多内容</span>
                            <ChevronDown size={14} />
                          </summary>
                          <div className="skill-package-detail-body">
                            {Boolean(record.requiredEnv?.length) && (
                              <div className="skill-package-muted-line">环境变量：{(record.requiredEnv || []).join('、')}</div>
                            )}
                            {record.dependencies?.length > 0 && (
                              <div className="skill-package-muted-line">依赖：{record.dependencies.join('、')}</div>
                            )}
                            {record.dependencyFiles?.length ? (
                              <div className="skill-package-muted-line">依赖文件：{record.dependencyFiles.join('、')}</div>
                            ) : null}
                            {record.serverIds?.length ? (
                              <div className="skill-package-muted-line">注册 Server：{record.serverIds.join('、')}</div>
                            ) : null}
                            {record.instructionFiles?.length ? (
                              <div className="skill-package-muted-line">上下文文件：{record.instructionFiles.join('、')}</div>
                            ) : null}
                            {(record.permissions?.network || record.permissions?.filesystem) && (
                              <div className="skill-package-muted-line">
                                权限：{[
                                  record.permissions.network ? '网络' : '',
                                  record.permissions.filesystem ? `文件系统 ${record.permissions.filesystem}` : '',
                                ].filter(Boolean).join('、')}
                              </div>
                            )}
                            {record.warnings?.length ? (
                              <div className="skill-package-warning-list">
                                {record.warnings.map((warning) => (
                                  <span key={warning}><AlertTriangle size={13} />{warning}</span>
                                ))}
                              </div>
                            ) : null}
                            {record.dependencies?.length > 0 && (
                              <button
                                type="button"
                                className="toolbar-text-btn skill-package-dependency-btn"
                                disabled={skillPackagePending}
                                onClick={() => void handleInstallDependencies(record)}
                              >
                                <span>安装依赖</span>
                              </button>
                            )}
                            {record.dependencyLog && (
                              <details className="skill-package-log">
                                <summary>依赖日志</summary>
                                <pre>{record.dependencyLog}</pre>
                              </details>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                    <div className="skill-package-card-actions">
                      <button
                        type="button"
                        className={`skill-package-switch${record.enabled ? ' active' : ''}`}
                        role="switch"
                        aria-checked={record.enabled}
                        title={record.enabled ? '停用 Skill 包' : '启用 Skill 包'}
                        onClick={() => void handleToggleSkillPackage(record)}
                      >
                        <span />
                      </button>
                    </div>
                    {canDelete && (
                      <div className="skill-package-danger-zone">
                        <button
                          type="button"
                          className="toolbar-text-btn danger"
                          title="删除 Skill 包"
                          onClick={() => void handleDeleteSkillPackage(record)}
                        >
                          <Trash2 size={14} />
                          <span>删除</span>
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
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
