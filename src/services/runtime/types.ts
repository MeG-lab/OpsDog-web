import type {
  AssetDevice,
  ChatExecutionPlan,
  ChatRouteDecision,
  Conversation,
  MCPMarketItem,
  MCPPrompt,
  MCPPromptGetResponse,
  MCPResource,
  MCPResourceContent,
  MCPServerRecord,
  MCPTool,
  ReportRecord,
  ServerDefinition,
  ServerCategory,
  ServerToolExecutionMode,
  ServerToolOutputMode,
  SkillPackageRecord,
  WorkflowExecutionResult,
} from '../../types';
import type {
  AiTaskCreateRequest,
  AiTaskGenerateRequest,
  AiTaskGenerateResponse,
  AiTaskValidateRequest,
  AiTaskValidateResponse,
  AuthSessionResponse,
  AssetDeviceUpsertRequest,
  AssetDeviceListResponse,
  AssetDeviceQuery,
  AiRemoteExecuteRequest,
  AiRemoteExecuteResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ChatRequest,
  ChatResponse,
  ConnectionProfile,
  ConnectionProfileCreateRequest,
  ConnectionProfileUpdateRequest,
  HealthResponse,
  LoginRequest,
  LoginResponse,
  MCPServerCreateRequest,
  MCPServerImportDxtRequest,
  MCPServerImportDxtResponse,
  MCPServerImportJsonRequest,
  MCPServerImportJsonResponse,
  MCPServerTestResponse,
  MCPServerUpdateRequest,
  MCPToolCatalogResponse,
  ModelListRequest,
  ReportContentResponse,
  RemoteConnectionTestResponse,
  RemoteTerminalTokenResponse,
  ReportDraftRequest,
  ReportDraftResponse,
  ReportExportRequest,
  ReportExportResponse,
  SkillPackagePreviewResponse,
  SkillPackageUpdateRequest,
  ServerUpdateRequest,
  ServerScriptResponse,
  ServerDuplicateRequest,
  ServerUploadScriptResponse,
  SftpListResponse,
  SftpMutationResponse,
  SftpSessionResponse,
  SftpStatResponse,
  SftpUploadRequest,
  SshConnectionTestResponse,
  SshHostKeyView,
  SshTerminalTokenResponse,
  UserAccount,
  UserCreateRequest,
  UserResetPasswordRequest,
  UserUpdateRequest,
  WorkflowExecuteRequest,
} from '../contracts';

