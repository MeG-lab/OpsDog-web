import React from 'react';
import { Bot, User, Copy, Check, BellRing, FileDown, FileText, ShieldAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '../../stores';
import type { Message, ReportDraft } from '../../types';

const padTimestampPart = (value: number) => String(value).padStart(2, '0');

const formatMessageTimestamp = (timestamp: number) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return [
    `${date.getFullYear()}-${padTimestampPart(date.getMonth() + 1)}-${padTimestampPart(date.getDate())}`,
    `${padTimestampPart(date.getHours())}:${padTimestampPart(date.getMinutes())}`,
  ].join(' ');
};

const ReportDraftCard: React.FC<{
  draft: ReportDraft;
  onExportReport: (draft: ReportDraft, format: 'pdf' | 'md') => void;
}> = ({ draft, onExportReport }) => (
  <div className="report-draft-card">
    <div className="report-draft-card-head">
      <div>
        <span>{draft.sourceScope === 'message' ? '单次输出报告草稿' : '当前对话报告草稿'}</span>
        <strong>{draft.title}</strong>
      </div>
      {draft.formatSkill ? <em title={draft.formatSkill.description || draft.formatSkill.id}>{draft.formatSkill.name}</em> : null}
    </div>
    <div className="report-draft-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.markdown}</ReactMarkdown>
    </div>
    <div className="report-draft-actions">
      <button type="button" className="btn btn-ghost btn-compact" onClick={() => onExportReport(draft, 'pdf')}>
        <FileDown size={12} />
        <span>导出 PDF</span>
      </button>
      <button type="button" className="btn btn-ghost btn-compact" onClick={() => onExportReport(draft, 'md')}>
        <FileText size={12} />
        <span>导出 MD</span>
      </button>
    </div>
  </div>
);

