import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AuditEventRecord, AuditOverview, ChatExecutionPlan, ChatRouteDecision, Conversation, ManagedTaskInfo, MCPTool, ScriptExecutionResult, SkillArgsValidationResult, SkillRouteMatch } from '../types';

/**
 * Tauri IPC service layer — wraps all invoke() calls
 * for type-safe communication with the Rust backend.
 */

// ── Chat / LLM Commands ──

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

/** Send a non-streaming chat message */
export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  return invoke('send_chat_message', { request });
}

export async function fetchAvailableModels(request: ModelListRequest): Promise<string[]> {
  return invoke('fetch_available_models', { request });
}

export async function routeChatInput(input: string): Promise<ChatRouteDecision> {
  return invoke('route_chat_input', { input });
}

export async function buildChatExecutionPlan(input: string, allowedSkills: string[]): Promise<ChatExecutionPlan> {
  return invoke('build_chat_execution_plan', { input, allowedSkills });
}

/** Send a streaming chat message — results arrive via events */
export async function sendChatMessageStream(
  request: ChatRequest,
  conversationId: string,
  messageId: string,
): Promise<void> {
  return invoke('send_chat_message_stream', {
    request,
    conversationId,
    messageId,
  });
}

/** Listen for streaming chat chunks */
export function onStreamChunk(
  callback: (payload: { conversationId: string; messageId: string; chunk: string }) => void,
): Promise<UnlistenFn> {
  return listen('chat:stream-chunk', (event) => {
    callback(event.payload as { conversationId: string; messageId: string; chunk: string });
  });
}

/** Listen for stream completion */
export function onStreamComplete(
  callback: (payload: { conversationId: string; messageId: string; success: boolean; error?: string }) => void,
): Promise<UnlistenFn> {
  return listen('chat:stream-complete', (event) => {
    callback(event.payload as { conversationId: string; messageId: string; success: boolean; error?: string });
  });
}

// ── Python Script Commands ──

export async function executePythonScript(
  scriptPath: string,
  args: string[],
  timeoutMs: number = 60000
): Promise<ScriptExecutionResult> {
  return invoke('execute_python_script', {
    scriptPath,
    args,
    timeoutMs,
  });
}

export async function executeInstantSkill(
  skillName: string,
  args: string[] = []
): Promise<ScriptExecutionResult> {
  return invoke('execute_instant_skill', {
    skillName,
    args,
  });
}

export async function checkPythonEnvironment(): Promise<{ available: boolean; version: string; path: string }> {
  return invoke('check_python_env');
}

export async function startManagedTask(taskId: string, scriptPath: string, args: string[] = []): Promise<ManagedTaskInfo> {
  return invoke('start_managed_task', { taskId, scriptPath, args });
}

export async function restartManagedTask(taskId: string, scriptPath: string, args: string[] = []): Promise<ManagedTaskInfo> {
  return invoke('restart_managed_task', { taskId, scriptPath, args });
}

export async function stopManagedTask(taskId: string): Promise<ManagedTaskInfo> {
  return invoke('stop_managed_task', { taskId });
}

export async function listManagedTasks(): Promise<ManagedTaskInfo[]> {
  return invoke('list_managed_tasks');
}

export async function getManagedTask(taskId: string): Promise<ManagedTaskInfo | null> {
  return invoke('get_managed_task', { taskId });
}

export async function restoreManagedTasks(): Promise<ManagedTaskInfo[]> {
  return invoke('restore_managed_tasks');
}

// ── Skills Commands ──

export async function scanSkills(): Promise<Array<{
  name: string;
  version: string;
  description: string;
  triggers: string[];
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  path: string;
}>> {
  return invoke('scan_skills');
}

export async function installSkill(
  skillName: string,
  files: Array<{ relativePath: string; bytes: number[] }>
): Promise<{
  name: string;
  version: string;
  description: string;
  triggers: string[];
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  path: string;
}> {
  return invoke('install_skill', { skillName, files });
}

export async function deleteSkill(skillName: string): Promise<void> {
  return invoke('delete_skill', { skillName });
}

export async function updateSkillMeta(
  skillName: string,
  description: string,
  triggers: string[]
): Promise<{
  name: string;
  version: string;
  description: string;
  triggers: string[];
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  path: string;
}> {
  return invoke('update_skill_meta', { skillName, description, triggers });
}

