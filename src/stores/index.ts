import { create } from 'zustand';
import type { Conversation, Message, LLMConfig, ManagedTaskConfig, ServerDefinition, ChatMcpMode, OperatorProfile, AssetDevice, ReportDraft, SkillPackageRecord } from '../types';
import { listServers, listSkillPackages } from '../services/runtime';
import {
  applyAppearance,
  DEFAULT_BACKGROUND_PRESET,
  readInitialBackgroundPreset,
  readInitialTheme,
  type BackgroundPreset,
} from './appearance';
import {
  cachePersistedConfigSnapshot,
  DEFAULT_ASSET_DEVICES,
  debouncedPersistConversationMessageUpdate,
  DEFAULT_OPERATOR_PROFILE,
  loadPersistedConversations,
  persistConversationAppendMessage,
  persistConversationDelete,
  persistConversationMessagesReplace,
  persistConversationMetadata,
  debouncedSaveConversations,
  loadPersistedConfig,
  normalizeAssetDevices,
  normalizeOperatorProfile,
  debouncedSaveConfig,
  readBootstrapPersistedConfig,
  readBootstrapPersistedConversations,
} from '../services/persistence';
import { createClientId } from '../utils/createClientId';

const genId = () => createClientId('conversation');
export const SYSTEM_ANNOUNCEMENTS_ID = 'system-announcements';

type ToastTone = 'success' | 'info' | 'error';
export type SettingsSection = 'account' | 'profile' | 'ai-model' | 'notification' | 'appearance' | 'tools' | 'data';

type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  closing: boolean;
};

const TOAST_EXIT_DURATION_MS = 160;

const INITIAL_THEME = readInitialTheme();
const INITIAL_BACKGROUND_PRESET = readInitialBackgroundPreset();
const BOOTSTRAP_CONFIG = readBootstrapPersistedConfig();
const BOOTSTRAP_CONVERSATIONS = readBootstrapPersistedConversations();
const BOOTSTRAP_ACTIVE_CONVERSATION_ID =
  BOOTSTRAP_CONFIG.activeConversationId &&
  BOOTSTRAP_CONVERSATIONS.some(conversation => conversation.id === BOOTSTRAP_CONFIG.activeConversationId)
    ? BOOTSTRAP_CONFIG.activeConversationId
    : pickInitialActiveConversationId(BOOTSTRAP_CONVERSATIONS);
const BOOTSTRAP_ACTIVE_WORKSPACE = BOOTSTRAP_CONFIG.activeWorkspace ?? 'chat';

function getConversationActivityTimestamp(conversation: Conversation): number {
  return conversation.updatedAt ?? conversation.createdAt ?? 0;
}

function isMeaningfulConversation(conversation: Conversation): boolean {
  if (conversation.kind === 'system') return false;
  if (conversation.messages.length > 0) return true;
  return conversation.title.trim() !== '' && conversation.title !== '新对话';
}

function pickInitialActiveConversationId(conversations: Conversation[]): string | null {
  const normalConversations = conversations.filter(conv => conv.kind !== 'system');
  const meaningfulConversation = normalConversations
    .filter(isMeaningfulConversation)
    .sort((a, b) => getConversationActivityTimestamp(b) - getConversationActivityTimestamp(a))[0];

  if (meaningfulConversation) {
    return meaningfulConversation.id;
  }

  const normalConversation = normalConversations
    .sort((a, b) => getConversationActivityTimestamp(b) - getConversationActivityTimestamp(a))[0];

  return normalConversation?.id || null;
}

function buildPersistedConfigSnapshot() {
  const appState = useAppStore.getState();
  const chatState = useChatStore.getState();
  return {
    llmConfigs: appState.llmConfigs,
    activeModelId: appState.activeModelId,
    activeConversationId: chatState.activeConversationId,
    managedTaskConfigs: appState.managedTaskConfigs,
    chatMcpMode: appState.chatMcpMode,
    selectedManualMcpServer: appState.selectedManualMcpServer,
    theme: appState.theme,
    backgroundPreset: appState.backgroundPreset,
    sidebarCollapsed: appState.sidebarCollapsed,
    activeWorkspace: appState.activeWorkspace,
    operatorProfile: appState.operatorProfile,
    assetDevices: DEFAULT_ASSET_DEVICES,
  };
}

