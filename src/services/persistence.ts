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
import type { LLMConfig, Conversation, ManagedTaskConfig, ChatMcpMode, OperatorProfile, AssetDevice } from '../types';

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
  activeWorkspace: 'chat' | 'scripts' | 'overview' | 'servers';
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

export const DEFAULT_ASSET_DEVICES: AssetDevice[] = [
  {
    id: 'asset-network-01',
    name: '核心交换机 SW-01',
    assetId: 'ASSET-20260515-0002',
    ipAddress: '10.16.109.10',
    deviceType: 'network',
    status: 'healthy',
    location: '主机房 A 区',
    model: 'S6850-48T6Q',
    manufacturer: 'H3C',
    serialNumber: 'SW01-20260516',
    organization: '南京市某单位',
    owner: '李四',
    remark: '承担核心交换职责',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'asset-security-01',
    name: '边界防火墙 FW-01',
    assetId: 'ASSET-20260515-0003',
    ipAddress: '10.16.109.20',
    deviceType: 'security',
    status: 'attention',
    location: '网络边界区',
    model: 'USG6000',
    manufacturer: 'Huawei',
    serialNumber: 'FW01-20260516',
    organization: '南京市某单位',
    owner: '王鑫涛',
    remark: '需关注边界访问策略',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'asset-server-01',
    name: '运维平台服务器 SRV-01',
    assetId: 'ASSET-20260515-0004',
    ipAddress: '10.16.109.150',
    deviceType: 'server',
    status: 'critical',
    location: '应用区 B 柜',
    model: 'PowerEdge R740',
    manufacturer: 'Dell',
    serialNumber: 'SRV01-20260516',
    organization: '南京市某单位',
    owner: '李四',
    remark: '当前用于演示异常状态卡片',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'asset-storage-01',
    name: '集中存储 ST-01',
    assetId: 'ASSET-20260515-0005',
    ipAddress: '10.16.110.30',
    deviceType: 'storage',
    status: 'healthy',
    location: '灾备机房',
    model: '3PAR 8200',
    manufacturer: 'HPE',
    serialNumber: 'ST01-20260516',
    organization: '南京市某单位',
    owner: '赵敏',
    remark: '提供归档与备份存储',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const DEFAULT_CONFIG: PersistedConfig = {
  llmConfigs: [],
  activeModelId: null,
  activeConversationId: null,
  managedTaskConfigs: {},
  chatMcpMode: 'manual',
  selectedManualMcpServer: null,
  theme: 'dark',
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
    id: String(source.id || crypto.randomUUID()),
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
    activeConversationId: raw.activeConversationId ?? raw.active_conversation_id,
    managedTaskConfigs: raw.managedTaskConfigs ?? raw.managed_task_configs,
    chatMcpMode: raw.chatMcpMode ?? raw.chat_mcp_mode,
    selectedManualMcpServer:
      raw.selectedManualMcpServer ??
      raw.selected_manual_mcp_server ??
      raw.selectedManualMcpTool ??
      raw.selected_manual_mcp_tool,
    theme: raw.theme,
    backgroundPreset: raw.backgroundPreset ?? raw.background_preset,
    sidebarCollapsed: raw.sidebarCollapsed ?? raw.sidebar_collapsed,
    activeWorkspace: raw.activeWorkspace ?? raw.active_workspace,
    operatorProfile: normalizeOperatorProfile(raw.operatorProfile ?? raw.operator_profile),
    assetDevices: normalizeAssetDevices(raw.assetDevices ?? raw.asset_devices),
  };
}

export function readBootstrapPersistedConfig(): Partial<PersistedConfig> {
  if (typeof window === 'undefined') return {};
  // Bootstrap only needs the freshest UI snapshot that was written locally.
  // Runtime reconciliation with the persisted backend config happens later via
  // loadPersistedConfig().
  return readLocalConfigCache() as Partial<PersistedConfig>;
}

function mergeRuntimeConfigWithLocalSnapshot(runtimeRaw: Record<string, unknown>): Record<string, unknown> {
  // Runtime config is merged with the freshest local UI snapshot so refreshes
  // restore the latest workspace/conversation state without maintaining a
  // second normalization path for bootstrap.
  return {
    ...normalizeConfigShape(runtimeRaw),
    ...readLocalConfigCache(),
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

export function readBootstrapPersistedConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
  return normalizeConversations(readLocalConversationCache());
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

function readLocalConfigCache(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(CONFIG_CACHE_KEY);
    if (!raw) return {};
    return normalizeConfigShape(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function cachePersistedConfigSnapshot(config: PersistedConfig): void {
  writeLocalConfigCache(config);
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
