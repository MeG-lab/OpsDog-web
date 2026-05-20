import React from 'react';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Check,
  FileCode2,
  FileJson,
  ListChecks,
  Pencil,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Waves,
  Wrench,
  X,
} from 'lucide-react';
import { useAppStore } from '../../stores';
import {
  createTaskDraft,
  deleteServer,
  generateTaskDraft,
  listServers,
  restartServer,
  startServer,
  stopServer,
  updateServer,
  uploadServerScript,
} from '../../services/runtime';
import type { AiTaskDraft } from '../../services/contracts';
import type { ServerCategory, ServerDefinition } from '../../types';

type WorkspaceFilter = 'all' | 'instant' | 'managed';
type AiTaskCreatorStep = 'input' | 'generating' | 'preview' | 'creating';
type AiTaskPreviewTab = 'script' | 'serverDefinition';
type AiPreferredTaskKind = 'auto' | 'instant' | 'managed';

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

const aiStepItems: Array<{ id: AiTaskCreatorStep; label: string }> = [
  { id: 'input', label: '输入需求' },
  { id: 'generating', label: '生成草案' },
  { id: 'preview', label: '预览校验' },
  { id: 'creating', label: '创建任务' },
];

const aiPreferredKindLabel: Record<AiPreferredTaskKind, string> = {
  auto: '自动判断',
  instant: '单次任务',
  managed: '托管任务',
};

const aiPreviewTabLabel: Record<AiTaskPreviewTab, string> = {
  script: 'Python 脚本',
  serverDefinition: 'serverDefinition',
};