function persistConfigSnapshot() {
  const snapshot = buildPersistedConfigSnapshot();
  cachePersistedConfigSnapshot(snapshot);
  debouncedSaveConfig(snapshot);
}

// ── App-wide store (UI state + config) ──
interface AppState {
  // UI
  sidebarCollapsed: boolean;
  theme: 'dark' | 'light';
  backgroundPreset: BackgroundPreset;
  activeWorkspace: 'chat' | 'scripts' | 'overview' | 'servers' | 'settings' | 'more';
  activeSettingsSection: SettingsSection;
  activePanel: 'profile' | 'settings' | 'tools' | 'reports' | null;
  toolsPanelTab: 'skillPackages' | 'mcp';
  backendOnline: boolean;
  backendStatusMessage: string;
  focusedScriptId: string | null;
  chatMcpMode: ChatMcpMode;
  selectedManualMcpServer: string | null;
  // Config
  llmConfigs: LLMConfig[];
  activeModelId: string | null;
  servers: ServerDefinition[];
  skillPackages: SkillPackageRecord[];
  managedTaskConfigs: Record<string, ManagedTaskConfig>;
  operatorProfile: OperatorProfile;
  assetDevices: AssetDevice[];

  // Actions
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleTheme: () => void;
  setBackgroundPreset: (preset: BackgroundPreset) => void;
  setActiveWorkspace: (workspace: AppState['activeWorkspace']) => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
  setActivePanel: (p: AppState['activePanel']) => void;
  setToolsPanelTab: (tab: AppState['toolsPanelTab']) => void;
  setBackendStatus: (online: boolean, message?: string) => void;
  focusScript: (scriptId: string | null) => void;
  setChatMcpMode: (mode: ChatMcpMode) => void;
  setSelectedManualMcpServer: (serverName: string | null) => void;
  addLLMConfig: (c: Omit<LLMConfig, 'id'>) => void;
  updateLLMConfig: (id: string, updates: Partial<LLMConfig>) => void;
  removeLLMConfig: (id: string) => void;
  setActiveModel: (id: string) => void;
  getActiveModel: () => LLMConfig | undefined;
  setServers: (servers: ServerDefinition[]) => void;
  setSkillPackages: (packages: SkillPackageRecord[]) => void;
  setManagedTaskConfig: (taskId: string, config: ManagedTaskConfig) => void;
  setOperatorProfile: (profile: OperatorProfile) => void;
  setAssetDevices: (devices: AssetDevice[]) => void;
  upsertAssetDevice: (device: AssetDevice) => void;
  deleteAssetDevice: (deviceId: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: BOOTSTRAP_CONFIG.sidebarCollapsed ?? false,
  theme: INITIAL_THEME,
  backgroundPreset: INITIAL_BACKGROUND_PRESET,
  activeWorkspace: BOOTSTRAP_CONFIG.activeWorkspace ?? 'chat',
  activeSettingsSection: 'account',
  activePanel: null,
  toolsPanelTab: 'skillPackages',
  backendOnline: true,
  backendStatusMessage: '后端已连接',
  focusedScriptId: null,
  chatMcpMode: BOOTSTRAP_CONFIG.chatMcpMode ?? 'manual',
  selectedManualMcpServer: BOOTSTRAP_CONFIG.selectedManualMcpServer ?? null,
  llmConfigs: BOOTSTRAP_CONFIG.llmConfigs ?? [],
  activeModelId: BOOTSTRAP_CONFIG.activeModelId ?? null,
  servers: [],
  skillPackages: [],
  managedTaskConfigs: BOOTSTRAP_CONFIG.managedTaskConfigs ?? {},
  operatorProfile: normalizeOperatorProfile(BOOTSTRAP_CONFIG.operatorProfile ?? DEFAULT_OPERATOR_PROFILE),
  assetDevices: normalizeAssetDevices(BOOTSTRAP_CONFIG.assetDevices ?? DEFAULT_ASSET_DEVICES),

  toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    applyAppearance(next, get().backgroundPreset);
    set({ theme: next });
  },
  setBackgroundPreset: (backgroundPreset) => {
    applyAppearance('light', backgroundPreset);
    set({
      theme: 'light',
      backgroundPreset,
    });
  },
  setActiveWorkspace: (workspace) => set({ activeWorkspace: workspace }),
  setActiveSettingsSection: (activeSettingsSection) => set({ activeSettingsSection }),
  setActivePanel: (p) => set(s => ({ activePanel: s.activePanel === p ? null : p })),
  setToolsPanelTab: (tab) => set({ toolsPanelTab: tab }),
  setBackendStatus: (online, message) => set({
    backendOnline: online,
    backendStatusMessage: message || (online ? '后端已连接' : '后端未连接'),
  }),
  focusScript: (scriptId) => set({ focusedScriptId: scriptId, activeWorkspace: 'scripts' }),
  setChatMcpMode: (chatMcpMode) => set({ chatMcpMode }),
  setSelectedManualMcpServer: (selectedManualMcpServer) => set({ selectedManualMcpServer }),
  addLLMConfig: (c) => {
    const id = genId();
    set(s => {
      const configs = [...s.llmConfigs, { ...c, id }];
      return { llmConfigs: configs, activeModelId: s.activeModelId || id };
    });
  },
  updateLLMConfig: (id, updates) =>
    set(s => ({ llmConfigs: s.llmConfigs.map(c => c.id === id ? { ...c, ...updates } : c) })),
  removeLLMConfig: (id) =>
    set(s => ({
      llmConfigs: s.llmConfigs.filter(c => c.id !== id),
      activeModelId: s.activeModelId === id ? (s.llmConfigs.find(c => c.id !== id)?.id || null) : s.activeModelId,
    })),
  setActiveModel: (id) => set({ activeModelId: id }),
  getActiveModel: () => {
    const s = get();
    return s.llmConfigs.find(c => c.id === s.activeModelId);
  },
  setServers: (servers) => set({ servers }),
  setSkillPackages: (skillPackages) => set({ skillPackages }),
  setManagedTaskConfig: (taskId, config) =>
    set(s => ({ managedTaskConfigs: { ...s.managedTaskConfigs, [taskId]: config } })),
  setOperatorProfile: (operatorProfile) => set({ operatorProfile: normalizeOperatorProfile(operatorProfile) }),
  setAssetDevices: (assetDevices) => set({ assetDevices: normalizeAssetDevices(assetDevices) }),
  upsertAssetDevice: (device) =>
    set((state) => {
      const normalized = normalizeAssetDevices([device])[0];
      const existingIndex = state.assetDevices.findIndex((item) => item.id === normalized.id);
      if (existingIndex === -1) {
        return { assetDevices: [normalized, ...state.assetDevices] };
      }
      return {
        assetDevices: state.assetDevices.map((item) => (item.id === normalized.id ? normalized : item)),
      };
    }),
  deleteAssetDevice: (deviceId) =>
    set((state) => ({ assetDevices: state.assetDevices.filter((item) => item.id !== deviceId) })),
}));

