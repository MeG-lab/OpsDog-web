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
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  defaultArgs?: string[];
  enabled: boolean;
  path: string;
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
  mcpServers: MCPServer[];
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
