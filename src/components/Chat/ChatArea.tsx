import React from 'react';
import MessageList from './MessageList';
import InputArea, { type InputAreaHandle } from './InputArea';
import { useChatStore } from '../../stores';

const ChatArea: React.FC = () => {
  const inputRef = React.useRef<InputAreaHandle>(null);
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId));
  const isSystemConversation = conv?.kind === 'system';

  const handleQuickAction = (text: string) => {
    inputRef.current?.sendMessage(text);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <MessageList
        onQuickAction={handleQuickAction}
        onConfirmationAction={handleQuickAction}
        isSystemConversation={isSystemConversation}
      />
      {isSystemConversation ? (
        <div className="system-channel-readonly">
          <div className="system-channel-readonly-inner">
            系统通告是只读消息流，用于展示托管任务告警、恢复和后续系统事件。
          </div>
        </div>
      ) : (
        <InputArea ref={inputRef} />
      )}
    </div>
  );
};

export default ChatArea;
