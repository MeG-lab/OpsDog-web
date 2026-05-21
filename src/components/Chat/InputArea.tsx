import React from 'react';
import { Send, Square, ChevronDown, Check, ChevronLeft, FileText } from 'lucide-react';
import { useAppStore, useChatStore } from '../../stores';
import type { ChatExecutionPlan, ChatRouteDecision, ChatMcpMode, ExecutionResult, LLMProvider, MCPServerRecord, ServerDefinition, SkillPackageRecord, WorkflowExecutionResult } from '../../types';
import { createReportDraft, exportReportDraft, listMCPServers, buildChatExecutionPlan, onStreamChunk, sendChatMessageStream } from '../../services/runtime';
import type { RuntimeUnlistenFn } from '../../services/runtime';
import { buildIntentToolCatalog } from '../../services/runtime/intentCatalog';
import { isFilesystemMcpIntent } from '../../services/runtime/mcpChatPlanner';
import { executeSelectedCandidate } from '../../services/runtime/chatExecutor';

export interface InputAreaHandle {
  sendMessage: (text: string) => void;
}

const getTaskCapabilities = (servers: ServerDefinition[]) =>
  buildIntentToolCatalog(servers).filter((capability) => capability.category !== 'system' && !capability.skillPackageId);

const getEnabledSkillPackages = (packages: SkillPackageRecord[]) =>
  packages.filter((skillPackage) => skillPackage.enabled !== false);

const getRequiredFields = (schema?: Record<string, unknown>) => {
  const required = schema?.required;
  return Array.isArray(required) ? required.map((item) => String(item)).filter(Boolean) : [];
};

const isTypedNewReportRequest = (text: string) => (
  /(生成|整理|导出|做|输出).{0,12}报告|报告.{0,12}(生成|整理|导出|输出)/.test(text)
);

const resolveDraftExportFormats = (text: string): Array<'md' | 'pdf'> | null => {
  const wantsMarkdown = /\bmarkdown\b|\bmd\b|markdown\s*格式|md\s*(格式|文件|报告)/i.test(text);
  const wantsPdf = /\bpdf\b|pdf\s*(格式|文件|报告)/i.test(text);
  const wantsExport = /(导出|输出|生成文件|下载)/.test(text);
  if (!wantsExport) return null;
  if (wantsMarkdown && wantsPdf) return ['pdf', 'md'];
  if (wantsMarkdown) return ['md'];
  return ['pdf'];
};

const shouldReviseDraftOnly = (text: string) => {
  const referencesDraft = /(报告|草稿|标题|正文|章节|结论|建议|表格|格式)/.test(text);
  const editIntent = /(改|修改|调整|删|去掉|补充|加上|加入|改成|重写|精简|展开)/.test(text);
  const executionIntent = hasDraftExecutionIntent(text);
  return referencesDraft && editIntent && !executionIntent;
};

const hasDraftExecutionIntent = (text: string) => (
  /(检查|检测|执行|运行|抓取|读取|分析|查询|ping|mcp|工具|巡检)/i.test(text)
);

const shouldMergeExecutionIntoDraft = (text: string) => (
  /(加入|加到|写入|纳入|补充到|更新到).{0,12}(报告|草稿)|(报告|草稿).{0,12}(加入|加上|纳入|补充|更新)/.test(text)
);

