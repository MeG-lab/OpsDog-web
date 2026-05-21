// ── Message Types ──
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  scriptResult?: ScriptExecutionResult;
  executionResult?: ExecutionResult;
  workflowResult?: WorkflowExecutionResult;
  confirmationRequest?: {
    title: string;
    summary: string;
    token: string;
    actionText: string;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

// ── Conversation Types ──
export interface Conversation {
  id: string;
  title: string;
  kind?: 'normal' | 'system';
  systemChannel?: 'announcements';
  lastReadAt?: number;
  messages: Message[];
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

// ── LLM Types ──
export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'aliyun'
  | 'deepseek'
  | 'siliconflow'
  | 'volcengine'
  | 'zhipu'
  | 'moonshot'
  | 'custom';

export interface LLMConfig {
  id: string;
  provider: LLMProvider;
  name: string;
  apiKey: string;
  baseUrl?: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  isDefault?: boolean;
}

// ── Python Script Types ──
export interface ScriptExecutionRequest {
  scriptPath: string;
  args: string[];
  envVars: Record<string, string>;
  workingDir?: string;
  timeoutMs: number;
}

export interface ScriptExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated: boolean;
}

export interface ManagedTaskInfo {
  taskId: string;
  scriptPath: string;
  logPath?: string | null;
  args: string[];
  status: 'starting' | 'running' | 'attention' | 'warning' | 'recovered' | 'stopping' | 'stopped' | 'error';
  pid?: number | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  lastOutputAt?: string | null;
  lastLevel?: string | null;
  exitCode?: number | null;
  recentLogs: string[];
}

export interface ManagedTaskConfig {
  targets?: string;
  host: string;
  port: string;
  interval: string;
  maxFailures: string;
  logFile: string;
}

export interface ChatRouteDecision {
  intent: string;
  blocked: boolean;
  blockReason?: string | null;
  localOnly: boolean;
  allowMcp: boolean;
  maxMcpRiskLevel: 'none' | 'read-only' | 'state-change' | 'destructive';
  explicitToolUse: boolean;
  requiresConfirmation: boolean;
  hasConfirmation: boolean;
  confirmationToken?: string | null;
  confirmationTitle?: string | null;
  confirmationSummary?: string | null;
  confidence: number;
  reasonCodes: string[];
}

export interface ChatExecutionPlan {
  route: ChatRouteDecision;
  candidates: ChatExecutionCandidate[];
  selected: ChatExecutionCandidate;
}

export type ChatMcpMode = 'disabled' | 'manual' | 'auto';

export type ChatExecutionCandidateType = 'workflow' | 'server-tool' | 'skill-package' | 'mcp-tool' | 'mcp.manual' | 'mcp.auto' | 'model';

export interface ChatExecutionCandidate {
  type: ChatExecutionCandidateType;
  score: number;
  reason: string;
  workflowId?: string;
  serverId?: string;
  toolName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  skillPackageId?: string;
  arguments?: Record<string, unknown>;
  missingParameters?: string[];
  riskLevel?: 'none' | 'read-only' | 'state-change' | 'destructive';
  requiresConfirmation?: boolean;
}

export interface AuditEventRecord {
  time: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface AuditEventTypeCount {
  eventType: string;
  count: number;
}

export interface AuditOverview {
  total: number;
  returned: number;
  eventTypes: AuditEventTypeCount[];
}

export type OperationsTeam = '运维服务部' | '渗透测试部';

export type AssetDeviceType = 'server' | 'storage' | 'security' | 'network';
export type AssetDeviceStatus = 'healthy' | 'attention' | 'critical';

export interface AssetDevice {
  id: string;
  name: string;
  assetId: string;
  ipAddress: string;
  deviceType: AssetDeviceType;
  status: AssetDeviceStatus;
  location: string;
  model: string;
  manufacturer: string;
  serialNumber: string;
  organization: string;
  owner: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorProfile {
  name: string;
  team: OperationsTeam;
  organization: string;
  phone: string;
  email: string;
  voiceAlertEnabled: boolean;
  voiceServiceEnabled: boolean;
  voiceAccessKeyId: string;
  voiceAccessKeySecret: string;
  voiceNotifyNumbers: string;
}

export interface SkillPackageTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execution?: ServerToolExecutionMode;
  outputMode?: ServerToolOutputMode;
  entry?: string;
  adapter?: ServerToolAdapterDefinition;
  requiredEnv?: string[];
}

export interface SkillPackageRecord {
  importId?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  builtin?: boolean;
  protected?: boolean;
  kind: 'instruction-only' | 'executable';
  installPath: string;
  manifestSource: 'skill.json' | 'generated' | string;
  tools: SkillPackageTool[];
  permissions: {
    network?: boolean;
    filesystem?: string;
    [key: string]: unknown;
  };
  dependencies: string[];
  dependencyFiles?: string[];
  dependencyStatus: 'none' | 'pending' | 'installing' | 'installed' | 'failed';
  dependencyLog?: string;
  serverIds: string[];
  instructionFiles: string[];
  instructionText?: string;
  requiredEnv?: string[];
  warnings?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export type ServerCategory = 'instant' | 'managed' | 'system';
export type ServerType = 'python-script' | 'mcp-system';
export type ServerStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'attention'
  | 'warning'
  | 'recovered'
  | 'stopping'
  | 'stopped'
  | 'error';

export type PythonServerProtocolMode = 'json-tool' | 'json-stream' | 'cli-adapter';
export type ServerToolOutputMode = 'json-object' | 'json-events' | 'plain-text';
export type ServerToolExecutionMode = 'oneshot' | 'managed';
export type ServerSchemaSource = 'server-metadata' | 'generated-default';

export interface ServerToolAdapterArg {
  source?: string;
  flag?: string;
  position?: number;
  kind?: 'flag' | 'value' | 'positional';
  value?: string | number | boolean;
  repeat?: boolean;
}

export interface ServerToolAdapterDefinition {
  argv?: ServerToolAdapterArg[];
  passthroughArgs?: boolean;
  stdinMode?: 'none' | 'json';
  stdoutMode?: 'json-object' | 'json-events' | 'plain-text';
  stderrMode?: 'text';
}

export interface ServerToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputMode?: ServerToolOutputMode;
  execution?: ServerToolExecutionMode;
  schemaSource?: ServerSchemaSource;
  isDefault?: boolean;
  adapter?: ServerToolAdapterDefinition;
}

export interface ServerConnection {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
}

export interface ServerDefinition {
  id: string;
  name: string;
  category: ServerCategory;
  type: ServerType;
  runtime: string;
  transport: 'stdio' | 'streamable-http';
  entry: string;
  description: string;
  status: ServerStatus;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  connection: ServerConnection;
  capabilities: {
    tools: ServerToolDefinition[];
    inputSchema?: Record<string, unknown>;
    protocol?: {
      mode: PythonServerProtocolMode;
      version: 1;
      io?: {
        stdin?: string;
        stdout?: string;
        stderr?: string;
      };
    };
    schemaSource?: ServerSchemaSource;
    usageExamples?: string[];
    intentHints?: string[];
    adapter?: ServerToolAdapterDefinition;
    timeouts?: {
      toolCallMs?: number;
      startupMs?: number;
      shutdownMs?: number;
    };
    recentLogs: string[];
    [key: string]: unknown;
  };
  runtimeState?: {
    pid?: number | null;
    connected?: boolean;
    toolCount?: number;
    startedAt?: string | null;
    stoppedAt?: string | null;
    lastOutputAt?: string | null;
    lastLevel?: string | null;
    exitCode?: number | null;
  };
}

// ── MCP Types ──
export interface MCPServer {
  name: string;
  command: string;
  args: string[];
  transport?: 'stdio' | 'streamable-http';
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  autoConnect?: boolean;
  capabilityEnabled?: boolean;
  connected?: boolean;
  connecting?: boolean;
  toolCount?: number;
  statusMessage?: string;
  statusLevel?: 'idle' | 'success' | 'error' | 'info';
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
  toolEnabledOverrides?: Record<string, boolean>;
}

export interface MCPServerRecord {
  name: string;
  description: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  autoConnect?: boolean;
  capabilityEnabled?: boolean;
  connectionStatus?: 'connected' | 'disconnected' | 'connecting' | 'error' | string;
  lastConnectedAt?: string | null;
  lastToolRefreshAt?: string | null;
  connected: boolean;
  toolCount: number;
  tools: MCPTool[];
  recentLogs: string[];
  lastError?: string | null;
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
  toolEnabledOverrides?: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface MCPMarketItem {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'streamable-http';
  sourceType: 'json' | 'dxt' | 'template';
  homepage?: string;
  config?: Partial<MCPServerRecord> & {
    dxtFileName?: string;
    dxtBase64?: string;
  };
}

export interface MCPTool {
  id?: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  transport?: 'stdio' | 'streamable-http';
  enabled?: boolean;
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  requiredFields?: string[];
}

export interface ReportRecord {
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  path: string;
}

export interface WorkflowExecutionArtifact {
  type?: 'file';
  format?: string;
  mimeType?: string;
  fileName?: string;
  path?: string;
  downloadUrl?: string;
}

export interface WorkflowExecutionStep {
  id: string;
  title: string;
  status: 'completed' | 'failed' | 'skipped';
  summary?: string;
  serverId?: string;
  toolName?: string;
  findings?: string[];
  data?: Record<string, unknown>;
  error?: string;
}

export type ExecutionResultKind = 'workflow' | 'tool' | 'mcp' | 'model' | 'blocked' | 'error';

export interface ExecutionResult {
  ok: boolean;
  kind: ExecutionResultKind;
  workflowId?: string;
  summary: string;
  steps: WorkflowExecutionStep[];
  artifacts: WorkflowExecutionArtifact[];
  highlights: string[];
  errors: string[];
  textFallback?: string;
}

export interface WorkflowExecutionResult extends ExecutionResult {
  kind: 'workflow';
  workflowId: string;
}

// ── App Config Types ──
export interface AppConfig {
  llmConfigs: LLMConfig[];
  managedTaskConfigs?: Record<string, ManagedTaskConfig>;
  theme: 'light' | 'dark';
  backgroundPreset?: 'white' | 'mist' | 'sage' | 'sand' | 'sky' | 'lavender';
  sidebarCollapsed: boolean;
}
