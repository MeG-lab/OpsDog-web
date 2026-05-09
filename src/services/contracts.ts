import type { MCPMarketItem, MCPServerRecord, MCPTool, ReportRecord, ServerDefinition } from '../types';

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
  riskLevel?: 'read-only' | 'state-change' | 'destructive';
  toolRiskOverrides?: Record<string, 'read-only' | 'state-change' | 'destructive'>;
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
  triggers: string[];
  fileContentBase64: string;
}

export interface ServerUploadScriptRequest extends ScriptUploadRequest {}

export interface ServerUploadScriptResponse extends ServerDefinition {}

export interface ServerListResponse {
  servers: ServerDefinition[];
}

export interface SkillRecordResponse {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  workflowId?: string;
  serverId: string;
  toolName?: string;
  resolvedToolName?: string;
  executionMode?: 'instant' | 'managed';
  bindingStatus: 'resolved' | 'missing-server' | 'missing-tool' | 'ambiguous-default-tool' | 'invalid-default-tool-config';
  bindingError?: string | null;
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  defaultArgs?: string[];
  path: string;
}

export interface SkillListResponse {
  skills: SkillRecordResponse[];
}

export interface SkillUpdateRequest {
  description?: string;
  triggers?: string[];
  workflowId?: string | null;
  serverId?: string;
  toolName?: string | null;
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

export interface SkillCreateRequest {
  name: string;
  description?: string;
  triggers?: string[];
  workflowId?: string | null;
  serverId: string;
  toolName?: string | null;
}

export interface WorkflowExecuteRequest {
  workflowId: string;
  requestText: string;
  skillName?: string;
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
}