const InputArea = React.forwardRef<InputAreaHandle, { onGenerateConversationReport: () => void }>(({ onGenerateConversationReport }, ref) => {
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

  const { getActiveModel, servers, skillPackages, llmConfigs, activeModelId, setActiveModel, chatMcpMode, setChatMcpMode, selectedManualMcpServer, setSelectedManualMcpServer } = useAppStore();
  const { activeConversationId, addMessage, isStreaming, setStreaming, createConversation } = useChatStore();
  const taskCapabilities = getTaskCapabilities(servers);
  const enabledSkillPackages = getEnabledSkillPackages(skillPackages);
  const mcpCapabilities = manualMcpServers
    .filter((server) => server.connected && server.capabilityEnabled !== false)
    .flatMap((server) => (server.tools || [])
      .filter((tool) => tool.enabled !== false)
      .map((tool) => ({
        ...tool,
        serverName: tool.serverName || server.name,
        riskLevel: tool.riskLevel || server.toolRiskOverrides?.[tool.name] || server.riskLevel || 'read-only',
      })));

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
    let cancelled = false;
    setManualMcpServersLoading(true);
    void listMCPServers()
      .then((servers) => {
        if (cancelled) return;
        const nextServers = servers.filter((server) => (
          server.connected &&
          server.capabilityEnabled !== false &&
          server.name !== 'filesystem'
        ));
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
      const isPlainModelAnswer = normalizedResult.kind === 'model'
        && normalizedResult.steps.length === 0
        && normalizedResult.artifacts.length === 0
        && normalizedResult.highlights.length === 0
        && normalizedResult.errors.length === 0;
      if (isPlainModelAnswer) {
        useChatStore.getState().updateMessage(convId!, assistantId, {
          content: normalizedResult.textFallback || normalizedResult.summary,
          executionResult: undefined,
          workflowResult: undefined,
          timestamp: Date.now(),
          isStreaming: false,
        });
        setStreaming(false);
        return;
      }
      useChatStore.getState().updateMessage(convId!, assistantId, {
        content: normalizedResult.textFallback || normalizedResult.summary,
        executionResult: normalizedResult,
        workflowResult: normalizedResult.kind === 'workflow' ? normalizedResult as WorkflowExecutionResult : undefined,
        timestamp: Date.now(),
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
    const streamTextResponse = async (request: Parameters<typeof sendChatMessageStream>[0]) => {
      let streamedText = '';
      unlistenChunk.current?.();
      unlistenChunk.current = await onStreamChunk(({ conversationId, messageId, chunk }) => {
        if (!isRunActive() || conversationId !== convId || messageId !== assistantId) return;
        streamedText += chunk;
        useChatStore.getState().appendToMessage(convId!, assistantId, chunk);
      });
      try {
        await sendChatMessageStream(request, convId!, assistantId);
      } finally {
        unlistenChunk.current?.();
        unlistenChunk.current = null;
      }
      const message = useChatStore.getState()
        .conversations.find((conversation) => conversation.id === convId)
        ?.messages.find((item) => item.id === assistantId);
      return message?.content || streamedText;
    };

    const activeDraft = useChatStore.getState().reportDrafts[convId!];

    if (!activeDraft && isTypedNewReportRequest(trimmed)) {
      simulateCurrentRun('报告草稿需要从对话上下文里取材。请点击某条助手消息旁的“报告”按钮，或点击输入区的报告图标整理当前对话。');
      return;
    }

    const draftExportFormats = activeDraft ? resolveDraftExportFormats(trimmed) : null;
    if (activeDraft && draftExportFormats && !hasDraftExecutionIntent(trimmed)) {
      try {
        const response = await exportReportDraft({ draft: activeDraft, formats: draftExportFormats });
        finalizeExecutionResult({
          ok: response.ok,
          kind: 'tool',
          summary: response.summary,
          steps: [],
          artifacts: response.outputs || [],
          highlights: [],
          errors: [],
          textFallback: response.summary,
        });
      } catch (error) {
        finalizeTextResult({
          ok: false,
          kind: 'error',
          summary: '报告导出失败。',
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
      return;
    }

    // Auto-title
    const conv = useChatStore.getState().conversations.find(c => c.id === convId);
    if (conv?.title === '新对话') {
      useChatStore.getState().updateTitle(convId!, trimmed.length > 22 ? trimmed.slice(0, 22) + '…' : trimmed);
    }


    if (!model) {
      simulateCurrentRun(`⚠️ **未配置模型**\n\n请点击右上角 ⚙️ 设置图标，添加 LLM 配置后即可对话。`);
      return;
    }

    if (activeDraft && shouldReviseDraftOnly(trimmed)) {
      try {
        const response = await createReportDraft({
          sourceScope: activeDraft.sourceScope,
          contextMessages: [{ role: 'user', content: trimmed }],
          instruction: trimmed,
          draft: activeDraft,
          formatSkillId: activeDraft.formatSkill?.id,
          model: {
            provider: model.provider,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            modelName: model.modelName,
            maxTokens: model.maxTokens,
            temperature: model.temperature,
          },
        });
        if (!response.draft) {
          throw new Error('报告草稿修订没有返回草稿内容。');
        }
        const nextDraft = {
          ...response.draft,
          previewMessageId: assistantId,
          sourceMessageId: activeDraft.sourceMessageId,
        };
        useChatStore.getState().setReportDraft(convId!, nextDraft);
        useChatStore.getState().updateMessage(convId!, assistantId, {
          content: `${nextDraft.summary}\n\n草稿预览已更新。`,
          transientKind: 'report-draft-preview',
          timestamp: Date.now(),
          isStreaming: false,
        });
        setStreaming(false);
      } catch (error) {
        finalizeTextResult({
          ok: false,
          kind: 'error',
          summary: '报告草稿修订失败。',
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
      return;
    }

    const currentConv = useChatStore.getState().conversations.find(c => c.id === convId);

    let executionPlan: ChatExecutionPlan | null = null;
    let routeDecision: ChatRouteDecision | null = null;
    try {
      executionPlan = await buildChatExecutionPlan(trimmed, {
        chatMcpMode,
        selectedManualMcpServer,
        model,
        conversationMessages: currentConv?.messages || [],
      });
      routeDecision = executionPlan.route;
    } catch (error) {
      console.warn('build_chat_execution_plan failed, fallback to local routing:', error);
    }

    if (routeDecision?.blocked) {
      simulateCurrentRun(`⚠️ **请求已被拦截**\n\n${routeDecision.blockReason || '当前输入命中了高风险指令策略，系统没有继续交给模型或本地执行层处理。'}`);
      return;
    }

    if (routeDecision ? routeDecision.intent === 'skill.catalog' : isTaskCapabilityCatalogQuery(trimmed)) {
      simulateCurrentRun(buildTaskCapabilityCatalogReply(taskCapabilities, enabledSkillPackages, mcpCapabilities));
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

    const selectedIsMcp = selectedCandidate?.type === 'mcp-tool' || Boolean(selectedCandidate?.type.startsWith('mcp.'));
    if (chatMcpMode === 'disabled' && (looksLikeMcpRequest || routeDecision?.allowMcp || selectedIsMcp)) {
      simulateCurrentRun('当前已禁用 MCP。请将输入区的 MCP 模式切换到“手动”或“自动”后再重试。');
      return;
    }

    if (routeDecision?.requiresConfirmation && !routeDecision.hasConfirmation) {
      useChatStore.getState().updateMessage(convId!, assistantId, {
        content: routeDecision.confirmationSummary || '当前请求需要确认后才能调用外部 MCP 工具。',
        confirmationRequest: {
          title: routeDecision.confirmationTitle || '外部工具调用确认',
          summary: routeDecision.confirmationSummary || '当前请求计划调用外部 MCP 工具。确认后我会继续执行。',
          token: routeDecision.confirmationToken || '确认调用工具',
          actionText: `${trimmed}\n\n${routeDecision.confirmationToken || '确认调用工具'}`,
        },
        timestamp: Date.now(),
        isStreaming: false,
      });
      setStreaming(false);
      return;
    }

    try {
      let result = await executeSelectedCandidate({
        selected: selectedCandidate,
        routeDecision,
        inputText: trimmed,
        chatMcpMode,
        selectedManualMcpServer,
        model,
        conversationMessages: currentConv?.messages || [],
        assistantMessageId: assistantId,
        isRunActive,
        streamTextResponse,
      });
      if (activeDraft && result.ok && (shouldMergeExecutionIntoDraft(trimmed) || (draftExportFormats && hasDraftExecutionIntent(trimmed)))) {
        try {
          const response = await createReportDraft({
            sourceScope: activeDraft.sourceScope,
            contextMessages: [
              { role: 'user', content: trimmed },
              {
                role: 'assistant',
                content: result.textFallback || result.summary,
                executionResult: result,
              },
            ],
            instruction: trimmed,
            draft: activeDraft,
            formatSkillId: activeDraft.formatSkill?.id,
            model: {
              provider: model.provider,
              apiKey: model.apiKey,
              baseUrl: model.baseUrl,
              modelName: model.modelName,
              maxTokens: model.maxTokens,
              temperature: model.temperature,
            },
          });
          if (response.draft) {
            const nextDraft = {
              ...response.draft,
              previewMessageId: assistantId,
              sourceMessageId: activeDraft.sourceMessageId,
            };
            useChatStore.getState().setReportDraft(convId!, nextDraft);
            result = {
              ...result,
              textFallback: [result.textFallback || result.summary, '', response.draft.summary].filter(Boolean).join('\n'),
            };
            if (draftExportFormats) {
              const exported = await exportReportDraft({ draft: nextDraft, formats: draftExportFormats });
              result = {
                ...result,
                artifacts: [...result.artifacts, ...(exported.outputs || [])],
                textFallback: [result.textFallback || result.summary, '', exported.summary].filter(Boolean).join('\n'),
              };
            }
          }
        } catch (error) {
          console.warn('Failed to merge execution result into report draft:', error);
        }
      }
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
        useChatStore.getState().updateMessage(convId, msgId, { timestamp: Date.now(), isStreaming: false });
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
        useChatStore.getState().updateMessage(convId, msgId, { timestamp: Date.now(), isStreaming: false });
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

  const isTaskCapabilityCatalogQuery = (inputText: string) => {
    const normalized = inputText.toLowerCase();
    return (
      normalized.includes('skill') ||
      normalized.includes('技能') ||
      normalized.includes('会什么') ||
      normalized.includes('能干什么') ||
      normalized.includes('有什么能力')
    );
  };

  const buildTaskCapabilityCatalogReply = (
    capabilities: typeof taskCapabilities,
    packages: typeof enabledSkillPackages,
    mcpTools: typeof mcpCapabilities,
  ) => {
    if (capabilities.length === 0 && packages.length === 0 && mcpTools.length === 0) {
      return '当前没有加载到可展示的任务能力、Skill 包能力或 MCP 外部能力。任务能力基于 Server / Tool 元数据识别，Skill 包基于已启用包识别，MCP 基于已连接外部服务识别。';
    }

    const lines = ['当前可调用能力如下：', ''];

    if (capabilities.length > 0) lines.push('任务能力：');
    capabilities.forEach((capability) => {
      const requiredFields = getRequiredFields(capability.inputSchema);
      lines.push(`- ${capability.serverName}/${capability.toolName}`);
      lines.push(`  用途：${capability.toolDescription || capability.serverDescription || '未填写'}`);
      lines.push(`  类型：${capability.category === 'managed' ? '托管任务能力' : '即时任务能力'}`);
      lines.push(`  必填参数：${requiredFields.length > 0 ? requiredFields.join('、') : '无'}`);
      if (capability.usageExamples?.length) {
        lines.push(`  示例：${capability.usageExamples.slice(0, 2).join('；')}`);
      }
    });

    if (packages.length > 0) lines.push('', 'Skill 包：');
    packages.forEach((skillPackage) => {
      lines.push(`- ${skillPackage.name}`);
      lines.push(`  类型：${skillPackage.kind === 'executable' ? '可执行 Skill 包' : '模型上下文 Skill'}`);
      lines.push(`  用途：${skillPackage.description || '未填写'}`);
      if (skillPackage.tools?.length) {
        lines.push(`  工具：${skillPackage.tools.map((tool) => tool.name).join('、')}`);
      }
      if (skillPackage.dependencies?.length) {
        lines.push(`  依赖状态：${skillPackage.dependencyStatus}`);
      }
    });

    if (mcpTools.length > 0) lines.push('', 'MCP 外部能力：');
    mcpTools.forEach((tool) => {
      const requiredFields = getRequiredFields(tool.inputSchema);
      lines.push(`- ${tool.serverName}/${tool.name}`);
      lines.push(`  用途：${tool.description || '未填写'}`);
      lines.push(`  风险：${tool.riskLevel || 'read-only'}`);
      lines.push(`  必填参数：${requiredFields.length > 0 ? requiredFields.join('、') : '无'}`);
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

            <div className="capabilities-runtime-indicator ready">
              {taskCapabilities.length + enabledSkillPackages.length + mcpCapabilities.length > 0
                ? `任务 ${taskCapabilities.length} / Skill ${enabledSkillPackages.length} / MCP ${mcpCapabilities.length}`
                : '能力就绪'}
            </div>

            {isStreaming ? (
              <button className="stop-btn" onClick={handleStop} title="停止">
                <Square size={14} />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="input-report-btn"
                  onClick={onGenerateConversationReport}
                  title="将当前对话整理成报告草稿"
                >
                  <FileText size={14} />
                </button>
                <button
                  data-send-trigger
                  className="send-btn"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="发送"
                >
                  <Send size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default InputArea;
