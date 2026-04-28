import { create } from 'zustand';
import type { Conversation, Message, LLMConfig, Skill, MCPServer, ManagedTaskConfig } from '../types';
import { connectMCPServer, scanSkills } from '../services/tauri';
import {
  debouncedPersistConversationMessageUpdate,
  loadPersistedConversations,
  persistConversationAppendMessage,
  persistConversationDelete,
  persistConversationMessagesReplace,
  persistConversationMetadata,
  debouncedSaveConversations,
  loadPersistedConfig,
  debouncedSaveConfig,
} from '../services/persistence';

const genId = () => crypto.randomUUID();
export const SYSTEM_ANNOUNCEMENTS_ID = 'system-announcements';
const DEFAULT_BACKGROUND_PRESET = 'white' as const;
const DEFAULT_MCP_SERVERS: MCPServer[] = [
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users'],
    enabled: true,
    connected: false,
    connecting: false,
    toolCount: 0,
    statusMessage: '',
    statusLevel: 'idle',
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
];

type BackgroundPreset = 'white' | 'mist' | 'sage' | 'sand' | 'sky' | 'lavender';

function pickInitialActiveConversationId(conversations: Conversation[]): string | null {
  const normalConversation = conversations
    .filter(conv => conv.kind !== 'system')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  return normalConversation?.id || null;
}

function applyAppearance(theme: 'dark' | 'light', backgroundPreset: BackgroundPreset) {
  document.documentElement.classList.add('theme-transition');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-bg', backgroundPreset);
  localStorage.setItem('aiops_theme', theme);
  localStorage.setItem('aiops_background_preset', backgroundPreset);
  window.setTimeout(() => {
    document.documentElement.classList.remove('theme-transition');
  }, 360);
}

// ── App-wide store (UI state + config) ──
interface AppState {
  // UI
  sidebarCollapsed: boolean;
  theme: 'dark' | 'light';
  backgroundPreset: BackgroundPreset;
  activeWorkspace: 'chat' | 'scripts';
  activePanel: 'settings' | 'tools' | 'scripts' | null;
  // Config
  llmConfigs: LLMConfig[];
  activeModelId: string | null;
  mcpServers: MCPServer[];
  pythonPath: string;
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
  addLLMConfig: (c: Omit<LLMConfig, 'id'>) => void;
  updateLLMConfig: (id: string, updates: Partial<LLMConfig>) => void;
  removeLLMConfig: (id: string) => void;
  setActiveModel: (id: string) => void;
  getActiveModel: () => LLMConfig | undefined;
  setMCPServers: (servers: MCPServer[]) => void;
  setPythonPath: (p: string) => void;
  setManagedTaskConfig: (taskId: string, config: ManagedTaskConfig) => void;
  setSkills: (s: Skill[]) => void;
  toggleSkill: (name: string) => void;
  setSkillsLoading: (v: boolean) => void;
  setSkillsInitialized: (v: boolean) => void;
  setSkillsError: (v: string | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: false,
  theme: 'dark',
  backgroundPreset: DEFAULT_BACKGROUND_PRESET,
  activeWorkspace: 'chat',
  activePanel: null,
  llmConfigs: [],
  activeModelId: null,
  mcpServers: DEFAULT_MCP_SERVERS,
  pythonPath: 'python3',
  managedTaskConfigs: {},
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
    applyAppearance(get().theme, backgroundPreset);
    set({ backgroundPreset });
  },
  setActiveWorkspace: (workspace) => set({ activeWorkspace: workspace }),
  setActivePanel: (p) => set(s => ({ activePanel: s.activePanel === p ? null : p })),
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
  setPythonPath: (p) => set({ pythonPath: p }),
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
  conversationsHydrated: boolean;

  hydrateConversations: (conversations: Conversation[]) => void;
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
  conversations: [],
  activeConversationId: null,
  isStreaming: false,
  conversationsHydrated: false,

  hydrateConversations: (conversations) =>
    set(() => ({
      conversations,
      activeConversationId: pickInitialActiveConversationId(conversations),
      conversationsHydrated: true,
    })),

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
useChatStore.subscribe(state => {
  if (!state.conversationsHydrated) return;
  if (!state.isStreaming) debouncedSaveConversations(state.conversations);
});

useAppStore.subscribe(state => {
  debouncedSaveConfig({
    llmConfigs: state.llmConfigs,
    activeModelId: state.activeModelId,
    mcpServers: state.mcpServers.map(({ name, command, args, enabled, transport, url, headers, riskLevel, toolRiskOverrides }) => ({
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
    pythonPath: state.pythonPath,
    managedTaskConfigs: state.managedTaskConfigs,
    theme: state.theme,
    backgroundPreset: state.backgroundPreset,
    sidebarCollapsed: state.sidebarCollapsed,
    enabledSkills: state.skills.filter(s => s.enabled).map(s => s.name),
  });
});

// ── Boot ──
export async function initializeStores(): Promise<void> {
  try {
    const restoredConversations = await loadPersistedConversations();
    useChatStore.getState().hydrateConversations(restoredConversations);
    useChatStore.getState().ensureSystemConversation();
    const config = await loadPersistedConfig();
    if (config.llmConfigs.length > 0) {
      useAppStore.setState({ llmConfigs: config.llmConfigs });
    }
    if (config.activeModelId) useAppStore.setState({ activeModelId: config.activeModelId });
    const configuredMCPServers = (config.mcpServers?.length ? config.mcpServers : DEFAULT_MCP_SERVERS).map(server => ({
      ...server,
      connected: false,
      connecting: false,
      toolCount: 0,
      statusMessage: '',
      statusLevel: 'idle' as const,
    }));
    useAppStore.setState({ mcpServers: configuredMCPServers });
    if (config.pythonPath) useAppStore.setState({ pythonPath: config.pythonPath });
    if (config.managedTaskConfigs) useAppStore.setState({ managedTaskConfigs: config.managedTaskConfigs });
    if (config.backgroundPreset) useAppStore.setState({ backgroundPreset: config.backgroundPreset });
    if (config.sidebarCollapsed !== undefined) useAppStore.setState({ sidebarCollapsed: config.sidebarCollapsed });
    const savedTheme = (localStorage.getItem('aiops_theme') as 'dark' | 'light' | null) ?? config.theme;
    const savedBackgroundPreset = (localStorage.getItem('aiops_background_preset') as BackgroundPreset | null) ?? config.backgroundPreset ?? DEFAULT_BACKGROUND_PRESET;
    applyAppearance(savedTheme ?? 'dark', savedBackgroundPreset);
    useAppStore.setState({
      theme: savedTheme ?? 'dark',
      backgroundPreset: savedBackgroundPreset,
    });

    await loadInitialSkills();
    await autoReconnectEnabledMCPServers(configuredMCPServers);
  } catch (e) {
    console.warn('Failed to init stores:', e);
  }
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
  const reconnectTargets = servers.filter(server => server.enabled !== false);
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
