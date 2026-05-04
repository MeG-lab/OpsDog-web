import { create } from 'zustand';
import type { Conversation, Message, LLMConfig, Skill, MCPServer, ManagedTaskConfig } from '../types';
import { connectMCPServer, scanSkills } from '../services/runtime';
import { DEFAULT_FILESYSTEM_ARGS, normalizeFilesystemServer } from '../services/runtime/filesystemDefaults';
import {
  applyAppearance,
  DEFAULT_BACKGROUND_PRESET,
  readInitialBackgroundPreset,
  readInitialTheme,
  type BackgroundPreset,
} from './appearance';
import {
  cachePersistedConfigSnapshot,
  debouncedPersistConversationMessageUpdate,
  loadPersistedConversations,
  persistConversationAppendMessage,
  persistConversationDelete,
  persistConversationMessagesReplace,
  persistConversationMetadata,
  debouncedSaveConversations,
  loadPersistedConfig,
  debouncedSaveConfig,
  readBootstrapPersistedConfig,
  readBootstrapPersistedConversations,
} from '../services/persistence';

const genId = () => crypto.randomUUID();
export const SYSTEM_ANNOUNCEMENTS_ID = 'system-announcements';
const DEFAULT_MCP_SERVERS: MCPServer[] = [
  {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: DEFAULT_FILESYSTEM_ARGS,
    enabled: true,
    connected: false,
    connecting: false,
    toolCount: 0,
    statusMessage: '',
    statusLevel: 'idle',
    riskLevel: 'read-only',
    toolRiskOverrides: {
      read_file: 'read-only',
      read_text_file: 'read-only',
      read_media_file: 'read-only',
      read_multiple_files: 'read-only',
      get_file_info: 'read-only',
      list_directory: 'read-only',
      list_directory_with_sizes: 'read-only',
      directory_tree: 'read-only',
      list_allowed_directories: 'read-only',
      search_files: 'read-only',
      write_file: 'destructive',
      edit_file: 'destructive',
      move_file: 'destructive',
      create_directory: 'state-change',
    },
  },
];

const INITIAL_THEME = readInitialTheme();
const INITIAL_BACKGROUND_PRESET = readInitialBackgroundPreset();
const BOOTSTRAP_CONFIG = readBootstrapPersistedConfig();
const BOOTSTRAP_CONVERSATIONS = readBootstrapPersistedConversations();
const BOOTSTRAP_ACTIVE_CONVERSATION_ID =
  BOOTSTRAP_CONFIG.activeConversationId &&
  BOOTSTRAP_CONVERSATIONS.some(conversation => conversation.id === BOOTSTRAP_CONFIG.activeConversationId)
    ? BOOTSTRAP_CONFIG.activeConversationId
    : pickInitialActiveConversationId(BOOTSTRAP_CONVERSATIONS);
const BOOTSTRAP_MCP_SERVERS =
  Array.isArray(BOOTSTRAP_CONFIG.mcpServers) && BOOTSTRAP_CONFIG.mcpServers.length > 0
    ? BOOTSTRAP_CONFIG.mcpServers.map(server => ({
        ...normalizeFilesystemServer(server),
        connected: false,
        connecting: false,
        toolCount: 0,
        statusMessage: '',
        statusLevel: 'idle' as const,
      }))
    : DEFAULT_MCP_SERVERS;
const BOOTSTRAP_ACTIVE_WORKSPACE = BOOTSTRAP_CONFIG.activeWorkspace ?? 'chat';

function pickInitialActiveConversationId(conversations: Conversation[]): string | null {
  const normalConversation = conversations
    .filter(conv => conv.kind !== 'system')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  return normalConversation?.id || null;
}

