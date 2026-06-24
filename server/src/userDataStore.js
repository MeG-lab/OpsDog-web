const CONFIG_SETTING_KEY = 'runtime_config';

const nowIso = () => new Date().toISOString();
const safeParseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const defaultConfig = () => ({
  llmConfigs: [],
  activeModelId: null,
});

const stripTransientMessageState = (message = {}) => {
  const { isStreaming, ...rest } = message;
  return rest;
};

const normalizeConversation = (conversation = {}, fallbackKind = 'normal') => ({
  id: String(conversation.id || ''),
  title: String(conversation.title || '新对话'),
  kind: conversation.kind === 'system' ? 'system' : fallbackKind,
  modelId: conversation.modelId || '',
  systemChannel: conversation.systemChannel || null,
  lastReadAt: conversation.lastReadAt ?? null,
  createdAt: Number(conversation.createdAt || Date.now()),
  updatedAt: Number(conversation.updatedAt || conversation.createdAt || Date.now()),
  messages: Array.isArray(conversation.messages)
    ? conversation.messages.map(stripTransientMessageState)
    : [],
});

export const createUserDataStore = (database) => {
  if (!database) throw new Error('database is required');

  const loadMessages = (conversationId) => database.all(`
    SELECT payload_json
    FROM conversation_messages
    WHERE conversation_id = ?
    ORDER BY position ASC
  `, conversationId).map((row) => safeParseJson(row.payload_json, {}));

  const saveMessages = (conversationId, messages = []) => {
    database.run('DELETE FROM conversation_messages WHERE conversation_id = ?', conversationId);
    messages.map(stripTransientMessageState).forEach((message, index) => {
      const timestamp = nowIso();
      database.run(`
        INSERT INTO conversation_messages
          (conversation_id, id, position, role, content, timestamp, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, conversationId, String(message.id), index, String(message.role || 'assistant'),
      String(message.content || ''), message.timestamp ?? null, JSON.stringify(message), timestamp, timestamp);
    });
  };

  const saveConversation = (userId, conversation) => {
    const normalized = normalizeConversation(conversation, 'normal');
    if (!normalized.id) throw new Error('conversation id is required');
    const ownerId = normalized.kind === 'system' ? null : userId;
    database.run(`
      INSERT INTO conversations
        (id, user_id, title, kind, model_id, system_channel, last_read_at, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        title = excluded.title,
        kind = excluded.kind,
        model_id = excluded.model_id,
        system_channel = excluded.system_channel,
        last_read_at = excluded.last_read_at,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `, normalized.id, ownerId, normalized.title, normalized.kind, normalized.modelId,
    normalized.systemChannel, normalized.lastReadAt, JSON.stringify({ ...normalized, messages: undefined }),
    normalized.createdAt, normalized.updatedAt);
    saveMessages(normalized.id, normalized.messages);
    return normalized;
  };

  const loadConversationRows = (userId) => database.all(`
    SELECT *
    FROM conversations
    WHERE (kind = 'system' AND user_id IS NULL)
       OR (kind = 'normal' AND user_id = ?)
    ORDER BY CASE WHEN kind = 'system' THEN 0 ELSE 1 END, updated_at DESC
  `, userId);

  const getWritableConversation = (userId, conversationId) => database.get(`
    SELECT *
    FROM conversations
    WHERE id = ?
      AND (
        (kind = 'system' AND user_id IS NULL)
        OR (kind = 'normal' AND user_id = ?)
      )
  `, conversationId, userId);

  const hydrateConversation = (row, includeMessages = true) => {
    const metadata = safeParseJson(row.metadata_json || '{}', {});
    return {
      ...metadata,
      id: row.id,
      title: row.title,
      kind: row.kind,
      modelId: row.model_id,
      systemChannel: row.system_channel || undefined,
      lastReadAt: row.last_read_at ?? metadata.lastReadAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: includeMessages ? loadMessages(row.id) : [],
    };
  };

  return {
    loadConfig(userId) {
      const row = database.get(
        'SELECT setting_value_json FROM user_settings WHERE user_id = ? AND setting_key = ?',
        userId,
        CONFIG_SETTING_KEY,
      );
      if (!row) return defaultConfig();
      return { ...defaultConfig(), ...safeParseJson(row.setting_value_json, {}) };
    },

    saveConfig(userId, config) {
      database.run(`
        INSERT INTO user_settings (user_id, setting_key, setting_value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, setting_key) DO UPDATE SET
          setting_value_json = excluded.setting_value_json,
          updated_at = excluded.updated_at
      `, userId, CONFIG_SETTING_KEY, JSON.stringify(config || {}), nowIso());
      return this.loadConfig(userId);
    },

    loadConversations(userId) {
      return loadConversationRows(userId).map((row) => hydrateConversation(row));
    },

    listConversationSummaries(userId) {
      return loadConversationRows(userId).map((row) => {
        const conversation = hydrateConversation(row, false);
        return {
          id: conversation.id,
          title: conversation.title,
          kind: conversation.kind,
          modelId: conversation.modelId,
          systemChannel: conversation.systemChannel,
          lastReadAt: conversation.lastReadAt,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        };
      });
    },

    saveConversations(userId, conversations = []) {
      database.transaction(() => {
        database.run('DELETE FROM conversations WHERE kind = ? AND user_id = ?', 'normal', userId);
        for (const conversation of conversations) {
          if (conversation?.kind === 'system') {
            saveConversation(userId, { ...conversation, kind: 'system' });
          } else {
            saveConversation(userId, { ...conversation, kind: 'normal' });
          }
        }
      });
      return this.loadConversations(userId);
    },

    saveSystemConversation(conversation) {
      return saveConversation(null, { ...conversation, kind: 'system' });
    },

    upsertConversation(userId, conversation) {
      return saveConversation(userId, { ...conversation, kind: conversation?.kind === 'system' ? 'system' : 'normal' });
    },

    loadConversationMessages(userId, conversationId) {
      const row = database.get(`
        SELECT id FROM conversations
        WHERE id = ? AND ((kind = 'system' AND user_id IS NULL) OR (kind = 'normal' AND user_id = ?))
      `, conversationId, userId);
      if (!row) return [];
      return loadMessages(conversationId);
    },

    appendConversationMessage(userId, conversationId, message) {
      const conversation = getWritableConversation(userId, conversationId);
      if (!conversation) throw new Error('对话不存在。');
      const messages = [...loadMessages(conversationId), stripTransientMessageState(message)];
      saveMessages(conversationId, messages);
      database.run('UPDATE conversations SET updated_at = ? WHERE id = ?', message?.timestamp || Date.now(), conversationId);
      return stripTransientMessageState(message);
    },

    updateConversationMessage(userId, conversationId, messageId, updates = {}) {
      const conversation = getWritableConversation(userId, conversationId);
      if (!conversation) throw new Error('对话不存在。');
      const messages = this.loadConversationMessages(userId, conversationId);
      const nextMessages = messages.map((message) =>
        message.id === messageId ? stripTransientMessageState({ ...message, ...updates }) : message);
      saveMessages(conversationId, nextMessages);
      return nextMessages.find((message) => message.id === messageId) || null;
    },

    replaceConversationMessages(userId, conversationId, messages = []) {
      const row = getWritableConversation(userId, conversationId);
      if (!row) throw new Error('对话不存在。');
      saveMessages(conversationId, messages);
      database.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now(), conversationId);
      return this.loadConversationMessages(userId, conversationId);
    },

    deleteConversation(userId, conversationId) {
      database.run('DELETE FROM conversations WHERE id = ? AND kind = ? AND user_id = ?', conversationId, 'normal', userId);
      return { ok: true };
    },
  };
};
