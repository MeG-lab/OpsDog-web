/**
 * Configuration Persistence Service
 *
 * Handles loading and saving application configuration and conversation history
 * through the active runtime.
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
import type { LLMConfig, Conversation, ManagedTaskConfig, ChatMcpMode, OperatorProfile, AssetDevice } from '../types';
import { createClientId } from '../utils/createClientId';

// ── Config Types ──

export interface PersistedConfig {
  llmConfigs: LLMConfig[];
  activeModelId: string | null;
  activeConversationId: string | null;
  managedTaskConfigs: Record<string, ManagedTaskConfig>;
  chatMcpMode: ChatMcpMode;
  selectedManualMcpServer: string | null;
  theme: 'light' | 'dark';
  backgroundPreset: 'white' | 'mist' | 'sage' | 'sand' | 'sky' | 'lavender';
  sidebarCollapsed: boolean;
  activeWorkspace: 'chat' | 'scripts' | 'overview' | 'servers' | 'settings' | 'more';
  operatorProfile: OperatorProfile;
  assetDevices: AssetDevice[];
}

export const DEFAULT_OPERATOR_PROFILE: OperatorProfile = {
  name: '',
  team: '运维服务部',
  organization: '',
  phone: '',
  email: '',
  voiceAlertEnabled: false,
  voiceServiceEnabled: false,
  voiceAccessKeyId: '',
  voiceAccessKeySecret: '',
  voiceNotifyNumbers: '',
};

export const DEFAULT_ASSET_DEVICES: AssetDevice[] = [];

const DEFAULT_CONFIG: PersistedConfig = {
  llmConfigs: [],
  activeModelId: null,
  activeConversationId: null,
  managedTaskConfigs: {},
  chatMcpMode: 'manual',
  selectedManualMcpServer: null,
  theme: 'light',
  backgroundPreset: 'white',
  sidebarCollapsed: false,
  activeWorkspace: 'chat',
  operatorProfile: DEFAULT_OPERATOR_PROFILE,
  assetDevices: DEFAULT_ASSET_DEVICES,
};

export function normalizeAssetDevice(raw: unknown): AssetDevice {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const deviceType = source.deviceType === 'storage'
    ? 'storage'
    : source.deviceType === 'security'
      ? 'security'
      : source.deviceType === 'network' || source.deviceType === 'router' || source.deviceType === 'switch'
        ? 'network'
        : 'server';
  const status = source.status === 'attention'
    ? 'attention'
    : source.status === 'critical'
      ? 'critical'
      : 'healthy';

  return {
    id: String(source.id || createClientId('asset-device')),
    name: String(source.name || ''),
    assetId: String(source.assetId || ''),
    ipAddress: String(source.ipAddress || ''),
    deviceType,
    status,
    location: String(source.location || ''),
    model: String(source.model || ''),
    manufacturer: String(source.manufacturer || ''),
    serialNumber: String(source.serialNumber || ''),
    organization: String(source.organization || ''),
    owner: String(source.owner || ''),
    remark: String(source.remark || ''),
    createdAt: String(source.createdAt || new Date().toISOString()),
    updatedAt: String(source.updatedAt || new Date().toISOString()),
  };
}

export function normalizeAssetDevices(raw: unknown): AssetDevice[] {
  return Array.isArray(raw) ? raw.map((item) => normalizeAssetDevice(item)) : [];
}

export function normalizeOperatorProfile(raw: unknown): OperatorProfile {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const team = source.team === '渗透测试部' ? '渗透测试部' : '运维服务部';

  return {
    name: String(source.name || ''),
    team,
    organization: String(source.organization || ''),
    phone: String(source.phone || ''),
    email: String(source.email || ''),
    voiceAlertEnabled: Boolean(source.voiceAlertEnabled),
    voiceServiceEnabled: Boolean(source.voiceServiceEnabled),
    voiceAccessKeyId: String(source.voiceAccessKeyId || ''),
    voiceAccessKeySecret: String(source.voiceAccessKeySecret || ''),
    voiceNotifyNumbers: String(source.voiceNotifyNumbers || ''),
  };
}

// ── Config Persistence ──

export async function loadPersistedConfig(): Promise<PersistedConfig> {
  try {
    const normalized = mergeRuntimeConfigWithLocalSnapshot(await loadConfig());
    return {
      ...DEFAULT_CONFIG,
      ...normalized,
      operatorProfile: normalizeOperatorProfile(normalized.operatorProfile),
      assetDevices: normalizeAssetDevices(normalized.assetDevices),
    } as PersistedConfig;
  } catch (error) {
    console.warn('Failed to load config, using defaults:', error);
    return DEFAULT_CONFIG;
  }
}

export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
  try {
    await runtimeSaveConfig(config as unknown as Record<string, unknown>);
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const normalizeChatMcpMode = (value: unknown): ChatMcpMode =>
  value === 'disabled' || value === 'auto' || value === 'manual'
    ? value
    : DEFAULT_CONFIG.chatMcpMode;

const normalizeTheme = (value: unknown): PersistedConfig['theme'] =>
  value === 'light' || value === 'dark' ? value : DEFAULT_CONFIG.theme;

const normalizeBackgroundPreset = (value: unknown): PersistedConfig['backgroundPreset'] =>
  value === 'mist'
  || value === 'sage'
  || value === 'sand'
  || value === 'sky'
  || value === 'lavender'
  || value === 'white'
    ? value
    : DEFAULT_CONFIG.backgroundPreset;

const normalizeActiveWorkspace = (value: unknown): PersistedConfig['activeWorkspace'] =>
  value === 'scripts' || value === 'overview' || value === 'servers' || value === 'settings' || value === 'more' || value === 'chat'
    ? value
    : DEFAULT_CONFIG.activeWorkspace;

function normalizeConfigShape(raw: Record<string, unknown>): Record<string, unknown> {
  const rawLlmConfigs = raw.llmConfigs ?? raw.llm_configs;
  const rawActiveModelId = raw.activeModelId ?? raw.active_model_id;
  const rawActiveConversationId = raw.activeConversationId ?? raw.active_conversation_id;
  const rawManagedTaskConfigs = raw.managedTaskConfigs ?? raw.managed_task_configs;
  const rawSelectedManualMcpServer =
    raw.selectedManualMcpServer ??
    raw.selected_manual_mcp_server ??
    raw.selectedManualMcpTool ??
    raw.selected_manual_mcp_tool;
  const rawBackgroundPreset = raw.backgroundPreset ?? raw.background_preset;
  const rawSidebarCollapsed = raw.sidebarCollapsed ?? raw.sidebar_collapsed;
  const rawActiveWorkspace = raw.activeWorkspace ?? raw.active_workspace;

  return {
    ...raw,
    llmConfigs: Array.isArray(rawLlmConfigs) ? rawLlmConfigs : [],
    activeModelId: normalizeNullableString(rawActiveModelId),
    activeConversationId: normalizeNullableString(rawActiveConversationId),
    managedTaskConfigs: isRecord(rawManagedTaskConfigs) ? rawManagedTaskConfigs : {},
    chatMcpMode: normalizeChatMcpMode(raw.chatMcpMode ?? raw.chat_mcp_mode),
    selectedManualMcpServer: normalizeNullableString(rawSelectedManualMcpServer),
    theme: normalizeTheme(raw.theme),
    backgroundPreset: normalizeBackgroundPreset(rawBackgroundPreset),
    sidebarCollapsed: rawSidebarCollapsed === true,
    activeWorkspace: normalizeActiveWorkspace(rawActiveWorkspace),
    operatorProfile: normalizeOperatorProfile(raw.operatorProfile ?? raw.operator_profile),
    // Device inventory is loaded from the asset API. Older config snapshots
    // may still contain per-browser demo or deleted device records.
    assetDevices: DEFAULT_ASSET_DEVICES,
  };
}

export function readBootstrapPersistedConfig(): Partial<PersistedConfig> {
  return {};
}

function mergeRuntimeConfigWithLocalSnapshot(runtimeRaw: Record<string, unknown>): Record<string, unknown> {
  return normalizeConfigShape(runtimeRaw);
}

// ── Conversation Persistence ──

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

export function readBootstrapPersistedConversations(): Conversation[] {
  return [];
}

export async function loadPersistedConversations(): Promise<Conversation[]> {
  try {
    const persisted = await runtimeLoadConversations();
    return normalizeConversations(persisted);
  } catch (error) {
    console.warn('Failed to load conversations:', error);
    return [];
  }
}

export async function savePersistedConversations(conversations: Conversation[]): Promise<void> {
  try {
    const toSave = conversations
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
    void runtimeUpdateConversationMessage(conversationId, messageId, updates).catch((error) => {
      console.error('Failed to update conversation message:', error);
    });
    messageUpdateTimeouts.delete(timeoutKey);
  }, delayMs);
  messageUpdateTimeouts.set(timeoutKey, timeout);
}

export async function persistConversationDelete(conversationId: string): Promise<void> {
  try {
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

export function cachePersistedConfigSnapshot(config: PersistedConfig): void {
  void config;
}