// ── Chat store ──
interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;
  reportDrafts: Record<string, ReportDraft | undefined>;

  hydrateConversations: (conversations: Conversation[], preferredActiveConversationId?: string | null) => void;
  ensureSystemConversation: () => string;
  appendSystemAnnouncement: (content: string) => string;
  clearSystemAnnouncements: () => void;
  createConversation: (modelId?: string) => string;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  addMessage: (convId: string, msg: Omit<Message, 'id' | 'timestamp'>) => string;
  updateMessage: (convId: string, msgId: string, updates: Partial<Message>) => void;
  appendToMessage: (convId: string, msgId: string, chunk: string) => void;
  setStreaming: (v: boolean) => void;
  setReportDraft: (convId: string, draft: ReportDraft) => void;
  clearReportDraft: (convId: string) => void;
  updateTitle: (id: string, title: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: BOOTSTRAP_CONVERSATIONS,
  activeConversationId: BOOTSTRAP_ACTIVE_CONVERSATION_ID,
  isStreaming: false,
  reportDrafts: {},

  hydrateConversations: (conversations, preferredActiveConversationId = null) =>
    set(state => {
      const availableConversationIds = new Set(conversations.map((conversation) => conversation.id));
      const activeConversationId =
        state.activeConversationId && availableConversationIds.has(state.activeConversationId)
          ? state.activeConversationId
          : preferredActiveConversationId && availableConversationIds.has(preferredActiveConversationId)
            ? preferredActiveConversationId
            : pickInitialActiveConversationId(conversations);

      return {
        conversations,
        activeConversationId,
      };
    }),

  ensureSystemConversation: () => {
    const id = SYSTEM_ANNOUNCEMENTS_ID;
    set(s => {
      const existing = s.conversations.find(c => c.id === id);
      if (existing) {
        return existing.kind === 'system'
          ? s
          : {
              conversations: s.conversations.map(conv =>
                conv.id === id
                  ? { ...conv, kind: 'system', systemChannel: 'announcements', title: '系统通告' }
                  : conv
              ),
            };
      }

      const systemConversation: Conversation = {
        id,
        title: '系统通告',
        kind: 'system',
        systemChannel: 'announcements',
        lastReadAt: Date.now(),
        messages: [],
        modelId: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      return {
        conversations: [systemConversation, ...s.conversations],
        activeConversationId: s.activeConversationId,
      };
    });
    const ensuredConversation = get().conversations.find(c => c.id === id);
    if (ensuredConversation) {
      void persistConversationMetadata({
        id: ensuredConversation.id,
        title: ensuredConversation.title,
        kind: ensuredConversation.kind,
        systemChannel: ensuredConversation.systemChannel,
        lastReadAt: ensuredConversation.lastReadAt,
        modelId: ensuredConversation.modelId,
        createdAt: ensuredConversation.createdAt,
        updatedAt: ensuredConversation.updatedAt,
      });
    }
    return id;
  },

  appendSystemAnnouncement: (content) => {
    const id = SYSTEM_ANNOUNCEMENTS_ID;
    const messageId = genId();
    const timestamp = Date.now();
    const appendedMessage: Message = {
      id: messageId,
      role: 'system',
      content,
      timestamp,
    };
    set(s => {
      const existing = s.conversations.find(c => c.id === id);
      const systemConversation = existing ?? {
        id,
        title: '系统通告',
        kind: 'system' as const,
        systemChannel: 'announcements' as const,
        lastReadAt: timestamp,
        messages: [],
        modelId: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const nextConversation: Conversation = {
        ...systemConversation,
        kind: 'system',
        systemChannel: 'announcements',
        title: '系统通告',
        lastReadAt: s.activeConversationId === id ? timestamp : (systemConversation.lastReadAt ?? systemConversation.updatedAt ?? timestamp),
        updatedAt: timestamp,
        messages: [
          ...systemConversation.messages,
          {
            id: messageId,
            role: 'system',
            content,
            timestamp,
          },
        ],
      };

      const rest = s.conversations.filter(conv => conv.id !== id);
      return {
        conversations: [nextConversation, ...rest],
        activeConversationId: s.activeConversationId,
      };
    });
    const persistedConversation = get().conversations.find(c => c.id === id);
    if (persistedConversation) {
      void persistConversationMetadata({
        id: persistedConversation.id,
        title: persistedConversation.title,
        kind: persistedConversation.kind,
        systemChannel: persistedConversation.systemChannel,
        lastReadAt: persistedConversation.lastReadAt,
        modelId: persistedConversation.modelId,
        createdAt: persistedConversation.createdAt,
        updatedAt: persistedConversation.updatedAt,
      });
      void persistConversationAppendMessage(id, appendedMessage);
    }
    return messageId;
  },

  clearSystemAnnouncements: () => {
    set(s => ({
      conversations: s.conversations.map(conv =>
        conv.id === SYSTEM_ANNOUNCEMENTS_ID
          ? {
              ...conv,
              messages: [],
              updatedAt: Date.now(),
              lastReadAt: Date.now(),
            }
          : conv
      ),
    }));
    const clearedConversation = get().conversations.find(c => c.id === SYSTEM_ANNOUNCEMENTS_ID);
    if (clearedConversation) {
      void persistConversationMetadata({
        id: clearedConversation.id,
        title: clearedConversation.title,
        kind: clearedConversation.kind,
        systemChannel: clearedConversation.systemChannel,
        lastReadAt: clearedConversation.lastReadAt,
        modelId: clearedConversation.modelId,
        createdAt: clearedConversation.createdAt,
        updatedAt: clearedConversation.updatedAt,
      });
      void persistConversationMessagesReplace(SYSTEM_ANNOUNCEMENTS_ID, []);
    }
  },

  createConversation: (modelId) => {
    const id = genId();
    const timestamp = Date.now();
    const conversation: Conversation = { id, title: '新对话', kind: 'normal', lastReadAt: timestamp, messages: [], modelId: modelId || '', createdAt: timestamp, updatedAt: timestamp };
    set(s => ({
      conversations: [conversation, ...s.conversations],
      activeConversationId: id,
    }));
    void persistConversationMetadata({
      id: conversation.id,
      title: conversation.title,
      kind: conversation.kind,
      systemChannel: conversation.systemChannel,
      lastReadAt: conversation.lastReadAt,
      modelId: conversation.modelId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
    return id;
  },

  deleteConversation: (id) => {
    set(s => {
      if (id === SYSTEM_ANNOUNCEMENTS_ID) {
        return s;
      }
      const filtered = s.conversations.filter(c => c.id !== id);
      const nextActiveConversationId = s.activeConversationId === id
        ? pickInitialActiveConversationId(filtered)
        : s.activeConversationId;
      return {
        conversations: filtered,
        activeConversationId: nextActiveConversationId,
      };
    });
    void persistConversationDelete(id);
  },

  setActiveConversation: (id) => {
    set(s => ({
      activeConversationId: id,
      conversations: s.conversations.map(conv =>
        conv.id === id
          ? { ...conv, lastReadAt: Date.now() }
          : conv
      ),
    }));
    const activatedConversation = id ? get().conversations.find(conv => conv.id === id) : null;
    if (activatedConversation) {
      void persistConversationMetadata({
        id: activatedConversation.id,
        title: activatedConversation.title,
        kind: activatedConversation.kind,
        systemChannel: activatedConversation.systemChannel,
        lastReadAt: activatedConversation.lastReadAt,
        modelId: activatedConversation.modelId,
        createdAt: activatedConversation.createdAt,
        updatedAt: activatedConversation.updatedAt,
      });
    }
  },

  addMessage: (convId, msg) => {
    const id = genId();
    const timestamp = Date.now();
    const full: Message = { ...msg, id, timestamp };
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === convId
          ? {
              ...c,
              messages: [...c.messages, full],
              updatedAt: timestamp,
              lastReadAt: s.activeConversationId === convId ? timestamp : (c.lastReadAt ?? c.updatedAt ?? timestamp),
            }
          : c
      ),
    }));
    const updatedConversation = get().conversations.find(c => c.id === convId);
    if (updatedConversation) {
      void persistConversationMetadata({
        id: updatedConversation.id,
        title: updatedConversation.title,
        kind: updatedConversation.kind,
        systemChannel: updatedConversation.systemChannel,
        lastReadAt: updatedConversation.lastReadAt,
        modelId: updatedConversation.modelId,
        createdAt: updatedConversation.createdAt,
        updatedAt: updatedConversation.updatedAt,
      });
      void persistConversationAppendMessage(convId, full);
    }
    return id;
  },

  updateMessage: (convId, msgId, updates) => {
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === convId ? { ...c, messages: c.messages.map(m => m.id === msgId ? { ...m, ...updates } : m) } : c
      ),
    }));
    debouncedPersistConversationMessageUpdate(convId, msgId, updates);
  },

  appendToMessage: (convId, msgId, chunk) => {
    const targetConversation = get().conversations.find(c => c.id === convId);
    const targetMessage = targetConversation?.messages.find(m => m.id === msgId);
    const nextContent = `${targetMessage?.content ?? ''}${chunk}`;
    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === convId
          ? { ...c, messages: c.messages.map(m => m.id === msgId ? { ...m, content: m.content + chunk } : m) }
          : c
      ),
    }));
    debouncedPersistConversationMessageUpdate(convId, msgId, { content: nextContent });
  },

  setStreaming: (v) => set({ isStreaming: v }),
  setReportDraft: (convId, draft) => set(s => ({
    reportDrafts: {
      ...s.reportDrafts,
      [convId]: draft,
    },
  })),
  clearReportDraft: (convId) => set(s => {
    const reportDrafts = { ...s.reportDrafts };
    delete reportDrafts[convId];
    return { reportDrafts };
  }),
  updateTitle: (id, title) => {
    set(s => ({
      conversations: s.conversations.map(c => c.id === id ? { ...c, title } : c),
    }));
    const updatedConversation = get().conversations.find(c => c.id === id);
    if (updatedConversation) {
      void persistConversationMetadata({
        id: updatedConversation.id,
        title: updatedConversation.title,
        kind: updatedConversation.kind,
        systemChannel: updatedConversation.systemChannel,
        lastReadAt: updatedConversation.lastReadAt,
        modelId: updatedConversation.modelId,
        createdAt: updatedConversation.createdAt,
        updatedAt: updatedConversation.updatedAt,
      });
    }
  },
}));

