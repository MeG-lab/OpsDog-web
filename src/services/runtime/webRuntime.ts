import type { Conversation, Message } from '../../types';
import type { ChatRequest, ChatResponse, ModelListRequest } from '../contracts';
import type { Runtime, RuntimeUnlistenFn } from './types';
import { getBundledSkillInstructions, getBundledSkills, updateBundledSkillOverride } from './webSkills';
import { buildWebExecutionPlan, routeWebChatInput } from './webRouting';

const STORAGE_KEYS = {
  config: 'aiops_web_runtime_config',
  conversations: 'aiops_web_runtime_conversations',
} as const;

type StreamChunkPayload = { conversationId: string; messageId: string; chunk: string };
type StreamCompletePayload = { conversationId: string; messageId: string; success: boolean; error?: string };

const chunkListeners = new Set<(payload: StreamChunkPayload) => void>();
const completeListeners = new Set<(payload: StreamCompletePayload) => void>();

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  window.localStorage.setItem(key, JSON.stringify(value));
};

const notImplemented = async <T>(method: string, fallback?: T): Promise<T> => {
  if (fallback !== undefined) return fallback;
  throw new Error(`Web runtime not implemented yet: ${method}`);
};

const unsupportedResult = (feature: string) => ({
  exitCode: 1,
  stdout: '',
  stderr: `Web runtime does not support ${feature} yet.`,
  executionTimeMs: 0,
  truncated: false,
});

const toUnlisten = <T>(set: Set<(payload: T) => void>, callback: (payload: T) => void): RuntimeUnlistenFn => {
  set.add(callback);
  return () => {
    set.delete(callback);
  };
};

const emitChunk = (payload: StreamChunkPayload) => {
  chunkListeners.forEach(listener => listener(payload));
};

const emitComplete = (payload: StreamCompletePayload) => {
  completeListeners.forEach(listener => listener(payload));
};

const getOpenAIBaseUrl = (request: Pick<ChatRequest, 'baseUrl'> | Pick<ModelListRequest, 'baseUrl'>) =>
  request.baseUrl?.trim() || 'https://api.openai.com/v1';

const getGoogleBaseUrl = (request: Pick<ChatRequest, 'baseUrl'> | Pick<ModelListRequest, 'baseUrl'>) =>
  request.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta';

const buildError = async (response: Response): Promise<never> => {
  const body = await response.text().catch(() => '');
  throw new Error(`API returned ${response.status}: ${body || response.statusText}`);
};

const safeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network request failed: ${message}. This can be caused by browser CORS restrictions or an unreachable API endpoint.`);
  }
};

const sendOpenAICompatible = async (request: ChatRequest): Promise<ChatResponse> => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: request.modelName,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stream: false,
  };

  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }

  const response = await safeFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) await buildError(response);
  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };

  const choice = data.choices?.[0]?.message;
  return {
    content: choice?.content ?? '',
    toolCalls: choice?.tool_calls?.map(toolCall => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })),
  };
};

const streamOpenAICompatible = async (
  request: ChatRequest,
  onChunk: (chunk: string) => void,
): Promise<void> => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/chat/completions`;
  const response = await safeFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.modelName,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
    }),
  });

  if (!response.ok) await buildError(response);
  if (!response.body) throw new Error('Streaming response body is empty');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (line && !line.startsWith(':') && line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch {
          // Ignore malformed SSE fragments and keep reading.
        }
      }

      lineEnd = buffer.indexOf('\n');
    }
  }
};

const fetchOpenAICompatibleModels = async (request: ModelListRequest): Promise<string[]> => {
  const url = `${getOpenAIBaseUrl(request).replace(/\/$/, '')}/models`;
  const response = await safeFetch(url, {
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
    },
  });
  if (!response.ok) await buildError(response);
  const data = await response.json() as { data?: Array<{ id: string }> };
  return (data.data ?? []).map(item => item.id).filter(Boolean).sort();
};

