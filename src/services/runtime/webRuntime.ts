import type { Conversation, Message, SkillArgsValidationResult } from '../../types';
import type {
  ApiErrorResponse,
  ChatRequest,
  ChatResponse,
  HealthResponse,
  MCPConnectRequest,
  MCPConnectResponse,
  MCPStatusResponse,
  MCPToolCallRequest,
  MCPToolCallResponse,
  ModelListRequest,
  ModelListResponse,
  SkillListResponse,
  SkillRecordResponse,
  SkillUpdateRequest,
  ServerListResponse,
  ServerUploadScriptRequest,
  ServerUploadScriptResponse,
} from '../contracts';
import type { Runtime, RuntimeUnlistenFn } from './types';
import { getBundledSkillInstructions, getBundledSkills } from './webSkills';
import { buildWebExecutionPlan, routeWebChatInput } from './webRouting';
import { findPreferredSkillForServer, mapSkillRecord, resolveSkillBinding } from '../skillRecords';

const STORAGE_KEYS = {
  config: 'aiops_web_runtime_config',
  conversations: 'aiops_web_runtime_conversations',
} as const;

type StreamChunkPayload = { conversationId: string; messageId: string; chunk: string };
type StreamCompletePayload = { conversationId: string; messageId: string; success: boolean; error?: string };

const chunkListeners = new Set<(payload: StreamChunkPayload) => void>();
const completeListeners = new Set<(payload: StreamCompletePayload) => void>();
const API_BASE = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api').replace(/\/$/, '');

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
  chunkListeners.forEach((listener) => listener(payload));
};

const emitComplete = (payload: StreamCompletePayload) => {
  completeListeners.forEach((listener) => listener(payload));
};

const buildError = async (response: Response): Promise<never> => {
  const body = await response.text().catch(() => '');
  if (response.status === 404 && typeof response.url === 'string' && response.url.includes('/api/skills')) {
    throw new Error('当前后端实例还未升级到 Skill 绑定编辑接口（缺少 /api/skills 路由）。请重启或切换到新的后端实例。');
  }
  try {
    const parsed = JSON.parse(body) as ApiErrorResponse;
    if (parsed?.error) {
      throw new Error(parsed.error);
    }
  } catch (error) {
    if (error instanceof Error && error.message) {
      throw error;
    }
  }
  throw new Error(`API returned ${response.status}: ${body || response.statusText}`);
};

const safeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network request failed: ${message}. Please confirm the OpsDog backend is running and reachable.`);
  }
};

const apiUrl = (path: string): string => `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;

const buildManagedServerPayload = async (serverId: string, payload: Record<string, unknown>) => {
  if (Array.isArray(payload.args) && payload.args.length > 0) {
    return payload;
  }

  const [skills, servers] = await Promise.all([webRuntime.scanSkills(), webRuntime.listServers()]);
  const server = servers.find((item) => item.id === serverId || item.name === serverId);
  if (!server || server.category !== 'managed') {
    return payload;
  }

  const preferredSkill = findPreferredSkillForServer(server.id, skills, servers);
  if (!preferredSkill) {
    return payload;
  }

  const defaultArgs = Array.isArray(preferredSkill.defaultArgs) ? preferredSkill.defaultArgs : [];
  if (defaultArgs.length === 0) {
    return payload;
  }

  return {
    ...payload,
    args: defaultArgs,
    input: {
      ...(payload.input && typeof payload.input === 'object' ? payload.input as Record<string, unknown> : {}),
      args: defaultArgs,
      toolName: preferredSkill.resolvedToolName || preferredSkill.toolName || undefined,
    },
  };
};

const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== 'string') {
      reject(new Error('脚本读取失败：无法解析文件内容。'));
      return;
    }
    const marker = 'base64,';
    const markerIndex = result.indexOf(marker);
    if (markerIndex === -1) {
      reject(new Error('脚本读取失败：未生成 base64 内容。'));
      return;
    }
    resolve(result.slice(markerIndex + marker.length));
  };
  reader.onerror = () => reject(new Error('脚本读取失败，请重试。'));
  reader.readAsDataURL(file);
});

const postJson = async <TResponse, TRequest>(path: string, body: TRequest): Promise<TResponse> => {
  const response = await safeFetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) await buildError(response);
  return await response.json() as TResponse;
};

