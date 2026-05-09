import React from 'react';
import { Send, Square, ChevronDown, Check, ChevronLeft } from 'lucide-react';
import { useAppStore, useChatStore } from '../../stores';
import type { ChatExecutionPlan, ChatRouteDecision, ChatMcpMode, ExecutionResult, LLMProvider, MCPServerRecord, WorkflowExecutionResult } from '../../types';
import { listMCPServers, buildChatExecutionPlan } from '../../services/runtime';
import type { RuntimeUnlistenFn } from '../../services/runtime';
import { isFilesystemMcpIntent } from '../../services/runtime/mcpChatPlanner';
import { executeSelectedCandidate } from '../../services/runtime/chatExecutor';

export interface InputAreaHandle {
  sendMessage: (text: string) => void;
}

const InputArea = React.forwardRef<InputAreaHandle>((_props, ref) => {
  const [input, setInput] = React.useState('');
  const [modelOpen, setModelOpen] = React.useState(false);
  const [mcpModeOpen, setMcpModeOpen] = React.useState(false);
  const [mcpMenuStep, setMcpMenuStep] = React.useState<'mode' | 'servers'>('mode');
  const [manualMcpServers, setManualMcpServers] = React.useState<MCPServerRecord[]>([]);
  const [manualMcpServersLoading, setManualMcpServersLoading] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const modelRef = React.useRef<HTMLDivElement>(null);
  const mcpModeRef = React.useRef<HTMLDivElement>(null);
  const unlistenChunk = React.useRef<RuntimeUnlistenFn | null>(null);
  const unlistenDone = React.useRef<RuntimeUnlistenFn | null>(null);
  const simulateStreamTimerRef = React.useRef<number | null>(null);
  const activeRunIdRef = React.useRef(0);

  const { getActiveModel, skills, skillsLoading, skillsInitialized, skillsError, llmConfigs, activeModelId, setActiveModel, chatMcpMode, setChatMcpMode, selectedManualMcpServer, setSelectedManualMcpServer } = useAppStore();
  const { activeConversationId, addMessage, isStreaming, setStreaming, createConversation } = useChatStore();

  const providerLabel: Record<LLMProvider, string> = {
    openai: 'OpenAI',
    anthropic: 'Claude',
    google: 'Gemini',
    aliyun: '阿里百炼',
    deepseek: 'DeepSeek',
    siliconflow: '硅基流动',
    volcengine: '火山方舟',
    zhipu: '智谱 AI',
    moonshot: '月之暗面',
    custom: 'Custom',
  };

  // Auto-resize textarea
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  // Cleanup listeners on unmount
  React.useEffect(() => () => {
    unlistenChunk.current?.();
    unlistenDone.current?.();
    if (simulateStreamTimerRef.current !== null) {
      window.clearInterval(simulateStreamTimerRef.current);
      simulateStreamTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(event.target as Node)) {
        setModelOpen(false);
      }
      if (mcpModeRef.current && !mcpModeRef.current.contains(event.target as Node)) {
        setMcpModeOpen(false);
        setMcpMenuStep('mode');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  React.useEffect(() => {
    if (chatMcpMode !== 'manual') {
      return;
    }
    let cancelled = false;
    setManualMcpServersLoading(true);
    void listMCPServers()
      .then((servers) => {
        if (cancelled) return;
        const nextServers = servers.filter((server) => server.connected && server.name !== 'filesystem');
        setManualMcpServers(nextServers);
        if (selectedManualMcpServer && !nextServers.some((server) => server.name === selectedManualMcpServer)) {
          setSelectedManualMcpServer(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Failed to load MCP servers for manual mode:', error);
        setManualMcpServers([]);
      })
      .finally(() => {
        if (!cancelled) setManualMcpServersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatMcpMode, selectedManualMcpServer, setSelectedManualMcpServer]);

  // Expose sendMessage handle
  React.useImperativeHandle(ref, () => ({
    sendMessage: (text: string) => {
      setInput(text);
      setTimeout(() => {
        (document.querySelector('[data-send-trigger]') as HTMLButtonElement)?.click();
      }, 50);
    },
  }));

  const buildReportDownloadUrl = React.useCallback(
    (fileName: string) => `${window.location.origin}/api/reports/${encodeURIComponent(fileName)}/download`,
    [],
  );

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    const isRunActive = () => activeRunIdRef.current === runId;

    const model = getActiveModel();
    let convId = activeConversationId;
    if (!convId) convId = createConversation(useAppStore.getState().activeModelId || undefined);

    addMessage(convId, { role: 'user', content: trimmed });
    setInput('');
    setStreaming(true);

    const assistantId = addMessage(convId, { role: 'assistant', content: '', isStreaming: true });
    const simulateCurrentRun = (text: string) => {
      if (!isRunActive()) return;
      simulateStream(convId!, assistantId, text, runId);
    };
    const withDownloadUrls = (artifacts: unknown) => Array.isArray(artifacts)
      ? artifacts.map((artifact: any) => ({
          ...artifact,
          downloadUrl: artifact?.fileName ? buildReportDownloadUrl(String(artifact.fileName)) : undefined,
        }))
      : [];
    const finalizeExecutionResult = (result: ExecutionResult) => {
      if (!isRunActive()) return;
      const normalizedResult: ExecutionResult = {
        ok: Boolean(result.ok),
        kind: result.kind,
        workflowId: result.workflowId,
        summary: String(result.summary || ''),
        steps: Array.isArray(result.steps) ? result.steps : [],
        artifacts: withDownloadUrls(result.artifacts),
        highlights: Array.isArray(result.highlights) ? result.highlights.map((item: unknown) => String(item)) : [],
        errors: Array.isArray(result.errors) ? result.errors.map((item: unknown) => String(item)) : [],
        textFallback: result.textFallback,
      };
      useChatStore.getState().updateMessage(convId!, assistantId, {
        content: normalizedResult.textFallback || normalizedResult.summary,
        executionResult: normalizedResult,
        workflowResult: normalizedResult.kind === 'workflow' ? normalizedResult as WorkflowExecutionResult : undefined,
        isStreaming: false,
      });
      setStreaming(false);
    };
    const finalizeTextResult = (result: Omit<ExecutionResult, 'artifacts' | 'highlights' | 'errors' | 'steps'> & Partial<Pick<ExecutionResult, 'artifacts' | 'highlights' | 'errors' | 'steps'>>) => {
      finalizeExecutionResult({
        steps: [],
        artifacts: [],
        highlights: [],
        errors: [],
        ...result,
      });
    };

    // Auto-title
    const conv = useChatStore.getState().conversations.find(c => c.id === convId);
    if (conv?.title === '新对话') {
      useChatStore.getState().updateTitle(convId!, trimmed.length > 22 ? trimmed.slice(0, 22) + '…' : trimmed);
    }


    if (!model) {
      simulateCurrentRun(`⚠️ **未配置模型**\n\n请点击右上角 ⚙️ 设置图标，添加 LLM 配置后即可对话。`);
      return;
    }

    if (!skillsInitialized && skillsLoading) {
      simulateCurrentRun('Skills 仍在加载中，请稍后再试一次。');
      return;
    }

    if (skillsError) {
      simulateCurrentRun(`Skills 加载失败：${skillsError}`);
      return;
    }

    const enabledSkills = skills.filter(s => s.enabled);

    let executionPlan: ChatExecutionPlan | null = null;
    let routeDecision: ChatRouteDecision | null = null;
    try {
      executionPlan = await buildChatExecutionPlan(trimmed, enabledSkills.map(skill => ({
        name: skill.name,
        triggers: skill.triggers,
        workflowId: skill.workflowId,
        serverId: skill.serverId,
        toolName: skill.toolName,
        resolvedToolName: skill.resolvedToolName,
        entryScript: skill.entryScript,
        taskKind: skill.taskKind,
        description: skill.description,
      })), {
        chatMcpMode,
        selectedManualMcpServer,
      });
      routeDecision = executionPlan.route;
    } catch (error) {
      console.warn('build_chat_execution_plan failed, fallback to local routing:', error);
    }

    if (routeDecision?.blocked) {
      simulateCurrentRun(`⚠️ **请求已被拦截**\n\n${routeDecision.blockReason || '当前输入命中了高风险指令策略，系统没有继续交给模型或本地执行层处理。'}`);
      return;
    }

    // Build messages with skill context
    const currentConv = useChatStore.getState().conversations.find(c => c.id === convId);

    if (routeDecision ? routeDecision.intent === 'skill.catalog' : isSkillCatalogQuery(trimmed)) {
      simulateCurrentRun(buildSkillCatalogReply(enabledSkills));
      return;
    }

    const selectedCandidate = executionPlan?.selected || null;

    const looksLikeMcpRequest =
      /\bmcp\b/i.test(trimmed) ||
      /\bfilesystem\b/i.test(trimmed) ||
      /\bfetch\b/i.test(trimmed) ||
      /(抓取|获取网页|读取网页|读取页面|抓网页|抓页面|调用工具|使用工具)/.test(trimmed) ||
      (/https?:\/\//i.test(trimmed) && /(抓|取|读取|获取|看一下|看看)/.test(trimmed)) ||
      isFilesystemMcpIntent(trimmed);

    if (chatMcpMode === 'disabled' && (looksLikeMcpRequest || routeDecision?.allowMcp || selectedCandidate?.type.startsWith('mcp.'))) {
      simulateCurrentRun('当前已禁用 MCP。请将输入区的 MCP 模式切换到“手动”或“自动”后再重试。');
      return;
    }

    try {
      const result = await executeSelectedCandidate({
        selected: selectedCandidate,
        routeDecision,
        inputText: trimmed,
        chatMcpMode,
        selectedManualMcpServer,
        model,
        enabledSkills,
        conversationMessages: currentConv?.messages || [],
        assistantMessageId: assistantId,
        isRunActive,
      });
      finalizeExecutionResult(result);
      return;
    } catch (error) {
      if (!isRunActive()) return;
      finalizeTextResult({
        ok: false,
        kind: 'error',
        summary: '执行失败。',
        errors: [error instanceof Error ? error.message : String(error)],
        steps: [{
          id: 'execute-selected-candidate',
          title: '执行候选能力',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }],
      });
      return;
    }

  };

  const simulateStream = (convId: string, msgId: string, text: string, runId?: number) => {
    if (simulateStreamTimerRef.current !== null) {
      window.clearInterval(simulateStreamTimerRef.current);
      simulateStreamTimerRef.current = null;
    }
    let i = 0;
    const iv = window.setInterval(() => {
      if (runId !== undefined && activeRunIdRef.current !== runId) {
        window.clearInterval(iv);
        if (simulateStreamTimerRef.current === iv) {
          simulateStreamTimerRef.current = null;
        }
        return;
      }
      if (!useChatStore.getState().isStreaming) {
        window.clearInterval(iv);
        if (simulateStreamTimerRef.current === iv) {
          simulateStreamTimerRef.current = null;
        }
        useChatStore.getState().updateMessage(convId, msgId, { isStreaming: false });
        return;
      }
      if (i < text.length) {
        useChatStore.getState().appendToMessage(convId, msgId, text.slice(i, i + 3));
        i += 3;
      } else {
        window.clearInterval(iv);
        if (simulateStreamTimerRef.current === iv) {
          simulateStreamTimerRef.current = null;
        }
        useChatStore.getState().updateMessage(convId, msgId, { isStreaming: false });
        setStreaming(false);
      }
    }, 18);
    simulateStreamTimerRef.current = iv;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleStop = () => {
    activeRunIdRef.current += 1;
    setStreaming(false);
    unlistenChunk.current?.(); unlistenDone.current?.();
    if (simulateStreamTimerRef.current !== null) {
      window.clearInterval(simulateStreamTimerRef.current);
      simulateStreamTimerRef.current = null;
    }
  };

  const activeModel = llmConfigs.find(c => c.id === activeModelId);
  const mcpModeLabel: Record<ChatMcpMode, string> = {
    disabled: 'MCP 禁用',
    manual: 'MCP 手动',
    auto: 'MCP 自动',
  };

  const isSkillCatalogQuery = (inputText: string) => {
    const normalized = inputText.toLowerCase();
    return (
      normalized.includes('skill') ||
      normalized.includes('技能') ||
      normalized.includes('会什么') ||
      normalized.includes('能干什么') ||
      normalized.includes('有什么能力')
    );
  };

  const buildSkillCatalogReply = (enabledSkillsList: typeof skills) => {
    if (enabledSkillsList.length === 0) {
      return '当前没有加载到任何已启用的 Skills。请先在工具集成中确认 Skills 是否已成功加载。';
    }

    const lines = ['当前已启用的 Skills 如下：', ''];

    enabledSkillsList.forEach(skill => {
      lines.push(`- ${skill.name}`);
      lines.push(`  用途：${skill.description}`);
      lines.push(`  类型：${skill.taskKind === 'managed' ? '托管任务' : '即时任务'}`);
      lines.push(`  标签：${skill.triggers.join('、') || '无'}`);
      lines.push(`  Server：${skill.serverId || '未绑定'}`);
      lines.push(`  Tool：${skill.toolName || skill.resolvedToolName || '默认工具'}`);
    });

    return lines.join('\n');
  };



  return (
    <div className="input-area">
      <div className="input-area-inner">
        <div className="input-box">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="描述你的运维需求..."
            rows={1}
          />

          <div className="input-controls">
            <div ref={modelRef} className="input-model-wrap">
              <button
                className="input-model-trigger"
                onClick={() => setModelOpen(open => !open)}
                title="切换模型"
              >
                <span className={`input-model-dot${activeModel ? ' online' : ''}`} />
                <span className="input-model-name">{activeModel ? activeModel.name : '选择模型'}</span>
                <ChevronDown size={12} />
              </button>

              {modelOpen && (
                <div className="input-model-menu">
                  {llmConfigs.length === 0 ? (
                    <div className="input-model-empty">请先在设置中添加 LLM 配置</div>
                  ) : (
                    <div className="input-model-list">
                      {llmConfigs.map(config => (
                        <button
                          key={config.id}
                          className={`input-model-option${config.id === activeModelId ? ' active' : ''}`}
                          onClick={() => {
                            setActiveModel(config.id);
                            setModelOpen(false);
                          }}
                        >
                          <div className="input-model-option-copy">
                            <span className="input-model-option-name">{config.name}</span>
                            <span className="input-model-option-provider">{providerLabel[config.provider]}</span>
                          </div>
                          {config.id === activeModelId && <Check size={13} className="input-model-option-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div ref={mcpModeRef} className="input-model-wrap">
              <button
                type="button"
                className="input-model-trigger"
                onClick={() => {
                  setMcpMenuStep('mode');
                  setMcpModeOpen(open => !open);
                }}
                title="切换 MCP 模式"
              >
                <span className={`input-model-dot${chatMcpMode !== 'disabled' ? ' online' : ''}`} />
                <span className="input-model-name">{mcpModeLabel[chatMcpMode]}</span>
                <ChevronDown size={12} />
              </button>

              {mcpModeOpen && (
                <div className="input-model-menu input-mcp-mode-menu">
                  {mcpMenuStep === 'mode' ? (
                    <div className="input-mcp-panel">
                      <div className="input-mcp-panel-section">
                        <div className="input-mcp-panel-label">MCP 模式</div>
                        <div className="input-mcp-mode-grid">
                          {(['disabled', 'manual', 'auto'] as ChatMcpMode[]).map(mode => (
                            <button
                              key={mode}
                              type="button"
                              className={`input-mcp-mode-card${mode === chatMcpMode ? ' active' : ''}`}
                              onClick={() => {
                                setChatMcpMode(mode);
                                if (mode === 'manual') {
                                  setMcpMenuStep('servers');
                                  return;
                                }
                                setMcpModeOpen(false);
                                setMcpMenuStep('mode');
                              }}
                            >
                              <div className="input-mcp-mode-card-head">
                                <span>{mcpModeLabel[mode]}</span>
                                {mode === chatMcpMode ? <Check size={13} className="input-model-option-check" /> : null}
                              </div>
                              <span className="input-mcp-mode-card-desc">
                                {mode === 'disabled' ? '不使用 MCP' : mode === 'manual' ? '选择特定服务器' : '允许自动规划'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="input-mcp-panel input-mcp-manual-panel">
                      <div className="input-mcp-panel-section">
                        <div className="input-mcp-submenu-head">
                          <button
                            type="button"
                            className="input-mcp-submenu-back"
                            onClick={() => setMcpMenuStep('mode')}
                          >
                            <ChevronLeft size={14} />
                            <span>返回</span>
                          </button>
                          <div className="input-mcp-panel-label">MCP 服务器</div>
                        </div>
                        {manualMcpServersLoading ? (
                          <div className="input-model-empty">正在加载 MCP 服务器</div>
                        ) : manualMcpServers.length === 0 ? (
                          <div className="input-model-empty">当前没有可用的已连接 MCP 服务器</div>
                        ) : (
                          <div className="input-model-list input-mcp-server-list">
                            {manualMcpServers.map(server => {
                              const value = server.name;
                              return (
                                <button
                                  key={value}
                                  type="button"
                                  className={`input-model-option input-mcp-server-option${value === selectedManualMcpServer ? ' active' : ''}`}
                                  onClick={() => {
                                    setSelectedManualMcpServer(value);
                                    setMcpModeOpen(false);
                                    setMcpMenuStep('mode');
                                  }}
                                  title={server.description || server.name}
                                >
                                  <div className="input-model-option-copy">
                                    <span className="input-model-option-name">{value}</span>
                                  </div>
                                  {value === selectedManualMcpServer && <Check size={13} className="input-model-option-check" />}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={`skills-runtime-indicator ${skillsLoading && !skillsInitialized ? 'loading' : skillsError ? 'error' : 'ready'}`}>
              {skillsLoading && !skillsInitialized
                ? 'Skills 加载中'
                : skillsError
                  ? 'Skills 加载失败'
                  : `Skills ${skills.filter(skill => skill.enabled).length} 个`}
            </div>

            {isStreaming ? (
              <button className="stop-btn" onClick={handleStop} title="停止">
                <Square size={14} />
              </button>
            ) : (
              <button
                data-send-trigger
                className="send-btn"
                onClick={handleSend}
                disabled={!input.trim()}
                title="发送"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default InputArea;