// ── Auto-save subscriptions ──
let lastPersistedActiveConversationId: string | null = BOOTSTRAP_ACTIVE_CONVERSATION_ID;

useChatStore.subscribe(state => {
  if (!state.isStreaming) debouncedSaveConversations(state.conversations);
  if (state.activeConversationId !== lastPersistedActiveConversationId) {
    lastPersistedActiveConversationId = state.activeConversationId;
    persistConfigSnapshot();
  }
});

let lastPersistedWorkspace: AppState['activeWorkspace'] | null = BOOTSTRAP_ACTIVE_WORKSPACE;

useAppStore.subscribe(() => {
  const { activeWorkspace } = useAppStore.getState();
  if (activeWorkspace !== lastPersistedWorkspace) {
    lastPersistedWorkspace = activeWorkspace;
    persistConfigSnapshot();
    return;
  }
  debouncedSaveConfig(buildPersistedConfigSnapshot());
});

// ── Boot ──
function applyRestoredConfig(config: Awaited<ReturnType<typeof loadPersistedConfig>>, restoredConversations: Conversation[]) {
  // First-pass restoration: recover the current page and appearance before any
  // slower background work starts. This keeps refresh behavior stable without
  // blocking first paint on Skill package/MCP side effects.
  useChatStore.getState().hydrateConversations(restoredConversations, config.activeConversationId);
  useChatStore.getState().ensureSystemConversation();

  useAppStore.setState({
    llmConfigs: config.llmConfigs ?? [],
    activeModelId: config.activeModelId ?? null,
    servers: [],
    managedTaskConfigs: config.managedTaskConfigs ?? {},
    operatorProfile: normalizeOperatorProfile(config.operatorProfile ?? DEFAULT_OPERATOR_PROFILE),
    chatMcpMode: config.chatMcpMode ?? 'manual',
    selectedManualMcpServer: config.selectedManualMcpServer ?? null,
    sidebarCollapsed: config.sidebarCollapsed ?? false,
    activeWorkspace: config.activeWorkspace ?? 'chat',
    theme: config.theme ?? 'light',
    backgroundPreset: config.backgroundPreset ?? DEFAULT_BACKGROUND_PRESET,
    assetDevices: normalizeAssetDevices(config.assetDevices ?? []),
  });

  applyAppearance(config.theme ?? 'light', config.backgroundPreset ?? DEFAULT_BACKGROUND_PRESET);

  const availableConversationIds = new Set(useChatStore.getState().conversations.map(conversation => conversation.id));
  lastPersistedActiveConversationId =
    config.activeConversationId && availableConversationIds.has(config.activeConversationId)
      ? config.activeConversationId
      : pickInitialActiveConversationId(useChatStore.getState().conversations);
  lastPersistedWorkspace = config.activeWorkspace ?? useAppStore.getState().activeWorkspace;
}

