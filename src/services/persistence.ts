/**
 * Configuration Persistence Service
 *
 * Handles loading and saving application configuration to ~/.aiops/config.json
 * and conversation history to SQLite via the Tauri backend, with localStorage
 * kept only as a lightweight startup cache.
 */

import {
  appendConversationMessage as tauriAppendConversationMessage,
  deleteConversationRecord as tauriDeleteConversationRecord,
  loadConfig,
  loadConversations as tauriLoadConversations,
  replaceConversationMessages as tauriReplaceConversationMessages,
  saveConfig as tauriSaveConfig,
  saveConversations as tauriSaveConversations,
  updateConversationMessage as tauriUpdateConversationMessage,
  upsertConversationRecord as tauriUpsertConversationRecord,
} from './tauri';
import type { LLMConfig, Conversation, MCPServer, ManagedTaskConfig } from '../types';

// ── Config Types ──

export interface PersistedConfig {
  llmConfigs: LLMConfig[];
  activeModelId: string | null;
  mcpServers: MCPServer[];
  pythonPath: string;
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
  pythonPath: 'python3',
  managedTaskConfigs: {},
  theme: 'dark',
  backgroundPreset: 'white',
  sidebarCollapsed: false,
  enabledSkills: [],
};

// ── Config Persistence (via Tauri Backend → ~/.aiops/config.json) ──

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
    await tauriSaveConfig(config as unknown as Record<string, unknown>);
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
    pythonPath: raw.pythonPath ?? raw.python_path,
    managedTaskConfigs: raw.managedTaskConfigs ?? raw.managed_task_configs,
    theme: raw.theme,
    backgroundPreset: raw.backgroundPreset ?? raw.background_preset,
    sidebarCollapsed: raw.sidebarCollapsed ?? raw.sidebar_collapsed,
    enabledSkills: raw.enabledSkills ?? raw.enabled_skills,
  };
}

// ── Conversation Persistence (localStorage for Phase 1) ──

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
    const persisted = await tauriLoadConversations();
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
    await tauriSaveConversations(toSave);
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
    await tauriUpsertConversationRecord({ ...conversation, messages: [] });
  } catch (error) {
    console.error('Failed to persist conversation metadata:', error);
  }
}

export async function persistConversationAppendMessage(
  conversationId: string,
  message: Conversation['messages'][number],
): Promise<void> {
  try {
    await tauriAppendConversationMessage(conversationId, {
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
    void tauriUpdateConversationMessage(conversationId, messageId, updates).catch((error) => {
      console.error('Failed to update conversation message:', error);
    });
    messageUpdateTimeouts.delete(timeoutKey);
  }, delayMs);
  messageUpdateTimeouts.set(timeoutKey, timeout);
}

export async function persistConversationDelete(conversationId: string): Promise<void> {
  try {
    await tauriDeleteConversationRecord(conversationId);
  } catch (error) {
    console.error('Failed to delete conversation record:', error);
  }
}

export async function persistConversationMessagesReplace(
  conversationId: string,
  messages: Conversation['messages'],
): Promise<void> {
  try {
    await tauriReplaceConversationMessages(
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
