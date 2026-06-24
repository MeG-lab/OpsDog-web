import type {
  AssetDevice,
  MCPMarketItem,
  MCPServerRecord,
  MCPTool,
  ReportContextMessage,
  ReportDraft,
  ReportFormatSkillOption,
  ReportRecord,
  ReportSourceScope,
  ServerDefinition,
  SkillPackageRecord,
  WorkflowExecutionArtifact,
} from '../types';

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  provider: string;
  
  apiKey: string;
  baseUrl?: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  toolChoice?: 'auto' | 'none' | {
    type: 'function';
    function: {
      name: string;
    };
  };
  responseFormat?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

export interface ModelListRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ModelListResponse {
  models: string[];
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  now: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponse {
  ok: true;
}

export interface AuthUser {
  id: string;
  username: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string | null;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  user?: AuthUser;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  ok: true;
  user: AuthUser;
}

export interface UserAccount extends AuthUser {
  enabled: boolean;
}

export interface UserListResponse {
  users: UserAccount[];
}

export interface UserCreateRequest {
  username: string;
  password: string;
}

export interface UserUpdateRequest {
  username?: string;
  enabled?: boolean;
}

export interface UserResetPasswordRequest {
  newPassword: string;
}

export interface ApiErrorResponse {
  error: string;
  details?: unknown;
}

export interface MCPConnectRequest {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'streamable-http';
  url?: string;
  headers?: Record<string, string>;
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
  toolEnabledOverrides?: Record<string, boolean>;
  enabled?: boolean;
  autoConnect?: boolean;
  capabilityEnabled?: boolean;
}

export interface MCPConnectResponse {
  tools: MCPTool[];
}

export interface MCPServerListResponse {
  servers: MCPServerRecord[];
}

export interface MCPServerCreateRequest {
  name: string;
  description?: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  autoConnect?: boolean;
  capabilityEnabled?: boolean;
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
  toolEnabledOverrides?: Record<string, boolean>;
}

export interface MCPServerUpdateRequest extends Partial<MCPServerCreateRequest> {}

export interface MCPServerImportJsonRequest {
  content: string;
}

export interface MCPServerImportJsonResponse {
  created: MCPServerRecord[];
  errors: Array<{ name: string; error: string }>;
}

export interface MCPServerImportDxtRequest {
  fileName: string;
  fileContentBase64: string;
}

export interface MCPServerImportDxtResponse {
  created: MCPServerRecord[];
  manifestName?: string;
}

export interface MCPMarketResponse {
  items: MCPMarketItem[];
}

export interface MCPStatusResponse {
  statuses: Array<{
    name: string;
    connected: boolean;
    toolCount: number;
  }>;
}

export interface MCPToolCatalogResponse {
  tools: MCPTool[];
}

export interface MCPServerTestResponse {
  ok: boolean;
  serverName: string;
  toolCount: number;
  tools: MCPTool[];
}

export interface MCPToolCallRequest {
  serverName: string;
  toolName: string;
  argumentsValue: Record<string, unknown>;
}

export interface MCPToolCallResponse {
  content: Array<{ type?: string; text?: string; contentType?: string }>;
  isError?: boolean;
}

export interface ScriptUploadRequest {
  kind: 'instant' | 'managed';
  fileName: string;
  description: string;
  usageExamples?: string[];
  fileContentBase64: string;
}

export interface ServerUploadScriptRequest extends ScriptUploadRequest {}

export interface ServerUploadScriptResponse extends ServerDefinition {}

export type AiTaskRiskLevel = 'read-only' | 'state-change' | 'destructive';

export interface AiGeneratedTask {
  kind: 'instant' | 'managed';
  name: string;
  description: string;
  triggers: string[];
  script: string;
  serverDefinition: Record<string, unknown>;
  validationNotes: string[];
  riskLevel: AiTaskRiskLevel;
}

export interface AiTaskGenerateRequest {
  prompt: string;
  scriptName: string;
  preferredKind?: 'instant' | 'managed' | 'auto';
  model: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    maxTokens: number;
    temperature: number;
  };
}

export interface AiTaskGenerateResponse {
  task: AiGeneratedTask;
}

export interface AiTaskCreateRequest {
  task: AiTaskGenerateResponse['task'];
}

export interface AiTaskValidateRequest {
  task: AiGeneratedTask;
}