function initializeBackgroundStoreTasks() {
  // Slow startup tasks intentionally run after the first UI state is restored.
  void (async () => {
    try {
      await refreshSkillPackageState();
      await refreshServerState();
    } catch (error) {
      console.warn('Failed to finish background store initialization:', error);
    }
  })();
}

export async function initializeStores(): Promise<void> {
  try {
    const [restoredConversations, config] = await Promise.all([
      loadPersistedConversations(),
      loadPersistedConfig(),
    ]);
    applyRestoredConfig(config, restoredConversations);
  } catch (e) {
    console.warn('Failed to init stores:', e);
  }

  initializeBackgroundStoreTasks();
}

export async function refreshServerState(): Promise<void> {
  try {
    const servers = await listServers();
    useAppStore.getState().setServers(servers);
  } catch (error) {
    console.warn('Failed to refresh server state:', error);
  }
}

export async function refreshSkillPackageState(): Promise<void> {
  try {
    const packages = await listSkillPackages();
    useAppStore.getState().setSkillPackages(packages);
  } catch (error) {
    console.warn('Failed to refresh skill package state:', error);
  }
}

interface ToastState {
  toasts: ToastItem[];
  showToast: (message: string, tone?: ToastTone, durationMs?: number) => string;
  dismissToast: (id: string) => void;
}