const aiRiskLabel: Record<AiTaskDraft['riskLevel'], string> = {
  'read-only': '只读',
  'state-change': '会改变状态',
  destructive: '破坏性',
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

const isLocalTaskServer = (server: ServerDefinition) =>
  server.category !== 'system' && !server.capabilities?.skillPackageId;

const makeDraftId = () => `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const prettyJson = (value: unknown) => JSON.stringify(value ?? emptySchema, null, 2);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const getDraftParameterPreview = (draft: AiTaskDraft): string => {
  const capabilities = isRecord(draft.serverDefinition.capabilities) ? draft.serverDefinition.capabilities : null;
  const directSchema = capabilities && isRecord(capabilities.inputSchema) ? capabilities.inputSchema : null;
  const tools = Array.isArray(capabilities?.tools) ? capabilities.tools : [];
  const toolSchema = tools
    .map((tool) => (isRecord(tool) && isRecord(tool.inputSchema) ? tool.inputSchema : null))
    .find(Boolean);
  const schema = directSchema || toolSchema;
  return schema ? prettyJson(schema) : '暂无参数定义';
};

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
  const activeModel = useAppStore((state) => state.getActiveModel());
  const [activeFilter, setActiveFilter] = React.useState<WorkspaceFilter>('all');
  const [selectedId, setSelectedId] = React.useState('');
  const [selectedSnapshot, setSelectedSnapshot] = React.useState<ServerDefinition | null>(null);
  const [, setWorkspaceStatus] = React.useState('');
  const [expandedLogSignatures, setExpandedLogSignatures] = React.useState<Set<string>>(() => new Set());
  const [aiCreatorOpen, setAiCreatorOpen] = React.useState(false);
  const [aiTaskPrompt, setAiTaskPrompt] = React.useState('');
  const [aiTaskStep, setAiTaskStep] = React.useState<AiTaskCreatorStep>('input');
  const [aiTaskDraft, setAiTaskDraft] = React.useState<AiTaskDraft | null>(null);
  const [aiTaskError, setAiTaskError] = React.useState('');
  const [aiPreferredKind, setAiPreferredKind] = React.useState<AiPreferredTaskKind>('auto');
  const [aiTaskPreviewTab, setAiTaskPreviewTab] = React.useState<AiTaskPreviewTab>('script');
  const [uploadKind, setUploadKind] = React.useState<'instant' | 'managed' | null>(null);
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [uploadDescription, setUploadDescription] = React.useState('');
  const [uploadUsageExamples, setUploadUsageExamples] = React.useState('');
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
  const aiTaskAbortRef = React.useRef<AbortController | null>(null);
  const aiTaskBusy = aiTaskStep === 'generating' || aiTaskStep === 'creating';
  const currentAiStepIndex = Math.max(0, aiStepItems.findIndex((item) => item.id === aiTaskStep));

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

  React.useEffect(() => () => {
    aiTaskAbortRef.current?.abort();
    aiTaskAbortRef.current = null;
  }, []);

  const filteredServers = React.useMemo(() => {
    const visibleServers = servers.filter(isLocalTaskServer);
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

  const toggleLogEntry = React.useCallback((signature: string) => {
    setExpandedLogSignatures((current) => {
      const next = new Set(current);
      if (next.has(signature)) {
        next.delete(signature);
      } else {
        next.add(signature);
      }
      return next;
    });
  }, []);

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
    const target = servers.find((server) => server.id === focusedScriptId && isLocalTaskServer(server));
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
    setExpandedLogSignatures(new Set());
  }, [selectedServer?.id, selectedServer?.description]);

  const stats = React.useMemo(() => ({
    total: servers.filter(isLocalTaskServer).length,
    instant: servers.filter((server) => isLocalTaskServer(server) && server.category === 'instant').length,
    managed: servers.filter((server) => isLocalTaskServer(server) && server.category === 'managed').length,
  }), [servers]);

  const resetAiTaskCreator = React.useCallback(() => {
    aiTaskAbortRef.current?.abort();
    aiTaskAbortRef.current = null;
    setAiCreatorOpen(false);
    setAiTaskPrompt('');
    setAiTaskStep('input');
    setAiTaskDraft(null);
    setAiTaskError('');
    setAiPreferredKind('auto');
    setAiTaskPreviewTab('script');
  }, []);

  const stopAiTaskGeneration = React.useCallback(() => {
    aiTaskAbortRef.current?.abort();
    aiTaskAbortRef.current = null;
    setAiTaskError('已停止生成任务草案。');
    setAiTaskStep(aiTaskDraft ? 'preview' : 'input');
  }, [aiTaskDraft]);

  const closeAiTaskCreator = React.useCallback(() => {
    if (aiTaskStep === 'generating') {
      stopAiTaskGeneration();
      return;
    }
    if (aiTaskStep === 'creating') return;
    resetAiTaskCreator();
  }, [aiTaskStep, resetAiTaskCreator, stopAiTaskGeneration]);

  const handleGenerateAiTaskDraft = async () => {
    const prompt = aiTaskPrompt.trim();
    if (!prompt) {
      setAiTaskError('请先描述任务需求。');
      return;
    }
    if (!activeModel?.provider || !activeModel.apiKey || !activeModel.modelName) {
      setAiTaskError('请先在设置里配置可用模型。');
      return;
    }

    aiTaskAbortRef.current?.abort();
    const abortController = new AbortController();
    aiTaskAbortRef.current = abortController;
    setAiTaskStep('generating');
    setAiTaskError('');
    try {
      const response = await generateTaskDraft({
        prompt,
        preferredKind: aiPreferredKind,
        model: {
          provider: activeModel.provider,
          apiKey: activeModel.apiKey,
          baseUrl: activeModel.baseUrl,
          modelName: activeModel.modelName,
          maxTokens: activeModel.maxTokens,
          temperature: activeModel.temperature,
        },
      }, { signal: abortController.signal });
      setAiTaskDraft(response.draft);
      setAiTaskPreviewTab('script');
      setAiTaskStep('preview');
    } catch (error) {
      if (isAbortError(error)) {
        setAiTaskError('已停止生成任务草案。');
        setAiTaskStep(aiTaskDraft ? 'preview' : 'input');
        return;
      }
      setAiTaskError(error instanceof Error ? error.message : String(error));
      setAiTaskStep(aiTaskDraft ? 'preview' : 'input');
    } finally {
      if (aiTaskAbortRef.current === abortController) {
        aiTaskAbortRef.current = null;
      }
    }
  };

  const handleCreateAiTaskDraft = async () => {
    if (!aiTaskDraft) return;
    if (aiTaskDraft.riskLevel === 'destructive') {
      setAiTaskError('该草案被标记为破坏性风险，前端暂不允许一键创建。');
      return;
    }

    setAiTaskStep('creating');
    setAiTaskError('');
    try {
      const created = await createTaskDraft({ draft: aiTaskDraft });
      await refreshServers();
      setActiveFilter(created.category === 'managed' ? 'managed' : 'instant');
      selectServer(created);
      setWorkspaceStatus(`AI 任务草案已创建：${created.name}`);
      resetAiTaskCreator();
    } catch (error) {
      setAiTaskError(error instanceof Error ? error.message : String(error));
      setAiTaskStep('preview');
    }
  };

  const closeUploadModal = React.useCallback(() => {
    setUploadKind(null);
    setUploadFile(null);
    setUploadDescription('');
    setUploadUsageExamples('');
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
    const usageExamples = uploadUsageExamples
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    setUploadPending(true);
    setUploadError('');
    try {
      const created = await uploadServerScript(uploadKind, uploadFile, uploadDescription.trim(), usageExamples);
      await refreshServers();
      setActiveFilter(created.category === 'managed' ? 'managed' : 'instant');
      setSelectedId(created.id);
      setSelectedSnapshot(created);
      setWorkspaceStatus(`任务能力已创建：${created.name}`);
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
          <h1>任务发布区</h1>
          <p>用 AI 生成任务草案，或通过高级入口上传已有脚本。</p>
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
            <button className="scripts-upload-trigger" title="高级：上传单次任务脚本" onClick={() => setUploadKind('instant')}>
              <Upload size={14} />
            </button>
          </div>
          <div className="scripts-filter-row">
            <button className={`scripts-filter-btn${activeFilter === 'managed' ? ' active' : ''}`} onClick={() => setActiveFilter('managed')}>
              <Waves size={14} />
              <span>{filterLabel.managed}</span>
            </button>
            <button className="scripts-upload-trigger" title="高级：上传托管任务脚本" onClick={() => setUploadKind('managed')}>
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
            <div className="scripts-publish-toolbar">
              <div className="scripts-publish-actions">
                <button
                  type="button"
                  className="btn btn-primary scripts-ai-launch-btn"
                  onClick={() => setAiCreatorOpen(true)}
                >
                  <Sparkles size={15} />
                  <span>告诉 AI 你想做什么？</span>
                </button>
                <button
                  type="button"
                  className="toolbar-text-btn scripts-advanced-upload-btn"
                  onClick={() => setUploadKind(activeFilter === 'managed' ? 'managed' : 'instant')}
                >
                  <Upload size={14} />
                  <span>高级：上传脚本</span>
                </button>
              </div>
              <div className="scripts-publish-filter" aria-label="任务筛选">
                <span>筛选</span>
                {(['all', 'instant', 'managed'] as WorkspaceFilter[]).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`scripts-segment-btn${activeFilter === filter ? ' active' : ''}`}
                    onClick={() => setActiveFilter(filter)}
                  >
                    {filterLabel[filter]}
                  </button>
                ))}
              </div>
            </div>
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
                    {['running', 'starting', 'attention', 'warning', 'recovered', "error"].includes(server.status) ? (
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
                </div>

                <div className="scripts-detail-actions">
                  {['running', 'starting', 'attention', 'warning', 'recovered', 'error'].includes(selectedServer.status) ? (
                    <button type="button" className="toolbar-text-btn" onClick={() => void runServerAction('stop')} disabled={actionPending !== null}>
                      <Square size={14} />
                      <span>停止</span>
                    </button>
                  ) : (
                    <button type="button" className="toolbar-text-btn" onClick={() => void runServerAction('start')} disabled={actionPending !== null}>
                      <Play size={14} />
                      <span>启动</span>
                    </button>
                  )}
                  {selectedServer.type === 'python-script' && (
                    <button type="button" className="toolbar-text-btn" onClick={openCapabilityEditor} disabled={actionPending !== null}>
                      <Wrench size={14} />
                      <span>配置调用</span>
                    </button>
                  )}
                  <button type="button" className="toolbar-text-btn" onClick={() => void runServerAction('restart')} disabled={actionPending !== null}>
                    <RefreshCw size={14} />
                    <span>重启</span>
                  </button>
                  <button type="button" className="toolbar-text-btn" onClick={() => void runServerAction('delete')} disabled={actionPending !== null}>
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
                    <div key={item.id} className={`scripts-log-entry${expandedLogSignatures.has(item.signature) ? ' open' : ''}`}>
                      <button
                        type="button"
                        className="scripts-log-entry-head"
                        onClick={() => toggleLogEntry(item.signature)}
                        aria-expanded={expandedLogSignatures.has(item.signature)}
                      >
                        <span className="scripts-log-entry-title">
                          <span className="scripts-log-entry-label">JSON 日志</span>
                          <span className="scripts-log-entry-preview">{item.content}</span>
                        </span>
                        <span className="scripts-log-entry-meta">
                          {item.repeatCount > 1 ? (
                            <span className="scripts-log-repeat-badge">{item.repeatCount} 条</span>
                          ) : null}
                          <ChevronDown size={14} className="scripts-log-chevron" />
                        </span>
                      </button>
                      {expandedLogSignatures.has(item.signature) && (
                        <pre className="scripts-log-entry-content">{item.content}</pre>
                      )}
                    </div>
                  ))
                )}
              </div>
              </div>
          ) : null}
          </section>
        </div>
      </div>

      {aiCreatorOpen && (
        <div className="scripts-upload-modal-backdrop" onClick={closeAiTaskCreator}>
          <div className="scripts-upload-modal scripts-ai-modal" onClick={(event) => event.stopPropagation()}>
            <div className="scripts-upload-modal-head">
              <div>
                <span className="scripts-upload-modal-kicker">AI Task Creator</span>
                <h3>
                  <Bot size={18} />
                  AI 生成任务
                </h3>
              </div>
              <button
                className="scripts-upload-modal-close"
                type="button"
                onClick={closeAiTaskCreator}
                disabled={aiTaskStep === 'creating'}
                aria-label="关闭 AI 任务生成"
              >
                <X size={18} />
              </button>
            </div>

            <div className="scripts-upload-modal-body scripts-ai-modal-body">
              <div className="scripts-ai-stepper">
                {aiStepItems.map((item, index) => {
                  const isActive = item.id === aiTaskStep;
                  const isDone = currentAiStepIndex > index;
                  return (
                    <div key={item.id} className={`scripts-ai-step${isActive ? ' active' : ''}${isDone ? ' done' : ''}`}>
                      <span>{index + 1}</span>
                      <strong>{item.label}</strong>
                    </div>
                  );
                })}
              </div>

              <div className="scripts-ai-input-grid">
                <label className="scripts-upload-field scripts-ai-prompt-field">
                  <span>任务需求</span>
                  <textarea
                    value={aiTaskPrompt}
                    onChange={(event) => setAiTaskPrompt(event.target.value)}
                    rows={6}
                    maxLength={1200}
                    disabled={aiTaskBusy}
                    placeholder="描述你想监控什么、多久执行一次、什么情况告警"
                  />
                  <small>{aiTaskPrompt.trim().length}/1200</small>
                </label>

                <div className="scripts-ai-kind-panel">
                  <div className="scripts-section-title">任务类型</div>
                  <div className="scripts-ai-kind-options">
                    {(['auto', 'instant', 'managed'] as AiPreferredTaskKind[]).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={`scripts-ai-kind-btn${aiPreferredKind === kind ? ' active' : ''}`}
                        onClick={() => setAiPreferredKind(kind)}
                        disabled={aiTaskBusy}
                      >
                        {aiPreferredKindLabel[kind]}
                      </button>
                    ))}
                  </div>
                  <div className="scripts-ai-model-chip">
                    <span>模型</span>
                    <strong>{activeModel ? activeModel.name || activeModel.modelName : '未配置'}</strong>
                  </div>
                </div>
              </div>

              {(aiTaskStep === 'generating' || aiTaskStep === 'creating') && (
                <div className="scripts-ai-progress">
                  <RefreshCw size={16} />
                  <span>{aiTaskStep === 'generating' ? '正在生成任务草案...' : '正在创建任务...'}</span>
                </div>
              )}

              {aiTaskDraft && (
                <div className="scripts-ai-draft-preview">
                  <div className="scripts-ai-preview-head">
                    <div>
                      <span className="scripts-upload-modal-kicker">Draft Preview</span>
                      <h4>{aiTaskDraft.name}</h4>
                    </div>
                    <span className={`scripts-ai-risk-pill risk-${aiTaskDraft.riskLevel}`}>
                      {aiRiskLabel[aiTaskDraft.riskLevel]}
                    </span>
                  </div>

                  <div className="scripts-ai-summary-grid">
                    <div>
                      <span>任务类型</span>
                      <strong>{categoryLabel[aiTaskDraft.kind]}任务</strong>
                    </div>
                    <div>
                      <span>意图提示</span>
                      <strong>{aiTaskDraft.triggers.length ? aiTaskDraft.triggers.join(' / ') : '未生成'}</strong>
                    </div>
                    <div className="scripts-ai-summary-wide">
                      <span>描述</span>
                      <p>{aiTaskDraft.description || '暂无描述'}</p>
                    </div>
                    <div className="scripts-ai-summary-wide">
                      <span>参数</span>
                      <pre>{getDraftParameterPreview(aiTaskDraft)}</pre>
                    </div>
                  </div>

                  <div className={`scripts-ai-risk-banner risk-${aiTaskDraft.riskLevel}`}>
                    <AlertTriangle size={16} />
                    <span>
                      AI 将创建本地 Python 任务。创建后不会自动运行，请确认脚本内容和执行范围。
                      {aiTaskDraft.riskLevel === 'destructive' ? ' 该草案当前不允许一键创建。' : ''}
                    </span>
                  </div>

                  {aiTaskDraft.validationNotes.length > 0 && (
                    <div className="scripts-ai-validation">
                      <div className="scripts-section-title">
                        <ListChecks size={13} />
                        校验备注
                      </div>
                      <ul>
                        {aiTaskDraft.validationNotes.map((note, index) => (
                          <li key={`${note}-${index}`}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="scripts-ai-code-panel">
                    <div className="scripts-ai-code-head">
                      <div>
                        <FileJson size={14} />
                        <span>代码 / 配置预览</span>
                      </div>
                      <div className="scripts-ai-code-tabs">
                        {(['script', 'serverDefinition'] as AiTaskPreviewTab[]).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            className={aiTaskPreviewTab === tab ? 'active' : ''}
                            onClick={() => setAiTaskPreviewTab(tab)}
                          >
                            {aiPreviewTabLabel[tab]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <pre className="scripts-ai-code-block">
                      {aiTaskPreviewTab === 'script'
                        ? aiTaskDraft.script
                        : prettyJson(aiTaskDraft.serverDefinition)}
                    </pre>
                  </div>
                </div>
              )}

              {!aiTaskDraft && aiTaskStep === 'input' && (
                <div className="scripts-ai-empty-preview">
                  <Sparkles size={16} />
                  <span>生成后会在这里预览任务类型、脚本和配置。</span>
                </div>
              )}

              {aiTaskError && <div className="scripts-upload-error">{aiTaskError}</div>}
            </div>

            <div className="scripts-upload-modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeAiTaskCreator} disabled={aiTaskStep === 'creating'}>
                取消
              </button>
              {aiTaskStep === 'generating' && (
                <button className="btn btn-ghost danger" type="button" onClick={stopAiTaskGeneration}>
                  <Square size={14} />
                  停止生成
                </button>
              )}
              {aiTaskDraft ? (
                <button className="btn btn-ghost" type="button" onClick={() => void handleGenerateAiTaskDraft()} disabled={aiTaskBusy}>
                  <RefreshCw size={14} />
                  {aiTaskStep === 'generating' ? '生成中...' : '重新生成'}
                </button>
              ) : (
                <button className="btn btn-primary" type="button" onClick={() => void handleGenerateAiTaskDraft()} disabled={aiTaskBusy}>
                  <Sparkles size={14} />
                  {aiTaskStep === 'generating' ? '生成中...' : '生成任务草案'}
                </button>
              )}
              <button
                className="btn btn-primary scripts-ai-create-btn"
                type="button"
                onClick={() => void handleCreateAiTaskDraft()}
                disabled={!aiTaskDraft || aiTaskBusy || aiTaskDraft.riskLevel === 'destructive'}
                title={aiTaskDraft?.riskLevel === 'destructive' ? '破坏性风险草案暂不允许一键创建' : undefined}
              >
                <Check size={14} />
                {aiTaskStep === 'creating' ? '创建中...' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}

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
                <span>参数说明或示例</span>
                <textarea
                  value={uploadUsageExamples}
                  onChange={(event) => setUploadUsageExamples(event.target.value)}
                  rows={3}
                  maxLength={240}
                  placeholder="每行一个示例，例如：检查 127.0.0.1 的 8080 端口"
                />
                <small>可选。系统会写入任务能力元数据，供意图识别理解参数。</small>
              </label>

              {uploadError && <div className="scripts-upload-error">{uploadError}</div>}
            </div>

            <div className="scripts-upload-modal-actions">
              <button className="btn btn-ghost" type="button" onClick={closeUploadModal} disabled={uploadPending}>
                取消
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void handleUpload()} disabled={uploadPending}>
                <Upload size={14} />
                {uploadPending ? '上传中...' : '上传任务能力'}
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
                      <small>这里填写 JSON Schema。后续聊天、任务能力和 MCP 调试都会按它理解参数。</small>
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
