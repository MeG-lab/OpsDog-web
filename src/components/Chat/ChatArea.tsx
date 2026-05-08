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
        <div className="system-channel-spacer" aria-hidden="true" />
      ) : (
        <InputArea ref={inputRef} />
      )}
    </div>
  );
};

export default ChatArea;