function buildPersistedConfigSnapshot() {
  const appState = useAppStore.getState();
  const chatState = useChatStore.getState();
  return {
    llmConfigs: appState.llmConfigs,
    activeModelId: appState.activeModelId,
    activeConversationId: chatState.activeConversationId,
    mcpServers: appState.mcpServers.map(({ name, command, args, enabled, transport, url, headers, riskLevel, toolRiskOverrides }) => ({
      name,
      command,
      args,
      enabled,
      transport,
      url,
      headers,
      riskLevel,
      toolRiskOverrides,
    })),
    managedTaskConfigs: appState.managedTaskConfigs,
    theme: appState.theme,
    backgroundPreset: appState.backgroundPreset,
    sidebarCollapsed: appState.sidebarCollapsed,
    activeWorkspace: appState.activeWorkspace,
    enabledSkills: appState.skills.filter(s => s.enabled).map(s => s.name),
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
  activeWorkspace: 'chat' | 'scripts' | 'overview';
  activePanel: 'settings' | 'tools' | null;
  backendOnline: boolean;
  backendStatusMessage: string;
  focusedScriptId: string | null;
  // Config
  llmConfigs: LLMConfig[];
  activeModelId: string | null;
  mcpServers: MCPServer[];
  managedTaskConfigs: Record<string, ManagedTaskConfig>;
  // Skills
  skills: Skill[];
  skillsLoading: boolean;
  skillsInitialized: boolean;
  skillsError: string | null;

  // Actions
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleTheme: () => void;
  setBackgroundPreset: (preset: BackgroundPreset) => void;
  setActiveWorkspace: (workspace: AppState['activeWorkspace']) => void;
  setActivePanel: (p: AppState['activePanel']) => void;
  setBackendStatus: (online: boolean, message?: string) => void;
  focusScript: (scriptId: string | null) => void;
  addLLMConfig: (c: Omit<LLMConfig, 'id'>) => void;
  updateLLMConfig: (id: string, updates: Partial<LLMConfig>) => void;
  removeLLMConfig: (id: string) => void;
  setActiveModel: (id: string) => void;
  getActiveModel: () => LLMConfig | undefined;
  setMCPServers: (servers: MCPServer[]) => void;
  setManagedTaskConfig: (taskId: string, config: ManagedTaskConfig) => void;
  setSkills: (s: Skill[]) => void;
  toggleSkill: (name: string) => void;
  setSkillsLoading: (v: boolean) => void;
  setSkillsInitialized: (v: boolean) => void;
  setSkillsError: (v: string | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: BOOTSTRAP_CONFIG.sidebarCollapsed ?? false,
  theme: INITIAL_THEME,
  backgroundPreset: INITIAL_BACKGROUND_PRESET,
  activeWorkspace: BOOTSTRAP_CONFIG.activeWorkspace ?? 'chat',
  activePanel: null,
  backendOnline: true,
  backendStatusMessage: '后端已连接',
  focusedScriptId: null,
  llmConfigs: BOOTSTRAP_CONFIG.llmConfigs ?? [],
  activeModelId: BOOTSTRAP_CONFIG.activeModelId ?? null,
  mcpServers: BOOTSTRAP_MCP_SERVERS,
  managedTaskConfigs: BOOTSTRAP_CONFIG.managedTaskConfigs ?? {},
  skills: [],
  skillsLoading: false,
  skillsInitialized: false,
  skillsError: null,

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
  setActivePanel: (p) => set(s => ({ activePanel: s.activePanel === p ? null : p })),
  setBackendStatus: (online, message) => set({
    backendOnline: online,
    backendStatusMessage: message || (online ? '后端已连接' : '后端未连接'),
  }),
  focusScript: (scriptId) => set({ focusedScriptId: scriptId, activeWorkspace: 'scripts' }),
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
  setMCPServers: (mcpServers) => set({ mcpServers }),
  setManagedTaskConfig: (taskId, config) =>
    set(s => ({ managedTaskConfigs: { ...s.managedTaskConfigs, [taskId]: config } })),
  setSkills: (s) => set({ skills: s }),
  toggleSkill: (name) =>
    set(s => ({ skills: s.skills.map(sk => sk.name === name ? { ...sk, enabled: !sk.enabled } : sk) })),
  setSkillsLoading: (v) => set({ skillsLoading: v }),
  setSkillsInitialized: (v) => set({ skillsInitialized: v }),
  setSkillsError: (v) => set({ skillsError: v }),
}));

