import type { MCPTool, ManagedTaskInfo, ScriptExecutionResult } from '../types';

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

export interface ManagedTaskCommandRequest {
  taskId: string;
  scriptPath: string;
  args?: string[];
}

export interface ManagedTaskListResponse {
  tasks: ManagedTaskInfo[];
}

export interface SkillExecutionRequest {
  skillName: string;
  scriptPath: string;
  args?: string[];
}

export interface SkillExecutionResponse {
  result: ScriptExecutionResult;
}

export interface ScriptUploadRequest {
  kind: 'instant' | 'managed';
  fileName: string;
  description: string;
  fileContentBase64: string;
}

export interface ScriptUploadResponse {
  name: string;
  kind: 'instant' | 'managed';
  description: string;
  scriptPath: string;
  metaPath: string;
  skillDraftAvailable: boolean;
}