const sendAnthropic = async (request: ChatRequest): Promise<ChatResponse> => {
  const baseUrl = request.baseUrl?.trim() || 'https://api.anthropic.com';
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const system = request.messages.find(message => message.role === 'system')?.content;
  const messages = request.messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role,
      content: message.content,
    }));

  const response = await safeFetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': request.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.modelName,
      messages,
      max_tokens: request.maxTokens,
      system,
      stream: false,
    }),
  });

  if (!response.ok) await buildError(response);
  const data = await response.json() as { content?: Array<{ text?: string }> };
  return {
    content: (data.content ?? []).map(item => item.text ?? '').join(''),
  };
};

const sendGoogle = async (request: ChatRequest): Promise<ChatResponse> => {
  const url = `${getGoogleBaseUrl(request).replace(/\/$/, '')}/models/${request.modelName}:generateContent?key=${encodeURIComponent(request.apiKey)}`;
  const contents = request.messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  const response = await safeFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
      },
    }),
  });

  if (!response.ok) await buildError(response);
  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const content = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? '';
  return { content };
};

const fetchGoogleModels = async (request: ModelListRequest): Promise<string[]> => {
  const url = `${getGoogleBaseUrl(request).replace(/\/$/, '')}/models?key=${encodeURIComponent(request.apiKey)}`;
  const response = await safeFetch(url);
  if (!response.ok) await buildError(response);
  const data = await response.json() as { models?: Array<{ name: string }> };
  return (data.models ?? [])
    .map(model => model.name.replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
};

const sendChatMessageInternal = async (request: ChatRequest): Promise<ChatResponse> => {
  switch (request.provider) {
    case 'openai':
    case 'custom':
    case 'aliyun':
    case 'deepseek':
    case 'siliconflow':
    case 'volcengine':
    case 'zhipu':
    case 'moonshot':
      return sendOpenAICompatible(request);
    case 'anthropic':
      return sendAnthropic(request);
    case 'google':
      return sendGoogle(request);
    default:
      throw new Error(`Unsupported provider: ${request.provider}`);
  }
};

const fetchAvailableModelsInternal = async (request: ModelListRequest): Promise<string[]> => {
  switch (request.provider) {
    case 'openai':
    case 'custom':
    case 'aliyun':
    case 'deepseek':
    case 'siliconflow':
    case 'volcengine':
    case 'zhipu':
    case 'moonshot':
      return fetchOpenAICompatibleModels(request);
    case 'google':
      return fetchGoogleModels(request);
    case 'anthropic':
      throw new Error('Anthropic 当前未接入模型列表拉取，请手动填写模型名称');
    default:
      throw new Error(`Unsupported provider: ${request.provider}`);
  }
};

export const webRuntime: Runtime = {
  mode: 'web',
  sendChatMessage: sendChatMessageInternal,
  fetchAvailableModels: fetchAvailableModelsInternal,
  routeChatInput: async (input) => routeWebChatInput(input),
  buildChatExecutionPlan: async (input, allowedSkills) => buildWebExecutionPlan(input, allowedSkills),
  sendChatMessageStream: async (request, conversationId, messageId) => {
    try {
      switch (request.provider) {
        case 'openai':
        case 'custom':
        case 'aliyun':
        case 'deepseek':
        case 'siliconflow':
        case 'volcengine':
        case 'zhipu':
        case 'moonshot':
          await streamOpenAICompatible(request, (chunk) => {
            emitChunk({ conversationId, messageId, chunk });
          });
          break;
        case 'anthropic':
        case 'google': {
          const response = await sendChatMessageInternal(request);
          if (response.content) {
            emitChunk({ conversationId, messageId, chunk: response.content });
          }
          break;
        }
        default:
          throw new Error(`Unsupported provider: ${request.provider}`);
      }

      emitComplete({ conversationId, messageId, success: true });
    } catch (error) {
      emitComplete({
        conversationId,
        messageId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
  onStreamChunk: async (callback) => toUnlisten(chunkListeners, callback),
  onStreamComplete: async (callback) => toUnlisten(completeListeners, callback),
  executeInstantSkill: async () => unsupportedResult('instant skill execution'),
  startManagedTask: () => notImplemented('startManagedTask'),
  restartManagedTask: () => notImplemented('restartManagedTask'),
  stopManagedTask: () => notImplemented('stopManagedTask'),
  listManagedTasks: () => notImplemented('listManagedTasks', []),
  getManagedTask: () => notImplemented('getManagedTask', null),
  restoreManagedTasks: () => notImplemented('restoreManagedTasks', []),
  scanSkills: async () => getBundledSkills().map(skill => ({
    name: skill.name,
    version: skill.version,
    description: skill.description,
    triggers: skill.triggers,
    taskKind: skill.taskKind,
    entryScript: skill.entryScript,
    timeoutSeconds: skill.timeoutSeconds,
    dependencies: skill.dependencies,
    path: skill.path,
  })),
  updateSkillMeta: async (skillName, description, triggers) => {
    const updated = updateBundledSkillOverride(skillName, { description, triggers });
    return {
      name: updated.name,
      version: updated.version,
      description: updated.description,
      triggers: updated.triggers,
      taskKind: updated.taskKind,
      entryScript: updated.entryScript,
      timeoutSeconds: updated.timeoutSeconds,
      dependencies: updated.dependencies,
      path: updated.path,
    };
  },
  loadSkillInstructions: async (skillPath) => getBundledSkillInstructions(skillPath),
  resolveSkillEntryScript: async (_skillPath, entryScript) => entryScript,
  validateSkillArgs: async (_skillPath, args) => ({
    valid: true,
    normalizedArgs: args,
    errors: [],
  }),
  loadConfig: async () => readJson(STORAGE_KEYS.config, {}),
  saveConfig: async (config) => {
    writeJson(STORAGE_KEYS.config, config);
  },
  loadConversations: async () => readJson(STORAGE_KEYS.conversations, []),
  saveConversations: async (conversations) => {
    writeJson(STORAGE_KEYS.conversations, conversations);
  },
  listConversationSummaries: async () => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    return conversations.map(({ messages, ...rest }) => rest);
  },
  loadConversationMessages: async (conversationId) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    return conversations.find((item) => item.id === conversationId)?.messages ?? [];
  },
  upsertConversationRecord: async (conversation) => {
    const conversations = readJson<Array<Record<string, unknown> & { id: string; messages?: unknown[] }>>(STORAGE_KEYS.conversations, []);
    const existing = conversations.findIndex((item) => item.id === conversation.id);
    if (existing >= 0) {
      conversations[existing] = { ...conversations[existing], ...conversation };
    } else {
      conversations.unshift({ ...conversation, messages: conversation.messages ?? [] });
    }
    writeJson(STORAGE_KEYS.conversations, conversations);
  },
  appendConversationMessage: async (conversationId, message) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    const next = conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: [...conversation.messages, message] }
      : conversation);
    writeJson(STORAGE_KEYS.conversations, next);
  },
  updateConversationMessage: async (conversationId, messageId, updates) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    const next = conversations.map((conversation) => conversation.id === conversationId
      ? {
          ...conversation,
          messages: conversation.messages.map((message: Message) => message.id === messageId ? { ...message, ...updates } : message),
        }
      : conversation);
    writeJson(STORAGE_KEYS.conversations, next);
  },
  replaceConversationMessages: async (conversationId, messages) => {
    const conversations = readJson<Conversation[]>(STORAGE_KEYS.conversations, []);
    const next = conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages }
      : conversation);
    writeJson(STORAGE_KEYS.conversations, next);
  },
  deleteConversationRecord: async (conversationId) => {
    const conversations = readJson<Array<{ id: string }>>(STORAGE_KEYS.conversations, []);
    writeJson(STORAGE_KEYS.conversations, conversations.filter((conversation) => conversation.id !== conversationId));
  },
  connectMCPServer: () => notImplemented('connectMCPServer', []),
  disconnectMCPServer: () => notImplemented('disconnectMCPServer', undefined),
  listMCPTools: () => notImplemented('listMCPTools', []),
  getMCPStatus: () => notImplemented('getMCPStatus', []),
  callMCPTool: () => notImplemented('callMCPTool', { content: [], isError: true }),
  getSystemInfo: async () => ({
    os: navigator.platform || 'web',
    arch: 'web',
    hostname: window.location.hostname || 'localhost',
  }),
};