// ── Chat store ──
interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;

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
  updateTitle: (id: string, title: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: BOOTSTRAP_CONVERSATIONS,
  activeConversationId: BOOTSTRAP_ACTIVE_CONVERSATION_ID,
  isStreaming: false,

  hydrateConversations: (conversations, preferredActiveConversationId = null) =>
    set(() => {
      const availableConversationIds = new Set(conversations.map((conversation) => conversation.id));
      const activeConversationId = preferredActiveConversationId && availableConversationIds.has(preferredActiveConversationId)
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
  // blocking first paint on skills/MCP side effects.
  useChatStore.getState().hydrateConversations(restoredConversations, config.activeConversationId);
  useChatStore.getState().ensureSystemConversation();

  if (config.llmConfigs.length > 0) {
    useAppStore.setState({ llmConfigs: config.llmConfigs });
  }
  if (config.activeModelId) {
    useAppStore.setState({ activeModelId: config.activeModelId });
  }

  const configuredMCPServers = (config.mcpServers?.length ? config.mcpServers : DEFAULT_MCP_SERVERS).map(server => ({
    ...normalizeFilesystemServer(server),
    connected: false,
    connecting: false,
    toolCount: 0,
    statusMessage: '',
    statusLevel: 'idle' as const,
  }));

  useAppStore.setState({
    mcpServers: configuredMCPServers,
    managedTaskConfigs: config.managedTaskConfigs ?? {},
    sidebarCollapsed: config.sidebarCollapsed ?? false,
    activeWorkspace: config.activeWorkspace ?? 'chat',
    theme: config.theme ?? 'dark',
    backgroundPreset: config.backgroundPreset ?? DEFAULT_BACKGROUND_PRESET,
  });

  applyAppearance(config.theme ?? 'dark', config.backgroundPreset ?? DEFAULT_BACKGROUND_PRESET);

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
      await loadInitialSkills();
      await autoReconnectEnabledMCPServers(useAppStore.getState().mcpServers);
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

async function loadInitialSkills(): Promise<void> {
  useAppStore.setState({ skillsLoading: true, skillsError: null });
  try {
    const raw = await scanSkills();
    const currentSkills = useAppStore.getState().skills;
      const mapped = raw.map((s: any) => ({
        name: s.name,
        version: s.version,
        description: s.description,
        taskKind: s.taskKind || s.task_kind || 'instant',
        triggers: s.triggers,
        entryScript: s.entryScript || s.entry_script || '',
        timeoutSeconds: s.timeoutSeconds || s.timeout_seconds || 60,
        dependencies: s.dependencies || [],
        defaultArgs: s.defaultArgs || s.default_args || [],
        enabled: currentSkills.find(skill => skill.name === s.name)?.enabled ?? true,
        path: s.path,
      }));
    useAppStore.setState({ skills: mapped, skillsInitialized: true });
  } catch (error) {
    console.warn('Failed to load initial skills:', error);
    useAppStore.setState({
      skillsInitialized: true,
      skillsError: error instanceof Error ? error.message : String(error),
    });
  } finally {
    useAppStore.setState({ skillsLoading: false });
  }
}

async function autoReconnectEnabledMCPServers(servers: MCPServer[]): Promise<void> {
  const reconnectTargets = servers.filter(server =>
    server.enabled !== false &&
    (
      (server.transport === 'streamable-http' && Boolean(server.url?.trim())) ||
      ((server.transport === 'stdio' || !server.transport) && Boolean(server.command?.trim()))
    )
  );
  if (reconnectTargets.length === 0) return;

  useAppStore.setState({
    mcpServers: servers.map(server => ({
      ...server,
      connecting: server.enabled !== false,
      connected: false,
      toolCount: 0,
      statusMessage: server.enabled !== false ? '正在自动重连...' : '',
      statusLevel: server.enabled !== false ? 'info' : 'idle',
    })),
  });

  await Promise.all(reconnectTargets.map(async (server) => {
    try {
      const tools = await connectMCPServer({
        name: server.name,
        command: server.command,
        args: server.args,
        env: {},
        transport: server.transport,
        url: server.url,
        headers: server.headers,
        riskLevel: server.riskLevel,
        toolRiskOverrides: server.toolRiskOverrides,
      });

      useAppStore.setState(state => ({
        mcpServers: state.mcpServers.map(item =>
          item.name === server.name
            ? {
                ...item,
                connected: true,
                connecting: false,
                toolCount: tools.length,
                statusMessage: `已自动连接，发现 ${tools.length} 个工具`,
                statusLevel: 'success',
              }
            : item
        ),
      }));
    } catch (error) {
      console.warn(`Failed to auto-connect MCP server ${server.name}:`, error);
      useAppStore.setState(state => ({
        mcpServers: state.mcpServers.map(item =>
          item.name === server.name
            ? {
                ...item,
                connected: false,
                connecting: false,
                toolCount: 0,
                statusMessage: `自动连接失败：${error instanceof Error ? error.message : String(error)}`,
                statusLevel: 'error',
              }
            : item
        ),
      }));
    }
  }));
}