const MessageBubble: React.FC<{
  message: Message;
  onConfirmationAction: (text: string) => void;
  onGenerateReport: (message: Message) => void;
  onExportReport: (draft: ReportDraft, format: 'pdf' | 'md') => void;
  reportDraft?: ReportDraft;
  isSystemConversation?: boolean;
}> = ({ message, onConfirmationAction, onGenerateReport, onExportReport, reportDraft, isSystemConversation = false }) => {
  const [copied, setCopied] = React.useState(false);
  const { content, role, isStreaming, confirmationRequest, workflowResult, executionResult } = message;
  const structuredResult = executionResult || workflowResult;
  const hasReportArtifact = structuredResult?.artifacts.some((artifact) => (
    String(artifact.path || '').includes('/reports/') ||
    String(artifact.downloadUrl || '').includes('/api/reports/')
  ));
  const displayContent = React.useMemo(() => sanitizeAssistantDisplay(content), [content]);
  const displayStructuredSummary = React.useMemo(
    () => sanitizeAssistantDisplay(structuredResult?.summary || ''),
    [structuredResult?.summary],
  );
  const displayStructuredFallback = React.useMemo(
    () => sanitizeAssistantDisplay(structuredResult?.textFallback || ''),
    [structuredResult?.textFallback],
  );
  const shouldShowStructuredSummary = Boolean(
    displayStructuredSummary &&
    displayStructuredSummary.trim() !== displayStructuredFallback.trim()
  );

  const handleCopy = async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUser = role === 'user';
  const assistantTimestamp = role === 'assistant' && !isStreaming
    ? formatMessageTimestamp(message.timestamp)
    : '';

  return (
    <div className={`msg-row${isUser ? ' user' : ''}${isSystemConversation ? ' system-channel-row' : ''}`}>
      <div className={`msg-avatar ${isUser ? 'user' : 'ai'}`}>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className={`msg-content${isSystemConversation ? ' system-channel-content' : ''}`}>
        <div className="msg-meta">{isUser ? 'You' : 'OpsDog'}</div>
        <div className={`msg-bubble ${isUser ? 'user' : 'ai'}${isSystemConversation ? ' system-channel-bubble' : ''}`}>
          {isUser ? (
            <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
          ) : structuredResult ? (
            <div className="workflow-result-card">
              {shouldShowStructuredSummary ? <div className="workflow-result-summary">{displayStructuredSummary}</div> : null}
              {structuredResult.highlights.length > 0 && (
                <div className="workflow-section">
                  <div className="workflow-section-title">关键发现</div>
                  <ul className="workflow-list">
                    {structuredResult.highlights.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                </div>
              )}
              {structuredResult.steps.length > 0 && (
                <div className="workflow-section">
                  <div className="workflow-section-title">执行步骤</div>
                  <div className="workflow-steps">
                    {structuredResult.steps.map((step) => (
                      <div key={step.id} className={`workflow-step ${step.status}`}>
                        <div className="workflow-step-head">
                          <strong>{step.title}</strong>
                          <span>{step.status === 'completed' ? '完成' : step.status === 'failed' ? '失败' : '跳过'}</span>
                        </div>
                        {step.summary ? <div className="workflow-step-body">{sanitizeAssistantDisplay(step.summary)}</div> : null}
                        {step.findings && step.findings.length > 0 ? (
                          <ul className="workflow-list">
                            {step.findings.map((item, index) => <li key={`${step.id}-finding-${index}`}>{item}</li>)}
                          </ul>
                        ) : null}
                        {step.error ? <div className="workflow-step-error">{step.error}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {structuredResult.artifacts.length > 0 && (
                <div className="workflow-section">
                  <div className="workflow-section-title">产物文件</div>
                  <div className="workflow-artifacts">
                    {structuredResult.artifacts.map((artifact, index) => (
                      <div key={`${artifact.fileName || artifact.path || 'artifact'}-${index}`} className="workflow-artifact">
                        <div className="workflow-artifact-meta">
                          <strong>{artifact.fileName || '未命名文件'}</strong>
                          <span>{artifact.mimeType || 'application/octet-stream'}</span>
                        </div>
                        {artifact.downloadUrl ? <a className="btn btn-ghost btn-compact" href={artifact.downloadUrl} target="_blank" rel="noreferrer">下载</a> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {displayStructuredFallback ? (
                <div className="workflow-section">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayStructuredFallback}</ReactMarkdown>
                </div>
              ) : null}
              {structuredResult.errors.length > 0 && (
                <div className="workflow-section">
                  <div className="workflow-section-title">错误</div>
                  <ul className="workflow-list error">
                    {structuredResult.errors.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <>
              {displayContent ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ node, className, children, ...props }: any) {
                      const inline = !className;
                      if (inline) return <code {...props}>{children}</code>;
                      const lang = (className || '').replace('language-', '');
                      return (
                        <div className="code-block">
                          <div className="code-block-header">
                            <span>{lang || 'code'}</span>
                            <button className="code-copy-btn" onClick={async () => {
                              await navigator.clipboard.writeText(String(children));
                            }}>复制</button>
                          </div>
                          <pre><code>{children}</code></pre>
                        </div>
                      );
                    },
                  }}
                >
                  {displayContent}
                </ReactMarkdown>
              ) : isStreaming ? (
                <div className="typing-dot">
                  <span /><span /><span />
                </div>
              ) : null}
            </>
          )}
          {!isUser && reportDraft ? <ReportDraftCard draft={reportDraft} onExportReport={onExportReport} /> : null}
        </div>
        {assistantTimestamp ? (
          <time className="msg-timestamp" dateTime={new Date(message.timestamp).toISOString()}>
            {assistantTimestamp}
          </time>
        ) : null}
        {!isUser && displayContent && (
          <div className="msg-actions">
            <button className="btn btn-ghost btn-compact" onClick={handleCopy}>
              {copied ? <><Check size={11} /> 已复制</> : <><Copy size={11} /> 复制</>}
            </button>
            {!isSystemConversation && message.transientKind !== 'report-draft-preview' && !hasReportArtifact ? (
              <button className="btn btn-ghost btn-compact" onClick={() => onGenerateReport(message)} title="将这次输出整理成报告草稿">
                <FileText size={11} />
                <span>报告</span>
              </button>
            ) : null}
          </div>
        )}
        {!isUser && confirmationRequest && (
          <div className="confirmation-card">
            <div className="confirmation-card-head">
              <ShieldAlert size={14} />
              <span>{confirmationRequest.title}</span>
            </div>
            <p>{confirmationRequest.summary}</p>
            <div className="confirmation-card-token">确认口令：{confirmationRequest.token}</div>
            <button
              className="btn btn-primary btn-compact"
              onClick={() => onConfirmationAction(confirmationRequest.actionText)}
            >
              继续执行
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const sanitizeAssistantDisplay = (content: string) => {
  if (!content) return content;
  const markerMatch = content.match(/(?:最终答案|最终回答|正式回答|回答|Final answer|Answer)\s*[：:]\s*/i);
  const startsWithReasoning = /^\s*(?:思考过程|推理过程|分析过程|内部思考|Reasoning|Thought process|Thinking)\s*[：:]/i.test(content);
  const source = startsWithReasoning && markerMatch?.index !== undefined
    ? content.slice(markerMatch.index + markerMatch[0].length)
    : content;
  const sanitized = source
    .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*$/i, '')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/\[TOOL\][\s\S]*?\[\/TOOL\]/gi, '')
    .trim();

  if (sanitized) return sanitized;
  if (/<invoke\b|<parameter\b|\[TOOL\]|<(think|thinking|reasoning)\b/i.test(content)) {
    return '⚠️ 系统已拦截一段内部思考或无效工具调用文本，没有将其直接展示给你。';
  }
  return content;
};

const EmptyState: React.FC<{ onQuickAction: (text: string) => void }> = ({ onQuickAction }) => {
  const actions = ['查看服务器状态', '分析系统日志', '检查服务运行情况'];
  return (
    <div className="empty-state">
      <div className="empty-state-mark">
        <Bot size={24} />
      </div>
      <div className="empty-state-copy">
        <div className="empty-state-kicker">OpsDog</div>
        <div className="empty-state-title">运维助手</div>
        <div className="empty-state-desc">直接描述需求，我会调用对应工具处理。</div>
      </div>
      <div className="quick-actions">
        {actions.map(a => (
          <button key={a} className="quick-action-btn" onClick={() => onQuickAction(a)}>{a}</button>
        ))}
      </div>
    </div>
  );
};

const SystemEmptyState: React.FC = () => (
  <div className="empty-state system-notice-empty">
    <div className="empty-state-mark">
      <BellRing size={24} />
    </div>
    <div className="empty-state-copy">
      <div className="empty-state-kicker">System Channel</div>
      <div className="empty-state-title">系统通告</div>
      <div className="empty-state-desc">
        这里显示托管任务告警和系统事件。
        当前没有新通知。
      </div>
    </div>
    <div className="system-empty-actions-spacer" aria-hidden="true" />
  </div>
);

const MessageList: React.FC<{
  onQuickAction: (text: string) => void;
  onConfirmationAction: (text: string) => void;
  onGenerateReport: (message: Message) => void;
  onExportReport: (draft: ReportDraft, format: 'pdf' | 'md') => void;
  isSystemConversation?: boolean;
}> = ({ onQuickAction, onConfirmationAction, onGenerateReport, onExportReport, isSystemConversation = false }) => {
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const reportDraft = useChatStore(s => s.activeConversationId ? s.reportDrafts[s.activeConversationId] : undefined);
  const messages = conv?.messages || [];
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  if (messages.length === 0) {
    return isSystemConversation ? <SystemEmptyState /> : <EmptyState onQuickAction={onQuickAction} />;
  }

  return (
    <div className={`messages-container${isSystemConversation ? ' system-channel-messages' : ''}`}>
      <div className={`messages-inner${isSystemConversation ? ' system-channel-messages-inner' : ''}`}>
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onConfirmationAction={onConfirmationAction}
            onGenerateReport={onGenerateReport}
            onExportReport={onExportReport}
            reportDraft={reportDraft?.previewMessageId === msg.id ? reportDraft : undefined}
            isSystemConversation={isSystemConversation}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default MessageList;