const toastTimers = new Map<string, number>();
const toastRemovalTimers = new Map<string, number>();

function clearToastTimer(id: string) {
  const timer = toastTimers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    toastTimers.delete(id);
  }
}

function clearToastRemovalTimer(id: string) {
  const timer = toastRemovalTimers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    toastRemovalTimers.delete(id);
  }
}

function removeToastNow(id: string) {
  clearToastTimer(id);
  clearToastRemovalTimer(id);
  useToastStore.setState((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  }));
}

function scheduleToastDismiss(id: string) {
  clearToastTimer(id);
  clearToastRemovalTimer(id);
  useToastStore.setState((state) => ({
    toasts: state.toasts.map((toast) => (
      toast.id === id && !toast.closing
        ? { ...toast, closing: true }
        : toast
    )),
  }));
  const removalTimer = window.setTimeout(() => {
    removeToastNow(id);
  }, TOAST_EXIT_DURATION_MS);
  toastRemovalTimers.set(id, removalTimer);
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (message, tone = 'success', durationMs = 2200) => {
    const id = genId();
    clearToastRemovalTimer(id);
    set((state) => ({
      toasts: [...state.toasts, { id, message, tone, closing: false }],
    }));
    const timer = window.setTimeout(() => {
      scheduleToastDismiss(id);
    }, durationMs);
    toastTimers.set(id, timer);
    return id;
  },
  dismissToast: (id) => {
    scheduleToastDismiss(id);
  },
}));
