// ── Message Types ──
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  scriptResult?: ScriptExecutionResult;
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
  matchedSkills: SkillRouteMatch[];
  executableSkills: SkillRouteMatch[];
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

export interface SkillArgsValidationResult {
  valid: boolean;
  normalizedArgs: string[];
  errors: string[];
}

export interface SkillRouteMatch {
  skillName: string;
  score: number;
  matchedTrigger: string;
}

// ── Skill Types ──
export interface Skill {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  serverId: string;
  toolName?: string;
  resolvedToolName?: string;
  executionMode?: 'instant' | 'managed';
  bindingStatus?: 'resolved' | 'missing-server' | 'missing-tool' | 'ambiguous-default-tool' | 'invalid-default-tool-config';
  bindingError?: string | null;
  // Compatibility fields kept for chat-side skill orchestration.
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  defaultArgs?: string[];
  enabled: boolean;
  path: string;
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
export type ServerSchemaSource = 'server-metadata' | 'skill-compat' | 'generated-default';

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
  connected?: boolean;
  connecting?: boolean;
  toolCount?: number;
  statusMessage?: string;
  statusLevel?: 'idle' | 'success' | 'error' | 'info';
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
}

// ── App Config Types ──
export interface AppConfig {
  llmConfigs: LLMConfig[];
  managedTaskConfigs?: Record<string, ManagedTaskConfig>;
  theme: 'light' | 'dark';
  backgroundPreset?: 'white' | 'mist' | 'sage' | 'sand' | 'sky' | 'lavender';
  sidebarCollapsed: boolean;
}

// ── UI State Types ──
export interface UIState {
  activeView: 'chat' | 'settings' | 'skills';
  settingsTab: 'llm' | 'mcp' | 'general';
  isLoading: boolean;
}
