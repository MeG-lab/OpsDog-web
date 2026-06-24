import React from 'react';
import MessageList from './MessageList';
import InputArea, { type ChatRemoteInputContext, type InputAreaHandle } from './InputArea';
import ChatRemotePermissionShell, { type ChatRemoteTerminalSelection } from './ChatRemotePermissionShell';
import { useAppStore, useChatStore } from '../../stores';
import { createReportDraft, exportReportDraft } from '../../services/runtime';
import type { Message, ReportContextMessage, ReportDraft, ReportFormatSkillOption, ReportSourceScope, SkillPackageRecord, WorkflowExecutionArtifact } from '../../types';

type PendingReportRequest = {
  sourceScope: ReportSourceScope;
  contextMessages: ReportContextMessage[];
  sourceMessageId?: string;
  formatSkills: ReportFormatSkillOption[];
};

type RemoteTerminalConnectionState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

type RemoteOutputWaitOptions = {
  completionMarker?: string;
};

const reportContextMessage = (message: Message): ReportContextMessage | null => {
  if (message.role === 'system' || message.transientKind === 'report-draft-preview') return null;
  const executionResult = message.executionResult || message.workflowResult;
  const hasReportArtifact = executionResult?.artifacts.some((artifact) => (
    String(artifact.path || '').includes('/reports/') ||
    String(artifact.downloadUrl || '').includes('/api/reports/')
  ));
  if (hasReportArtifact) return null;
  const content = String(message.content || '').trim();
  if (!content && !executionResult) return null;
  return {
    id: message.id,
    role: message.role,
    content,
    timestamp: message.timestamp,
    executionResult,
  };
};

const reportFormatSkills = (packages: SkillPackageRecord[]) => packages
  .filter((skill) => skill.enabled !== false && skill.reportFormat && skill.instructionText)
  .map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
  }));

