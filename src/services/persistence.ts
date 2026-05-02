/**
 * Configuration Persistence Service
 *
 * Handles loading and saving application configuration and conversation history
 * in browser storage for the Web application.
 */

import {
  appendConversationMessage as runtimeAppendConversationMessage,
  deleteConversationRecord as runtimeDeleteConversationRecord,
  loadConfig,
  loadConversations as runtimeLoadConversations,
  replaceConversationMessages as runtimeReplaceConversationMessages,
  saveConfig as runtimeSaveConfig,
  saveConversations as runtimeSaveConversations,
  updateConversationMessage as runtimeUpdateConversationMessage,
  upsertConversationRecord as runtimeUpsertConversationRecord,
} from './runtime';
import type { LLMConfig, Conversation, MCPServer, ManagedTaskConfig } from '../types';

// ── Config Types ──

export interface PersistedConfig {
  llmConfigs: LLMConfig[];
  activeModelId: string | null;
  mcpServers: MCPServer[];
  managedTaskConfigs: Record<string, ManagedTaskConfig>;
  theme: 'light' | 'dark';
  backgroundPreset: 'white' | 'mist' | 'sage' | 'sand' | 'sky' | 'lavender';
  sidebarCollapsed: boolean;
  enabledSkills: string[];
}

const DEFAULT_CONFIG: PersistedConfig = {
  llmConfigs: [],
  activeModelId: null,
  mcpServers: [
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users'],
      enabled: true,
      riskLevel: 'destructive',
      toolRiskOverrides: {
        read_file: 'read-only',
        read_multiple_files: 'read-only',
        get_file_info: 'read-only',
        list_directory: 'read-only',
        list_allowed_directories: 'read-only',
        search_files: 'read-only',
        write_file: 'destructive',
        edit_file: 'destructive',
        move_file: 'destructive',
        create_directory: 'state-change',
      },
    },
  ],
  managedTaskConfigs: {},
  theme: 'dark',
  backgroundPreset: 'white',
  sidebarCollapsed: false,
  enabledSkills: [],
};

// ── Config Persistence ──

export async function loadPersistedConfig(): Promise<PersistedConfig> {
  try {
    const raw = await loadConfig();
    const normalized = normalizeConfigShape(raw);
    const normalizedMcpServers = Array.isArray(normalized.mcpServers)
      ? (normalized.mcpServers as Array<MCPServer & { risk_level?: MCPServer['riskLevel']; tool_risk_overrides?: MCPServer['toolRiskOverrides'] }>).map(server => ({
          ...server,
          riskLevel: server.riskLevel ?? server.risk_level ?? (server.name === 'filesystem' ? 'destructive' : 'read-only'),
          toolRiskOverrides: server.toolRiskOverrides ?? server.tool_risk_overrides ?? (server.name === 'filesystem'
            ? DEFAULT_CONFIG.mcpServers[0]?.toolRiskOverrides
            : undefined),
        }))
      : DEFAULT_CONFIG.mcpServers;
    return {
      ...DEFAULT_CONFIG,
      ...normalized,
      mcpServers: normalizedMcpServers,
    } as PersistedConfig;
  } catch (error) {
    console.warn('Failed to load config, using defaults:', error);
    return DEFAULT_CONFIG;
  }
}

export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
  try {
    writeLocalConfigCache(config);
    await runtimeSaveConfig(config as unknown as Record<string, unknown>);
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

function normalizeConfigShape(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    llmConfigs: raw.llmConfigs ?? raw.llm_configs,
    activeModelId: raw.activeModelId ?? raw.active_model_id,
    mcpServers: raw.mcpServers ?? raw.mcp_servers,
    managedTaskConfigs: raw.managedTaskConfigs ?? raw.managed_task_configs,
    theme: raw.theme,
    backgroundPreset: raw.backgroundPreset ?? raw.background_preset,
    sidebarCollapsed: raw.sidebarCollapsed ?? raw.sidebar_collapsed,
    enabledSkills: raw.enabledSkills ?? raw.enabled_skills,
  };
}

// ── Conversation Persistence ──

const CONVERSATIONS_KEY = 'aiops_conversations';
const MAX_PERSISTED_CONVERSATIONS = 50;

function normalizeConversations(conversations: Conversation[]): Conversation[] {
  return conversations.map((conv) => ({
    ...conv,
    kind: conv.kind ?? 'normal',
    lastReadAt: conv.lastReadAt ?? conv.updatedAt ?? conv.createdAt ?? Date.now(),
    messages: conv.messages.map((msg) => ({
      ...msg,
      isStreaming: false,
    })),
  }));
}

