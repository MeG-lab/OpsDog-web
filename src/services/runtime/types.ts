import type {
  AssetDevice,
  ChatExecutionPlan,
  ChatRouteDecision,
  Conversation,
  MCPMarketItem,
  MCPServerRecord,
  MCPTool,
  ReportRecord,
  ServerDefinition,
  ServerCategory,
  ServerToolExecutionMode,
  ServerToolOutputMode,
  ScriptExecutionResult,
  SkillArgsValidationResult,
  Skill,
  SkillPackageRecord,
  WorkflowExecutionResult,
} from '../../types';
import type {
  AiTaskDraftCreateRequest,
  AiTaskDraftGenerateRequest,
  AiTaskDraftGenerateResponse,
  AiTaskDraftValidateRequest,
  AiTaskDraftValidateResponse,
  AssetDeviceUpsertRequest,
  AssetDeviceListResponse,
  AssetDeviceQuery,
  ChatRequest,
  ChatResponse,
  HealthResponse,
  MCPServerCreateRequest,
  MCPServerImportDxtRequest,
  MCPServerImportDxtResponse,
  MCPServerImportJsonRequest,
  MCPServerImportJsonResponse,
  MCPServerUpdateRequest,
  ModelListRequest,
  ReportContentResponse,
  SkillCreateRequest,
  SkillPackagePreviewResponse,
  SkillPackageUpdateRequest,
  SkillUpdateRequest,
  ServerUpdateRequest,
  ServerUploadScriptResponse,
  WorkflowExecuteRequest,
} from '../contracts';

export type RuntimeUnlistenFn = () => void | Promise<void>;

export type SkillExecutionCandidate = {
  name: string;
  triggers: string[];
  workflowId?: string;
  serverId: string;
  toolName?: string;
  resolvedToolName?: string;
  entryScript: string;
  taskKind: 'instant' | 'managed';
  description?: string;
};

export type IntentToolCandidate = {
  serverId: string;
  serverName: string;
  category: ServerCategory;
  serverDescription: string;
  toolName: string;
  toolDescription: string;
  inputSchema?: Record<string, unknown>;
  execution?: ServerToolExecutionMode;
  outputMode?: ServerToolOutputMode;
  usageExamples?: string[];
  legacyIntentHints?: string[];
  defaultArgs?: string[];
};

export type IntentSkillPackageCandidate = {
  id: string;
  name: string;
  kind: SkillPackageRecord['kind'];
  description: string;
  instructionText?: string;
  tools?: Array<{ name: string; description: string }>;
};

export type ScriptUploadKind = 'instant' | 'managed';

export type SkillExecutionOptions = {
  requestText?: string;
  envOverrides?: Record<string, string>;
};

export type ChatPlannerContext = {
  model?: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    maxTokens: number;
    temperature: number;
  };
  conversationMessages?: Array<{ role: string; content: string }>;
};

export interface Runtime {
  mode: 'web';
  getBackendHealth(): Promise<HealthResponse>;
  sendChatMessage(request: ChatRequest): Promise<ChatResponse>;
  fetchAvailableModels(request: ModelListRequest): Promise<string[]>;
  routeChatInput(input: string): Promise<ChatRouteDecision>;
  buildChatExecutionPlan(
    input: string,
    options?: { chatMcpMode?: 'disabled' | 'manual' | 'auto'; selectedManualMcpServer?: string | null } & ChatPlannerContext,
  ): Promise<ChatExecutionPlan>;
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
  executeInstantSkill(skillName: string, args?: string[], options?: SkillExecutionOptions): Promise<ScriptExecutionResult>;
  executeWorkflow(request: WorkflowExecuteRequest): Promise<WorkflowExecutionResult>;
  uploadServerScript(kind: ScriptUploadKind, file: File, description: string, usageExamples?: string[]): Promise<ServerUploadScriptResponse>;
  generateTaskDraft(request: AiTaskDraftGenerateRequest): Promise<AiTaskDraftGenerateResponse>;
  validateTaskDraft(request: AiTaskDraftValidateRequest): Promise<AiTaskDraftValidateResponse>;
  createTaskDraft(request: AiTaskDraftCreateRequest): Promise<ServerUploadScriptResponse>;
  listAssetDevices(query?: AssetDeviceQuery): Promise<AssetDeviceListResponse>;
  createAssetDevice(request: AssetDeviceUpsertRequest): Promise<AssetDevice>;
  updateAssetDevice(deviceId: string, request: Partial<AssetDeviceUpsertRequest>): Promise<AssetDevice>;
  deleteAssetDevice(deviceId: string): Promise<void>;
  listServers(): Promise<ServerDefinition[]>;
  getServer(serverId: string): Promise<ServerDefinition>;
  updateServer(serverId: string, updates: ServerUpdateRequest): Promise<ServerDefinition>;
  deleteServer(serverId: string): Promise<void>;
  startServer(serverId: string, payload?: Record<string, unknown>): Promise<ServerDefinition>;
  stopServer(serverId: string): Promise<ServerDefinition>;
  restartServer(serverId: string, payload?: Record<string, unknown>): Promise<ServerDefinition>;
  callServerTool(serverId: string, toolName: string, argumentsValue: Record<string, unknown>): Promise<{
    content: Array<{ type?: string; text?: string; contentType?: string }>;
    isError?: boolean;
  }>;
  scanSkills(): Promise<Skill[]>;
  previewSkillPackage(file: File): Promise<SkillPackagePreviewResponse>;
  installSkillPackage(importId: string): Promise<SkillPackageRecord>;
  listSkillPackages(): Promise<SkillPackageRecord[]>;
  updateSkillPackage(skillPackageId: string, updates: SkillPackageUpdateRequest): Promise<SkillPackageRecord>;
  deleteSkillPackage(skillPackageId: string): Promise<void>;
  installSkillPackageDependencies(skillPackageId: string): Promise<SkillPackageRecord>;
  createSkill(request: SkillCreateRequest): Promise<Skill>;
  updateSkillMeta(skillName: string, updates: SkillUpdateRequest): Promise<Skill>;
  deleteSkill(skillName: string): Promise<void>;
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
  listMCPServers(): Promise<MCPServerRecord[]>;
  createMCPServer(request: MCPServerCreateRequest): Promise<MCPServerRecord>;
  updateMCPServer(serverName: string, request: MCPServerUpdateRequest): Promise<MCPServerRecord>;
  deleteMCPServer(serverName: string): Promise<void>;
  connectMCPServerByName(serverName: string): Promise<MCPServerRecord>;
  disconnectMCPServerByName(serverName: string): Promise<MCPServerRecord>;
  importMCPServersJson(request: MCPServerImportJsonRequest): Promise<MCPServerImportJsonResponse>;
  importMCPServerDxt(request: MCPServerImportDxtRequest): Promise<MCPServerImportDxtResponse>;
  listMCPMarket(): Promise<MCPMarketItem[]>;
  installMCPMarketItem(itemId: string): Promise<MCPServerRecord>;
  listReports(): Promise<ReportRecord[]>;
  getReportContent(fileName: string): Promise<ReportContentResponse>;
  getReportDownloadUrl(fileName: string): Promise<string>;
  getReportPreviewUrl(fileName: string): Promise<string>;
  deleteReport(fileName: string): Promise<void>;
  clearReports(): Promise<void>;
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