const ChatArea: React.FC = () => {
  const inputRef = React.useRef<InputAreaHandle>(null);
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const addMessage = useChatStore(s => s.addMessage);
  const updateMessage = useChatStore(s => s.updateMessage);
  const setReportDraft = useChatStore(s => s.setReportDraft);
  const getActiveModel = useAppStore(s => s.getActiveModel);
  const skillPackages = useAppStore(s => s.skillPackages);
  const [pendingReport, setPendingReport] = React.useState<PendingReportRequest | null>(null);
  const [generatingReport, setGeneratingReport] = React.useState(false);
  const [remoteTerminalSelection, setRemoteTerminalSelection] = React.useState<ChatRemoteTerminalSelection | null>(null);
  const [remoteTerminalSessionId, setRemoteTerminalSessionId] = React.useState<string | null>(null);
  const [remoteTerminalConnectionState, setRemoteTerminalConnectionState] = React.useState<RemoteTerminalConnectionState>('idle');
  const [remoteTerminalOutputTail, setRemoteTerminalOutputTail] = React.useState('');
  const remoteTerminalOutputRef = React.useRef('');
  const remoteTerminalConnectionStateRef = React.useRef<RemoteTerminalConnectionState>('idle');
  const isSystemConversation = conv?.kind === 'system';
  const remoteTerminalContext: ChatRemoteInputContext | null = remoteTerminalSelection
    && remoteTerminalSessionId
    && remoteTerminalConnectionState === 'connected'
    ? {
        ...remoteTerminalSelection,
        sessionId: remoteTerminalSessionId,
        recentOutput: remoteTerminalOutputTail,
        waitForOutput: waitForRemoteTerminalOutput,
      }
    : null;

  React.useEffect(() => {
    setRemoteTerminalSessionId(null);
    setRemoteTerminalConnectionState('idle');
    remoteTerminalConnectionStateRef.current = 'idle';
    setRemoteTerminalOutputTail('');
    remoteTerminalOutputRef.current = '';
  }, [remoteTerminalSelection?.device.id, remoteTerminalSelection?.profile.id]);

  const handleRemoteTerminalOutput = React.useCallback((data: string) => {
    const next = `${remoteTerminalOutputRef.current}${data}`.slice(-12000);
    remoteTerminalOutputRef.current = next;
    setRemoteTerminalOutputTail(next);
  }, []);

  async function waitForRemoteTerminalOutput(
    baselineOutput: string,
    options: RemoteOutputWaitOptions = {},
  ): Promise<string> {
    const completionMarker = options.completionMarker || '';
    const startedAt = Date.now();
    let lastOutput = remoteTerminalOutputRef.current;
    let lastChangedAt = Date.now();
    const minWaitMs = completionMarker ? 500 : 2500;
    const quietWindowMs = completionMarker ? 900 : 1800;
    const maxWaitMs = completionMarker ? 60000 : 15000;

    return await new Promise((resolve) => {
      const poll = () => {
        const currentOutput = remoteTerminalOutputRef.current;
        const hasNewOutput = currentOutput !== baselineOutput;
        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastChangedAt = Date.now();
        }

        const elapsedMs = Date.now() - startedAt;
        const connectionState = remoteTerminalConnectionStateRef.current;
        const isDisconnected = connectionState === 'closed' || connectionState === 'error';
        const markerArrived = Boolean(
          completionMarker
          && new RegExp(`${completionMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`).test(currentOutput),
        );
        const outputSettled = hasNewOutput && elapsedMs >= minWaitMs && Date.now() - lastChangedAt >= quietWindowMs;
        if (markerArrived || outputSettled || isDisconnected || elapsedMs >= maxWaitMs) {
          resolve(currentOutput);
          return;
        }

        window.setTimeout(poll, 150);
      };

      window.setTimeout(poll, 150);
    });
  }

  const handleRemoteSessionReady = React.useCallback((sessionId: string) => {
    setRemoteTerminalSessionId(sessionId);
    setRemoteTerminalConnectionState('connected');
    remoteTerminalConnectionStateRef.current = 'connected';
  }, []);

  const handleRemoteSessionClosed = React.useCallback(() => {
    setRemoteTerminalSessionId(null);
    setRemoteTerminalConnectionState('closed');
    remoteTerminalConnectionStateRef.current = 'closed';
  }, []);

  const handleRemoteConnectionStateChange = React.useCallback((state: RemoteTerminalConnectionState) => {
    setRemoteTerminalConnectionState(state);
    remoteTerminalConnectionStateRef.current = state;
    if (state === 'closed' || state === 'error') {
      setRemoteTerminalSessionId(null);
    }
  }, []);

  const closeRemoteTerminal = React.useCallback(() => {
    setRemoteTerminalSelection(null);
    setRemoteTerminalSessionId(null);
    setRemoteTerminalConnectionState('idle');
    remoteTerminalConnectionStateRef.current = 'idle';
    setRemoteTerminalOutputTail('');
    remoteTerminalOutputRef.current = '';
  }, []);

  const handleQuickAction = (text: string) => {
    inputRef.current?.sendMessage(text);
  };

  const addReportNotice = React.useCallback((conversationId: string, content: string) => (
    addMessage(conversationId, {
      role: 'assistant',
      content,
      transientKind: 'report-draft-preview',
    })
  ), [addMessage]);

  const runDraftRequest = React.useCallback(async (
    request: Omit<PendingReportRequest, 'formatSkills'>,
    formatSkillId?: string,
  ) => {
    const activeConversation = useChatStore.getState().conversations.find((item) => item.id === useChatStore.getState().activeConversationId);
    const model = getActiveModel();
    if (!activeConversation || activeConversation.kind === 'system') return;
    if (!model) {
      addReportNotice(activeConversation.id, '当前还没有可用模型，配置模型后再生成报告草稿。');
      return;
    }

    const previewMessageId = addReportNotice(activeConversation.id, '正在整理报告草稿...');
    setGeneratingReport(true);
    try {
      const response = await createReportDraft({
        sourceScope: request.sourceScope,
        contextMessages: request.contextMessages,
        formatSkillId,
        model: {
          provider: model.provider,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          modelName: model.modelName,
          maxTokens: model.maxTokens,
          temperature: model.temperature,
        },
      });
      if (response.requiresFormatSelection) {
        updateMessage(activeConversation.id, previewMessageId, {
          content: '请选择一个报告格式后继续生成草稿。',
          isStreaming: false,
        });
        setPendingReport({
          ...request,
          formatSkills: response.formatSkills || [],
        });
        return;
      }
      if (!response.draft) {
        throw new Error('报告草稿生成没有返回草稿内容。');
      }
      const draft: ReportDraft = {
        ...response.draft,
        previewMessageId,
        sourceMessageId: request.sourceMessageId,
      };
      setReportDraft(activeConversation.id, draft);
      updateMessage(activeConversation.id, previewMessageId, {
        content: `${draft.summary}\n\n可以继续描述要调整的内容，或直接导出。`,
        isStreaming: false,
      });
      setPendingReport(null);
    } catch (error) {
      updateMessage(activeConversation.id, previewMessageId, {
        content: error instanceof Error ? `报告草稿生成失败：${error.message}` : '报告草稿生成失败。',
        isStreaming: false,
      });
    } finally {
      setGeneratingReport(false);
    }
  }, [addReportNotice, getActiveModel, setReportDraft, updateMessage]);

  const queueDraftRequest = React.useCallback((request: Omit<PendingReportRequest, 'formatSkills'>) => {
    const formatSkills = reportFormatSkills(skillPackages);
    if (formatSkills.length > 1) {
      setPendingReport({ ...request, formatSkills });
      return;
    }
    void runDraftRequest(request, formatSkills[0]?.id);
  }, [runDraftRequest, skillPackages]);

  const handleMessageReport = React.useCallback((message: Message) => {
    if (!conv || conv.kind === 'system') return;
    const index = conv.messages.findIndex((item) => item.id === message.id);
    if (index === -1) return;
    const assistantContext = reportContextMessage(message);
    const precedingUser = [...conv.messages.slice(0, index)]
      .reverse()
      .find((item) => item.role === 'user');
    const userContext = precedingUser ? reportContextMessage(precedingUser) : null;
    const contextMessages = [userContext, assistantContext].filter(Boolean) as ReportContextMessage[];
    queueDraftRequest({
      sourceScope: 'message',
      contextMessages,
      sourceMessageId: message.id,
    });
  }, [conv, queueDraftRequest]);

  const handleConversationReport = React.useCallback(() => {
    if (!conv || conv.kind === 'system') return;
    queueDraftRequest({
      sourceScope: 'conversation',
      contextMessages: conv.messages.map(reportContextMessage).filter(Boolean) as ReportContextMessage[],
    });
  }, [conv, queueDraftRequest]);

  const handleExportDraft = React.useCallback(async (draft: ReportDraft, format: 'pdf' | 'md') => {
    const activeConversation = useChatStore.getState().conversations.find((item) => item.id === useChatStore.getState().activeConversationId);
    if (!activeConversation || activeConversation.kind === 'system') return;
    const exportMessageId = addMessage(activeConversation.id, {
      role: 'assistant',
      content: '正在导出报告...',
    });
    try {
      const response = await exportReportDraft({ draft, formats: [format] });
      const outputs = (response.outputs || []).map((artifact: WorkflowExecutionArtifact) => ({
        ...artifact,
        downloadUrl: artifact.fileName
          ? `${window.location.origin}/api/reports/${encodeURIComponent(artifact.fileName)}/download`
          : undefined,
      }));
      updateMessage(activeConversation.id, exportMessageId, {
        content: response.summary,
        executionResult: {
          ok: response.ok,
          kind: 'tool',
          summary: response.summary,
          steps: [],
          artifacts: outputs,
          highlights: [],
          errors: [],
          textFallback: response.summary,
        },
      });
    } catch (error) {
      updateMessage(activeConversation.id, exportMessageId, {
        content: error instanceof Error ? `报告导出失败：${error.message}` : '报告导出失败。',
      });
    }
  }, [addMessage, updateMessage]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <MessageList
        onQuickAction={handleQuickAction}
        onConfirmationAction={handleQuickAction}
        onGenerateReport={handleMessageReport}
        onExportReport={handleExportDraft}
        isSystemConversation={isSystemConversation}
      />
      {isSystemConversation ? (
        <div className="system-channel-spacer" aria-hidden="true" />
      ) : (
        <>
          {remoteTerminalSelection ? (
            <ChatRemotePermissionShell
              device={remoteTerminalSelection.device}
              profile={remoteTerminalSelection.profile}
              onSessionReady={handleRemoteSessionReady}
              onSessionClosed={handleRemoteSessionClosed}
              onConnectionStateChange={handleRemoteConnectionStateChange}
              onOutput={handleRemoteTerminalOutput}
              onClose={closeRemoteTerminal}
            />
          ) : null}
          <InputArea
            ref={inputRef}
            onGenerateConversationReport={handleConversationReport}
            onOpenRemoteDeviceTerminal={setRemoteTerminalSelection}
            selectedRemoteDeviceId={remoteTerminalSelection?.device.id ?? null}
            remoteTerminalContext={remoteTerminalContext}
          />
        </>
      )}
      {pendingReport ? (
        <div className="report-format-picker-backdrop" onMouseDown={() => setPendingReport(null)}>
          <div className="report-format-picker" onMouseDown={(event) => event.stopPropagation()}>
            <div className="report-format-picker-head">
              <strong>选择报告格式</strong>
              <span>{pendingReport.sourceScope === 'message' ? '单次输出报告' : '当前对话报告'}</span>
            </div>
            <div className="report-format-picker-list">
              {pendingReport.formatSkills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className="report-format-picker-option"
                  disabled={generatingReport}
                  onClick={() => void runDraftRequest(pendingReport, skill.id)}
                >
                  <strong>{skill.name}</strong>
                  <span>{skill.description || skill.id}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ChatArea;