export async function loadPersistedConversations(): Promise<Conversation[]> {
  try {
    const persisted = await runtimeLoadConversations();
    const normalized = normalizeConversations(persisted);
    if (normalized.length > 0) {
      localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch (error) {
    console.warn('Failed to load conversations from backend, falling back to cache:', error);
  }

  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return [];

    const conversations: Conversation[] = JSON.parse(raw);
    return normalizeConversations(conversations);
  } catch (error) {
    console.warn('Failed to load conversations:', error);
    return [];
  }
}

export async function savePersistedConversations(conversations: Conversation[]): Promise<void> {
  try {
    const toSave = conversations
      .slice(0, MAX_PERSISTED_CONVERSATIONS)
      .map((conv) => ({
        ...conv,
        kind: conv.kind ?? 'normal',
        lastReadAt: conv.lastReadAt ?? conv.updatedAt ?? conv.createdAt ?? Date.now(),
        // Strip streaming state before saving
        messages: conv.messages.map((msg) => ({
          ...msg,
          isStreaming: undefined,
        })),
    }));

    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(toSave));
    await runtimeSaveConversations(toSave);
  } catch (error) {
    console.error('Failed to save conversations:', error);
  }
}

// ── Auto-save Debounce ──

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
const messageUpdateTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export function debouncedSaveConversations(conversations: Conversation[]): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    void savePersistedConversations(conversations);
  }, 1000);
}

let configSaveTimeout: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveConfig(config: PersistedConfig): void {
  if (configSaveTimeout) clearTimeout(configSaveTimeout);
  configSaveTimeout = setTimeout(() => {
    savePersistedConfig(config);
  }, 500);
}

export async function persistConversationMetadata(
  conversation: Omit<Conversation, 'messages'>,
): Promise<void> {
  try {
    const conversations = normalizeConversations(readLocalConversationCache());
    const existing = conversations.findIndex(item => item.id === conversation.id);
    if (existing >= 0) {
      conversations[existing] = { ...conversations[existing], ...conversation };
    } else {
      conversations.unshift({ ...conversation, messages: [] });
    }
    writeLocalConversationCache(conversations);
    await runtimeUpsertConversationRecord({ ...conversation, messages: [] });
  } catch (error) {
    console.error('Failed to persist conversation metadata:', error);
  }
}

export async function persistConversationAppendMessage(
  conversationId: string,
  message: Conversation['messages'][number],
): Promise<void> {
  try {
    const conversations = normalizeConversations(readLocalConversationCache()).map(conversation => conversation.id === conversationId
      ? {
          ...conversation,
          messages: [...conversation.messages, { ...message, isStreaming: false }],
        }
      : conversation);
    writeLocalConversationCache(conversations);
    await runtimeAppendConversationMessage(conversationId, {
      ...message,
      isStreaming: false,
    });
  } catch (error) {
    console.error('Failed to append conversation message:', error);
  }
}

export function debouncedPersistConversationMessageUpdate(
  conversationId: string,
  messageId: string,
  updates: Partial<Conversation['messages'][number]>,
  delayMs: number = 150,
): void {
  const timeoutKey = `${conversationId}:${messageId}`;
  const existing = messageUpdateTimeouts.get(timeoutKey);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    const conversations = normalizeConversations(readLocalConversationCache()).map(conversation => conversation.id === conversationId
      ? {
          ...conversation,
          messages: conversation.messages.map(message => message.id === messageId ? { ...message, ...updates } : message),
        }
      : conversation);
    writeLocalConversationCache(conversations);
    void runtimeUpdateConversationMessage(conversationId, messageId, updates).catch((error) => {
      console.error('Failed to update conversation message:', error);
    });
    messageUpdateTimeouts.delete(timeoutKey);
  }, delayMs);
  messageUpdateTimeouts.set(timeoutKey, timeout);
}

export async function persistConversationDelete(conversationId: string): Promise<void> {
  try {
    const conversations = normalizeConversations(readLocalConversationCache()).filter(conversation => conversation.id !== conversationId);
    writeLocalConversationCache(conversations);
    await runtimeDeleteConversationRecord(conversationId);
  } catch (error) {
    console.error('Failed to delete conversation record:', error);
  }
}

export async function persistConversationMessagesReplace(
  conversationId: string,
  messages: Conversation['messages'],
): Promise<void> {
  try {
    const conversations = normalizeConversations(readLocalConversationCache()).map(conversation => conversation.id === conversationId
      ? {
          ...conversation,
          messages: messages.map(message => ({ ...message, isStreaming: false })),
        }
      : conversation);
    writeLocalConversationCache(conversations);
    await runtimeReplaceConversationMessages(
      conversationId,
      messages.map((message) => ({
        ...message,
        isStreaming: false,
      })),
    );
  } catch (error) {
    console.error('Failed to replace conversation messages:', error);
  }
}

const CONFIG_CACHE_KEY = 'aiops_web_config';

function writeLocalConfigCache(config: PersistedConfig): void {
  localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config));
}

function readLocalConversationCache(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    return raw ? JSON.parse(raw) as Conversation[] : [];
  } catch {
    return [];
  }
}

function writeLocalConversationCache(conversations: Conversation[]): void {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}
