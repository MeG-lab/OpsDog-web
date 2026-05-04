import React from 'react';
import { Bot, User, Copy, Check, BellRing, ShieldAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '../../stores';
import type { Message } from '../../types';

const MessageBubble: React.FC<{
  message: Message;
  onConfirmationAction: (text: string) => void;
}> = ({ message, onConfirmationAction }) => {
  const [copied, setCopied] = React.useState(false);
  const { content, role, isStreaming, confirmationRequest } = message;
  const displayContent = React.useMemo(() => sanitizeAssistantDisplay(content), [content]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUser = role === 'user';

  return (
    <div className={`msg-row${isUser ? ' user' : ''}`}>
      <div className={`msg-avatar ${isUser ? 'user' : 'ai'}`}>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="msg-content">
        <div className="msg-meta">{isUser ? 'You' : 'AIops'}</div>
        <div className={`msg-bubble ${isUser ? 'user' : 'ai'}`}>
          {isUser ? (
            <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
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
        </div>
        {!isUser && displayContent && (
          <div className="msg-actions">
            <button className="btn btn-ghost btn-compact" onClick={handleCopy}>
              {copied ? <><Check size={11} /> 已复制</> : <><Copy size={11} /> 复制</>}
            </button>
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
  const sanitized = content
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .trim();

  if (sanitized) return sanitized;
  if (/<invoke\b|<parameter\b/i.test(content)) {
    return '⚠️ 系统已拦截一段无效的内部工具调用文本，没有将其直接展示给你。';
  }
  return content;
};

const EmptyState: React.FC<{ onQuickAction: (text: string) => void }> = ({ onQuickAction }) => {
  const actions = ['查看服务器状态', '分析系统日志', '检查服务运行情况', '生成巡检报告'];
  return (
    <div className="empty-state">
      <div className="empty-state-mark">
        <Bot size={24} />
      </div>
      <div className="empty-state-copy">
        <div className="empty-state-kicker">AI 运维中枢</div>
        <div className="empty-state-title">AIops智能运维中枢</div>
        <div className="empty-state-desc">通过自然语言描述你的运维需求，我将调用合适的工具和任务能力协助你完成操作。</div>
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
        这里专门承载托管任务告警、恢复通知以及后续的系统级事件。
        当前还没有新的系统通知。
      </div>
    </div>
  </div>
);

const MessageList: React.FC<{
  onQuickAction: (text: string) => void;
  onConfirmationAction: (text: string) => void;
  isSystemConversation?: boolean;
}> = ({ onQuickAction, onConfirmationAction, isSystemConversation = false }) => {
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const messages = conv?.messages || [];
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  if (messages.length === 0) {
    return isSystemConversation ? <SystemEmptyState /> : <EmptyState onQuickAction={onQuickAction} />;
  }

  return (
    <div className="messages-container">
      <div className="messages-inner">
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} onConfirmationAction={onConfirmationAction} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default MessageList;