export type RuntimeUnlistenFn = () => void | Promise<void>;
export type RuntimeRequestOptions = {
  signal?: AbortSignal;
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
  intentHints?: string[];
  skillPackageId?: string;
  skillPackageKind?: SkillPackageRecord['kind'];
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
  getAuthSession(): Promise<AuthSessionResponse>;
  login(request: LoginRequest): Promise<LoginResponse>;
  logout(): Promise<{ ok: true }>;
  changePassword(request: ChangePasswordRequest): Promise<ChangePasswordResponse>;
  listUsers(): Promise<UserAccount[]>;
  createUser(request: UserCreateRequest): Promise<UserAccount>;
  updateUser(userId: string, request: UserUpdateRequest): Promise<UserAccount>;
  resetUserPassword(userId: string, request: UserResetPasswordRequest): Promise<ChangePasswordResponse>;
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
  executeWorkflow(request: WorkflowExecuteRequest): Promise<WorkflowExecutionResult>;
  uploadServerScript(kind: ScriptUploadKind, file: File, description: string, usageExamples?: string[]): Promise<ServerUploadScriptResponse>;
  generateAiTask(request: AiTaskGenerateRequest, options?: RuntimeRequestOptions): Promise<AiTaskGenerateResponse>;
  validateAiTask(request: AiTaskValidateRequest): Promise<AiTaskValidateResponse>;
  createAiTask(request: AiTaskCreateRequest): Promise<ServerUploadScriptResponse>;
  listAssetDevices(query?: AssetDeviceQuery): Promise<AssetDeviceListResponse>;
  createAssetDevice(request: AssetDeviceUpsertRequest): Promise<AssetDevice>;
  updateAssetDevice(deviceId: string, request: Partial<AssetDeviceUpsertRequest>): Promise<AssetDevice>;
  deleteAssetDevice(deviceId: string): Promise<void>;
  listConnectionProfiles(deviceId: string): Promise<ConnectionProfile[]>;
  createConnectionProfile(deviceId: string, request: ConnectionProfileCreateRequest): Promise<ConnectionProfile>;
  updateConnectionProfile(profileId: string, request: ConnectionProfileUpdateRequest): Promise<ConnectionProfile>;
  deleteConnectionProfile(profileId: string): Promise<void>;
  probeSshHostKey(profileId: string): Promise<SshHostKeyView>;
  trustSshHostKey(profileId: string, challengeToken: string): Promise<SshHostKeyView>;
  listSshHostKeys(profileId: string): Promise<SshHostKeyView[]>;
  testSshConnection(profileId: string): Promise<SshConnectionTestResponse>;
  testRemoteConnection(profileId: string): Promise<RemoteConnectionTestResponse>;
  createSshTerminalToken(profileId: string, dimensions: { cols: number; rows: number }): Promise<SshTerminalTokenResponse>;
  createSshTerminalSocket(token: string): WebSocket;
  createRemoteTerminalToken(profileId: string, dimensions: { cols: number; rows: number }): Promise<RemoteTerminalTokenResponse>;
  createRemoteTerminalSocket(token: string): WebSocket;
  executeAiRemoteCommands(request: AiRemoteExecuteRequest): Promise<AiRemoteExecuteResponse>;
  createSftpSession(profileId: string): Promise<SftpSessionResponse>;
  listSftpEntries(sessionId: string, path: string): Promise<SftpListResponse>;
  statSftpEntry(sessionId: string, path: string): Promise<SftpStatResponse>;
  getSftpDownloadUrl(sessionId: string, path: string): string;
  closeSftpSession(sessionId: string): Promise<void>;
  uploadSftpFile(sessionId: string, request: SftpUploadRequest): Promise<SftpMutationResponse>;
  createSftpDirectory(sessionId: string, path: string): Promise<SftpMutationResponse>;
  renameSftpEntry(sessionId: string, fromPath: string, toPath: string): Promise<SftpMutationResponse>;
  deleteSftpFile(sessionId: string, path: string): Promise<SftpMutationResponse>;
  listServers(): Promise<ServerDefinition[]>;
  getServer(serverId: string): Promise<ServerDefinition>;
  updateServer(serverId: string, updates: ServerUpdateRequest): Promise<ServerDefinition>;
  getServerScript(serverId: string): Promise<ServerScriptResponse>;
  duplicateServer(serverId: string, request?: ServerDuplicateRequest): Promise<ServerDefinition>;
  deleteServer(serverId: string): Promise<void>;
  startServer(serverId: string, payload?: Record<string, unknown>): Promise<ServerDefinition>;
  stopServer(serverId: string): Promise<ServerDefinition>;
  restartServer(serverId: string, payload?: Record<string, unknown>): Promise<ServerDefinition>;
  callServerTool(serverId: string, toolName: string, argumentsValue: Record<string, unknown>): Promise<{
    content: Array<{ type?: string; text?: string; contentType?: string }>;
    isError?: boolean;
  }>;
  previewSkillPackage(file: File): Promise<SkillPackagePreviewResponse>;
  installSkillPackage(importId: string): Promise<SkillPackageRecord>;
  listSkillPackages(): Promise<SkillPackageRecord[]>;
  updateSkillPackage(skillPackageId: string, updates: SkillPackageUpdateRequest): Promise<SkillPackageRecord>;
  deleteSkillPackage(skillPackageId: string): Promise<void>;
  listSchedules(): Promise<import('../contracts').ScheduleRecord[]>;
  createSchedule(data: Omit<import('../contracts').ScheduleRecord, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'nextRunAt'>): Promise<import('../contracts').ScheduleRecord>;
  updateSchedule(id: string, data: Partial<import('../contracts').ScheduleRecord>): Promise<import('../contracts').ScheduleRecord>;
  deleteSchedule(id: string): Promise<{ ok: boolean }>;
  triggerSchedule(id: string): Promise<import('../contracts').ScheduleExecutionHistory>;
  getScheduleHistory(id: string): Promise<import('../contracts').ScheduleExecutionHistory[]>;
  installSkillPackageDependencies(skillPackageId: string): Promise<SkillPackageRecord>;
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
  createReportDraft(request: ReportDraftRequest): Promise<ReportDraftResponse>;
  exportReportDraft(request: ReportExportRequest): Promise<ReportExportResponse>;
  getReportContent(fileName: string): Promise<ReportContentResponse>;
  getReportDownloadUrl(fileName: string): Promise<string>;
  getReportPreviewUrl(fileName: string): Promise<string>;
  deleteReport(fileName: string): Promise<void>;
  clearReports(): Promise<void>;
  listMCPTools(): Promise<MCPTool[]>;
  listMCPToolCatalog(): Promise<MCPToolCatalogResponse>;
  getMCPStatus(): Promise<Array<{
    name: string;
    connected: boolean;
    toolCount: number;
  }>>;
  refreshMCPServerTools(serverName: string): Promise<MCPServerRecord>;
  testMCPServer(serverName: string): Promise<MCPServerTestResponse>;
  callMCPTool(
    serverName: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type?: string; text?: string; contentType?: string }>;
    isError?: boolean;
  }>;
  listMcpResources(serverName: string): Promise<MCPResource[]>;
  readMcpResource(serverName: string, uri: string): Promise<{ contents: MCPResourceContent[] }>;
  listMcpPrompts(serverName: string): Promise<MCPPrompt[]>;
  getMcpPrompt(serverName: string, name: string, args?: Record<string, string>): Promise<MCPPromptGetResponse>;
  getSystemInfo(): Promise<{
    os: string;
    arch: string;
    hostname: string;
  }>;
}