export async function loadSkillInstructions(skillPath: string): Promise<string> {
  return invoke('load_skill_instructions', { skillPath });
}

export async function resolveSkillEntryScript(skillPath: string, entryScript: string): Promise<string> {
  return invoke('resolve_skill_entry_script', { skillPath, entryScript });
}

export async function validateSkillArgs(skillPath: string, args: string[]): Promise<SkillArgsValidationResult> {
  return invoke('validate_skill_args', { skillPath, args });
}

export async function matchSkillRoutes(input: string, allowedSkills: string[]): Promise<SkillRouteMatch[]> {
  return invoke('match_skill_routes', { input, allowedSkills });
}

export async function resolveInstantSkillExecution(input: string, allowedSkills: string[]): Promise<SkillRouteMatch[]> {
  return invoke('resolve_instant_skill_execution', { input, allowedSkills });
}

// ── Config Commands ──

export async function loadConfig(): Promise<Record<string, unknown>> {
  return invoke('load_config');
}

export async function saveConfig(config: Record<string, unknown>): Promise<void> {
  return invoke('save_config', { config });
}

export async function loadConversations(): Promise<Conversation[]> {
  return invoke('load_conversations');
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  return invoke('save_conversations', { conversations });
}

export async function listConversationSummaries(): Promise<Array<Omit<Conversation, 'messages'>>> {
  return invoke('list_conversation_summaries');
}

export async function loadConversationMessages(conversationId: string): Promise<Conversation['messages']> {
  return invoke('load_conversation_messages', { conversationId });
}

export async function upsertConversationRecord(conversation: Omit<Conversation, 'messages'> & { messages?: Conversation['messages'] }): Promise<void> {
  return invoke('upsert_conversation', { conversation });
}

export async function appendConversationMessage(conversationId: string, message: Conversation['messages'][number]): Promise<void> {
  return invoke('append_conversation_message', { conversationId, message });
}

export async function updateConversationMessage(conversationId: string, messageId: string, updates: Partial<Conversation['messages'][number]>): Promise<void> {
  return invoke('update_conversation_message', { conversationId, messageId, updates });
}

export async function replaceConversationMessages(conversationId: string, messages: Conversation['messages']): Promise<void> {
  return invoke('replace_conversation_messages', { conversationId, messages });
}

export async function deleteConversationRecord(conversationId: string): Promise<void> {
  return invoke('delete_conversation_record', { conversationId });
}

export async function queryAuditEvents(request?: {
  limit?: number;
  eventType?: string;
  search?: string;
}): Promise<AuditEventRecord[]> {
  return invoke('query_audit_events', { request });
}

export async function getAuditOverview(request?: {
  limit?: number;
  eventType?: string;
  search?: string;
}): Promise<AuditOverview> {
  return invoke('get_audit_overview', { request });
}

export async function getAuditReplay(scope: string, limit?: number): Promise<{
  scope: string;
  logPath: string;
  events: AuditEventRecord[];
}> {
  return invoke('get_audit_replay', { scope, limit });
}

// ── MCP Commands ──

export async function connectMCPServer(serverConfig: Record<string, unknown>): Promise<Array<{
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}>> {
  return invoke('connect_mcp_server', { serverConfig });
}

export async function disconnectMCPServer(serverName: string): Promise<void> {
  return invoke('disconnect_mcp_server', { serverName });
}

export async function listMCPTools(): Promise<MCPTool[]> {
  return invoke('list_mcp_tools');
}

export async function getMCPStatus(): Promise<Array<{
  name: string;
  connected: boolean;
  toolCount: number;
}>> {
  return invoke('get_mcp_status');
}

export async function callMCPTool(
  serverName: string,
  toolName: string,
  argumentsValue: Record<string, unknown>
): Promise<{
  content: Array<{ type?: string; text?: string; contentType?: string }>;
  isError?: boolean;
}> {
  return invoke('call_mcp_tool', {
    serverName,
    toolName,
    arguments: argumentsValue,
  });
}

// ── System Commands ──

export async function getSystemInfo(): Promise<{
  os: string;
  arch: string;
  hostname: string;
}> {
  return invoke('get_system_info');
}

export async function getAppDataDir(): Promise<string> {
  return invoke('get_app_data_dir');
}