const patchJson = async <TResponse, TRequest>(path: string, body: TRequest): Promise<TResponse> => {
  const response = await safeFetch(apiUrl(path), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) await buildError(response);
  return await response.json() as TResponse;
};

const deleteJson = async <TResponse>(path: string): Promise<TResponse> => {
  const response = await safeFetch(apiUrl(path), {
    method: 'DELETE',
  });
  if (!response.ok) await buildError(response);
  return await response.json() as TResponse;
};

const validateBundledSkillArgs = (
  skillPath: string,
  args: string[],
): SkillArgsValidationResult => {
  const skill = getBundledSkills().find((item) => item.path === skillPath);
  if (!skill || !skill.argsSchema || skill.argsSchema.length === 0) {
    return {
      valid: true,
      normalizedArgs: args,
      errors: [],
    };
  }

  const valuesByFlag = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;

    const values: string[] = [];
    let cursor = index + 1;
    while (cursor < args.length && !args[cursor].startsWith('--')) {
      values.push(args[cursor]);
      cursor += 1;
    }
    valuesByFlag.set(token, values);
  }

  const errors: string[] = [];
  for (const schema of skill.argsSchema) {
    const values = valuesByFlag.get(schema.flag) || [];
    if (schema.required && values.length === 0) {
      errors.push(`${schema.flag} 为必填参数`);
      continue;
    }
    if (!schema.multiple && values.length > 1) {
      errors.push(`${schema.flag} 不支持多个值`);
    }
    for (const value of values) {
      if (schema.type === 'integer') {
        const numeric = Number.parseInt(value, 10);
        if (Number.isNaN(numeric)) {
          errors.push(`${schema.flag} 需要整数值`);
          continue;
        }
        if (typeof schema.min === 'number' && numeric < schema.min) {
          errors.push(`${schema.flag} 不能小于 ${schema.min}`);
        }
        if (typeof schema.max === 'number' && numeric > schema.max) {
          errors.push(`${schema.flag} 不能大于 ${schema.max}`);
        }
      }
      if (schema.type === 'string' && schema.pattern) {
        const pattern = new RegExp(schema.pattern);
        if (!pattern.test(value)) {
          errors.push(`${schema.flag} 的值格式不合法`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    normalizedArgs: args,
    errors,
  };
};

export const webRuntime: Runtime = {
  mode: 'web',
  getBackendHealth: async () => {
    const response = await safeFetch(apiUrl('/health'));
    if (!response.ok) await buildError(response);
    return await response.json() as HealthResponse;
  },
  sendChatMessage: async (request) => postJson<ChatResponse, ChatRequest>('/chat', request),
  fetchAvailableModels: async (request) => {
    const response = await postJson<ModelListResponse, ModelListRequest>('/models', request);
    return response.models;
  },
  routeChatInput: async (input) => routeWebChatInput(input),
  buildChatExecutionPlan: async (input, allowedSkills) => buildWebExecutionPlan(input, allowedSkills),
  sendChatMessageStream: async (request, conversationId, messageId) => {
    try {
      const response = await safeFetch(apiUrl('/chat/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
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
            if (data === '[DONE]') {
              emitComplete({ conversationId, messageId, success: true });
              return;
            }
            try {
              const chunk = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const content = chunk.choices?.[0]?.delta?.content;
              if (content) {
                emitChunk({ conversationId, messageId, chunk: content });
              }
            } catch {
              // Ignore malformed SSE fragments and keep reading.
            }
          }

          lineEnd = buffer.indexOf('\n');
        }
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
  executeInstantSkill: async (skillName, args = []) => {
    try {
      const [skills, servers] = await Promise.all([webRuntime.scanSkills(), webRuntime.listServers()]);
      const skill = skills.find((item) => item.name === skillName);
      if (!skill || skill.bindingStatus !== 'resolved' || !skill.serverId || !skill.resolvedToolName) {
        return unsupportedResult(`instant skill execution (${skillName} binding not resolved)`);
      }
      const server = servers.find((item) => item.id === skill.serverId || item.name === skill.serverId);
      if (!server) {
        return unsupportedResult(`instant skill execution (${skillName} not found)`);
      }
      const response = await webRuntime.callServerTool(server.id, skill.resolvedToolName, {
        args,
        input: { args },
      });
      const text = response.content?.map((item) => item.text || '').join('\n').trim() || '';
      return {
        exitCode: response.isError ? 1 : 0,
        stdout: response.isError ? '' : text,
        stderr: response.isError ? text : '',
        executionTimeMs: 0,
        truncated: false,
      };
    } catch (error) {
      return unsupportedResult(error instanceof Error ? error.message : 'instant skill execution');
    }
  },
  uploadServerScript: async (kind, file, description) => {
    const fileContentBase64 = await fileToBase64(file);
    return await postJson<ServerUploadScriptResponse, ServerUploadScriptRequest>('/servers/upload-script', {
      kind,
      fileName: file.name,
      description,
      fileContentBase64,
    });
  },
  listServers: async () => {
    const response = await safeFetch(apiUrl('/servers'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as ServerListResponse;
    return data.servers;
  },
  getServer: async (serverId) => {
    const response = await safeFetch(apiUrl(`/servers/${encodeURIComponent(serverId)}`));
    if (!response.ok) await buildError(response);
    return await response.json();
  },
  updateServer: async (serverId, updates) =>
    await patchJson(`/servers/${encodeURIComponent(serverId)}`, updates),
  deleteServer: async (serverId) => {
    await deleteJson(`/servers/${encodeURIComponent(serverId)}`);
  },
  startServer: async (serverId, payload = {}) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/start`, await buildManagedServerPayload(serverId, payload)),
  stopServer: async (serverId) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/stop`, {}),
  restartServer: async (serverId, payload = {}) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/restart`, await buildManagedServerPayload(serverId, payload)),
  callServerTool: async (serverId, toolName, argumentsValue) =>
    await postJson(`/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/call`, {
      argumentsValue,
    }),
  scanSkills: async () => {
    try {
      const response = await safeFetch(apiUrl('/skills'));
      if (!response.ok) await buildError(response);
      const data = await response.json() as SkillListResponse;
      return data.skills.map((skill) => mapSkillRecord(skill, true));
    } catch (error) {
      const fallbackSkills = getBundledSkills().map((skill) => mapSkillRecord(skill, true));
      try {
        const servers = await webRuntime.listServers();
        return fallbackSkills.map((skill) => resolveSkillBinding(skill, servers));
      } catch {
        return fallbackSkills.map((skill) => ({
          ...skill,
          bindingStatus: 'missing-server',
          bindingError: `后端 /api/skills 不可用，且 Server 列表也不可用：${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    }
  },
  updateSkillMeta: async (skillName, updates) =>
    mapSkillRecord(await patchJson<SkillRecordResponse, SkillUpdateRequest>(`/skills/${encodeURIComponent(skillName)}`, updates), true),
  loadSkillInstructions: async (skillPath) => getBundledSkillInstructions(skillPath),
  resolveSkillEntryScript: async (_skillPath, entryScript) => entryScript,
  validateSkillArgs: async (skillPath, args) => validateBundledSkillArgs(skillPath, args),
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
  connectMCPServer: async (serverConfig) => {
    const response = await postJson<MCPConnectResponse, MCPConnectRequest>('/mcp/connect', serverConfig as unknown as MCPConnectRequest);
    return response.tools;
  },
  disconnectMCPServer: async (serverName) => {
    await postJson('/mcp/disconnect', { serverName });
  },
  listMCPTools: async () => {
    const response = await safeFetch(apiUrl('/mcp/tools'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as { tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      serverName: string;
      riskLevel?: 'read-only' | 'state-change' | 'destructive';
    }> };
    return data.tools;
  },
  getMCPStatus: async () => {
    const response = await safeFetch(apiUrl('/mcp/status'));
    if (!response.ok) await buildError(response);
    const data = await response.json() as MCPStatusResponse;
    return data.statuses;
  },
  callMCPTool: async (serverName, toolName, argumentsValue) => postJson<MCPToolCallResponse, MCPToolCallRequest>('/mcp/call', {
    serverName,
    toolName,
    argumentsValue,
  }),
  getSystemInfo: async () => ({
    os: navigator.platform || 'web',
    arch: 'web',
    hostname: window.location.hostname || 'localhost',
  }),
};
