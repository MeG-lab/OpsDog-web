import type {
  ChatExecutionPlan,
  ChatRouteDecision,
  Conversation,
  ManagedTaskInfo,
  MCPTool,
  ScriptExecutionResult,
  SkillArgsValidationResult,
} from '../../types';
import type {
  ChatRequest,
  ChatResponse,
  HealthResponse,
  ModelListRequest,
  ScriptUploadResponse,
} from '../contracts';

export type RuntimeUnlistenFn = () => void | Promise<void>;

export type SkillExecutionCandidate = {
  name: string;
  triggers: string[];
  entryScript: string;
  taskKind: 'instant' | 'managed';
  description?: string;
};

export type ScriptUploadKind = 'instant' | 'managed';

export interface Runtime {
  mode: 'web';
  getBackendHealth(): Promise<HealthResponse>;
  sendChatMessage(request: ChatRequest): Promise<ChatResponse>;
  fetchAvailableModels(request: ModelListRequest): Promise<string[]>;
  routeChatInput(input: string): Promise<ChatRouteDecision>;
  buildChatExecutionPlan(input: string, allowedSkills: SkillExecutionCandidate[]): Promise<ChatExecutionPlan>;
  sendChatMessageStream(
    request: ChatRequest,
    conversationId: string,
    messageId: string,
  ): Promise<void>;
  onStreamChunk(
    callback: (payload: { conversationId: string; messageId: string; chunk: string }) => void,
  ): Promise<RuntimeUnlistenFn>;
  onStreamComplete(
    callback: (payload: { conversationId: string; messageId: string; success: boolean; error?: string }) => void,
  ): Promise<RuntimeUnlistenFn>;
  executeInstantSkill(skillName: string, args?: string[]): Promise<ScriptExecutionResult>;
  uploadScript(kind: ScriptUploadKind, file: File, description: string): Promise<ScriptUploadResponse>;
  startManagedTask(taskId: string, scriptPath: string, args?: string[]): Promise<ManagedTaskInfo>;
  restartManagedTask(taskId: string, scriptPath: string, args?: string[]): Promise<ManagedTaskInfo>;
  stopManagedTask(taskId: string): Promise<ManagedTaskInfo>;
  listManagedTasks(): Promise<ManagedTaskInfo[]>;
  getManagedTask(taskId: string): Promise<ManagedTaskInfo | null>;
  restoreManagedTasks(): Promise<ManagedTaskInfo[]>;
  scanSkills(): Promise<Array<{
    name: string;
    version: string;
    description: string;
    triggers: string[];
    taskKind: 'instant' | 'managed';
    entryScript: string;
    timeoutSeconds: number;
    dependencies: string[];
    defaultArgs?: string[];
    path: string;
  }>>;
  updateSkillMeta(
    skillName: string,
    description: string,
    triggers: string[],
  ): Promise<{
    name: string;
    version: string;
    description: string;
    triggers: string[];
    taskKind: 'instant' | 'managed';
    entryScript: string;
    timeoutSeconds: number;
    dependencies: string[];
    defaultArgs?: string[];
    path: string;
  }>;
  loadSkillInstructions(skillPath: string): Promise<string>;
  resolveSkillEntryScript(skillPath: string, entryScript: string): Promise<string>;
  validateSkillArgs(skillPath: string, args: string[]): Promise<SkillArgsValidationResult>;
  loadConfig(): Promise<Record<string, unknown>>;
  saveConfig(config: Record<string, unknown>): Promise<void>;
  loadConversations(): Promise<Conversation[]>;
  saveConversations(conversations: Conversation[]): Promise<void>;
  listConversationSummaries(): Promise<Array<Omit<Conversation, 'messages'>>>;
  loadConversationMessages(conversationId: string): Promise<Conversation['messages']>;
  upsertConversationRecord(conversation: Omit<Conversation, 'messages'> & { messages?: Conversation['messages'] }): Promise<void>;
  appendConversationMessage(conversationId: string, message: Conversation['messages'][number]): Promise<void>;
  updateConversationMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<Conversation['messages'][number]>,
  ): Promise<void>;
  replaceConversationMessages(conversationId: string, messages: Conversation['messages']): Promise<void>;
  deleteConversationRecord(conversationId: string): Promise<void>;
  connectMCPServer(serverConfig: Record<string, unknown>): Promise<Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
  }>>;
  disconnectMCPServer(serverName: string): Promise<void>;
  listMCPTools(): Promise<MCPTool[]>;
  getMCPStatus(): Promise<Array<{
    name: string;
    connected: boolean;
    toolCount: number;
  }>>;
  callMCPTool(
    serverName: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type?: string; text?: string; contentType?: string }>;
    isError?: boolean;
  }>;
  getSystemInfo(): Promise<{
    os: string;
    arch: string;
    hostname: string;
  }>;
}