export interface AiTaskValidateResponse {
  task: AiGeneratedTask;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ServerListResponse {
  servers: ServerDefinition[];
}

export interface AssetDeviceQuery {
  customerId?: string;
  operatorId?: string;
  assetType?: 1 | 2 | 3 | 4;
  name?: string;
  deviceBrand?: string;
  deviceModel?: string;
  productSn?: string;
  ipAddr?: string;
  manageIpAddr?: string;
  providerName?: string;
  jfName?: string;
  cabinetId?: string;
  useStatus?: 1 | 2;
}

export interface RemoteAssetDeviceRecord {
  id: number;
  customerId?: number;
  customerName?: string;
  assetType?: number;
  name?: string;
  deviceBrand?: string;
  deviceModel?: string;
  productSn?: string;
  ipAddr?: string;
  manageIpAddr?: string;
  providerName?: string;
  manageUser?: string;
  manageUserPhone?: string;
  jfName?: string;
  useStatus?: number;
}

export interface AssetDeviceListResponse {
  code: number;
  msg: string;
  data: Array<RemoteAssetDeviceRecord | AssetDevice>;
  items: AssetDevice[];
}

export interface AssetDeviceUpsertRequest {
  id?: string;
  name: string;
  assetId: string;
  ipAddress: string;
  deviceType: AssetDevice['deviceType'];
  status: AssetDevice['status'];
  location?: string;
  model?: string;
  manufacturer?: string;
  serialNumber?: string;
  organization?: string;
  owner?: string;
  remark?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type RemoteConnectionProtocol = 'ssh' | 'telnet';

export interface ConnectionProfile {
  id: string;
  deviceId: string;
  name: string;
  protocol: RemoteConnectionProtocol;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'none';
  privateKeyPath: string | null;
  strictHostKeyChecking: boolean;
  sftpEnabled: boolean;
  encoding: string;
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
  isDefault: boolean;
  enabled: boolean;
  hasPasswordCredential: boolean;
  hasPassphraseCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionProfileCreateRequest {
  name: string;
  protocol: RemoteConnectionProtocol;
  host: string;
  port: number;
  username?: string;
  authMethod?: 'password' | 'none';
  password?: string;
  plaintextAcknowledged?: boolean;
  sftpEnabled?: boolean;
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface ConnectionProfileUpdateRequest extends Partial<Omit<ConnectionProfileCreateRequest, 'password'>> {
  password?: string;
}

export interface SshHostKeyView {
  code?: 'HOST_KEY_CONFIRMATION_REQUIRED' | 'HOST_KEY_TRUSTED' | 'HOST_KEY_MISMATCH';
  id?: string;
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  trustStatus: 'pending' | 'trusted' | 'mismatch';
  challengeToken?: string;
  previousFingerprintSha256?: string;
  firstSeenAt?: string;
  trustedAt?: string | null;
  lastSeenAt?: string;
  revokedAt?: string | null;
}

export interface SshConnectionTestResult {
  status: 'succeeded';
  authentication: 'password';
  sftpAvailable: boolean;
  hostKey: SshHostKeyView;
}

export type SshConnectionTestResponse = SshHostKeyView | SshConnectionTestResult;

export interface TelnetConnectionTestResult {
  status: 'connected';
  protocol: 'telnet';
  profileId: string;
  host: string;
  port: number;
  authenticated: boolean;
  sftpAvailable: false;
  checkedAt: string;
}

export type RemoteConnectionTestResponse = SshConnectionTestResponse | TelnetConnectionTestResult;

export interface SshTerminalTokenReady {
  status: 'ready';
  token: string;
  expiresAt: string;
  hostKey: SshHostKeyView;
}

export type SshTerminalTokenResponse = SshHostKeyView | SshTerminalTokenReady;

export interface TelnetTerminalTokenReady {
  status: 'ready';
  token: string;
  expiresAt: string;
  protocol: 'telnet';
  plaintext: true;
}

export type RemoteTerminalTokenResponse = SshTerminalTokenResponse | TelnetTerminalTokenReady;

export interface AiRemoteExecuteRequest {
  sessionId: string;
  commands: string[];
}

export interface AiRemoteExecuteResponse {
  status: 'executed';
  sessionId: string;
  commandCount: number;
  writtenBytes: number;
  executedAt: string;
}

export type SshTerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' };

export type SshTerminalServerFrame =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'closed'; reason: string }
  | { type: 'error'; code: string; message: string };

export interface SftpSessionReady {
  status: 'ready';
  session: {
    id: string;
    profileId: string;
    openedAt: string;
  };
}

export type SftpSessionResponse = SshHostKeyView | SftpSessionReady;

export type SftpEntryKind = 'file' | 'directory' | 'other';

export interface SftpDirectoryEntry {
  name: string;
  path: string;
  kind: SftpEntryKind;
  size: number | null;
  modifiedAt: string | null;
  mode: number | null;
}

export interface SftpListResponse {
  path: string;
  entries: SftpDirectoryEntry[];
}

export interface SftpStatResponse {
  path: string;
  entry: SftpDirectoryEntry;
}

export interface SftpUploadRequest {
  remotePath: string;
  file: File;
  confirmOverwrite: boolean;
}

export interface SftpMutationResponse {
  status: 'succeeded';
  path?: string;
  remotePath?: string;
  fromPath?: string;
  toPath?: string;
  transferId?: string;
  displayFileName?: string;
  transferredBytes?: number;
}

export interface ReportListResponse {
  reports: ReportRecord[];
}

export interface ReportContentResponse {
  fileName: string;
  mimeType: string;
  content: string;
  path: string;
}

export interface ReportDraftRequest {
  sourceScope: ReportSourceScope;
  contextMessages: ReportContextMessage[];
  instruction?: string;
  draft?: ReportDraft;
  formatSkillId?: string;
  model: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    maxTokens: number;
    temperature: number;
  };
}

export interface ReportDraftResponse {
  draft?: ReportDraft;
  requiresFormatSelection?: boolean;
  formatSkills?: ReportFormatSkillOption[];
}

export interface ReportExportRequest {
  draft: ReportDraft;
  formats?: Array<'md' | 'pdf'>;
  fileName?: string;
}

export interface ReportExportResponse {
  ok: boolean;
  summary: string;
  outputs: WorkflowExecutionArtifact[];
}

export interface SkillPackagePreviewRequest {
  fileName: string;
  fileContentBase64: string;
}

export interface SkillPackagePreviewResponse extends SkillPackageRecord {
  importId: string;
}

export interface SkillPackageListResponse {
  packages: SkillPackageRecord[];
}

export interface SkillPackageUpdateRequest {
  enabled?: boolean;
  description?: string;
}

export interface WorkflowExecuteRequest {
  workflowId: string;
  requestText: string;
  context?: {
    toolResults?: Array<{
      source: 'mcp';
      serverName: string;
      toolName: string;
      arguments: Record<string, unknown>;
      summary: string;
      rawText: string;
      isError?: boolean;
    }>;
  };
  model?: {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    maxTokens?: number;
    temperature?: number;
  };
}

export interface ServerUpdateRequest {
  name?: string;
  description?: string;
  enabled?: boolean;
  transport?: 'stdio' | 'streamable-http';
  runtime?: string;
  entry?: string;
  connection?: ServerDefinition['connection'];
  capabilities?: Partial<ServerDefinition['capabilities']>;
  script?: string;
}

export interface ServerScriptResponse {
  script: string;
}

export interface ServerDuplicateRequest {
  name?: string;
}

// ── 定时任务（Schedules） ──

export interface ScheduleStep {
  id: string;
  type: 'instant-script' | 'mcp-tool' | 'skill-package' | 'http-request' | 'delay' | 'condition';
  serverId?: string;
  serverName?: string;
  skillPackageId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  onFailure?: 'stop' | 'continue';
  condition?: string;
  onTrue?: ScheduleStep[];
  onFalse?: ScheduleStep[];
  ms?: number;
  url?: string;
  options?: Record<string, unknown>;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  steps: ScheduleStep[];
  errorHandling: {
    retryCount: number;
    retryBackoffMs: number;
    notifyOnFailure: boolean;
  };
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleListResponse {
  schedules: ScheduleRecord[];
}

export interface ScheduleHistoryResponse {
  history: ScheduleExecutionHistory[];
}

export interface ScheduleExecutionHistory {
  scheduleId: string;
  triggeredAt: string;
  status: 'success' | 'failure' | 'timeout';
  elapsedMs: number;
  steps: Array<{
    stepId: string;
    ok: boolean;
    output?: string;
    elapsedMs: number;
    error?: string;
  }>;
}

export interface MCPResourcesResponse {
  resources: import('../types').MCPResource[];
}

export interface MCPResourceReadRequest {
  uri: string;
}

export interface MCPResourceReadResponse {
  contents: import('../types').MCPResourceContent[];
}

export interface MCPPromptsResponse {
  prompts: import('../types').MCPPrompt[];
}

export interface MCPPromptGetRequest {
  name: string;
  arguments?: Record<string, string>;
}
