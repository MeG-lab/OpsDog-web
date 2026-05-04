import { webRuntime } from './webRuntime';
import type { Runtime } from './types';

const activeRuntime: Runtime = webRuntime;

export type { Runtime, RuntimeUnlistenFn } from './types';
export type { ChatRequest, ChatResponse, ModelListRequest } from '../contracts';

export const runtime = activeRuntime;
export const runtimeMode = activeRuntime.mode;
export const isWebRuntime = runtimeMode === 'web';

export const getBackendHealth = (...args: Parameters<Runtime['getBackendHealth']>) =>
  activeRuntime.getBackendHealth(...args);
export const sendChatMessage = (...args: Parameters<Runtime['sendChatMessage']>) =>
  activeRuntime.sendChatMessage(...args);
export const fetchAvailableModels = (...args: Parameters<Runtime['fetchAvailableModels']>) =>
  activeRuntime.fetchAvailableModels(...args);
export const routeChatInput = (...args: Parameters<Runtime['routeChatInput']>) =>
  activeRuntime.routeChatInput(...args);
export const buildChatExecutionPlan = (...args: Parameters<Runtime['buildChatExecutionPlan']>) =>
  activeRuntime.buildChatExecutionPlan(...args);
export const sendChatMessageStream = (...args: Parameters<Runtime['sendChatMessageStream']>) =>
  activeRuntime.sendChatMessageStream(...args);
export const onStreamChunk = (...args: Parameters<Runtime['onStreamChunk']>) =>
  activeRuntime.onStreamChunk(...args);
export const onStreamComplete = (...args: Parameters<Runtime['onStreamComplete']>) =>
  activeRuntime.onStreamComplete(...args);
export const executeInstantSkill = (...args: Parameters<Runtime['executeInstantSkill']>) =>
  activeRuntime.executeInstantSkill(...args);
export const uploadScript = (...args: Parameters<Runtime['uploadScript']>) =>
  activeRuntime.uploadScript(...args);
export const startManagedTask = (...args: Parameters<Runtime['startManagedTask']>) =>
  activeRuntime.startManagedTask(...args);
export const restartManagedTask = (...args: Parameters<Runtime['restartManagedTask']>) =>
  activeRuntime.restartManagedTask(...args);
export const stopManagedTask = (...args: Parameters<Runtime['stopManagedTask']>) =>
  activeRuntime.stopManagedTask(...args);
export const listManagedTasks = (...args: Parameters<Runtime['listManagedTasks']>) =>
  activeRuntime.listManagedTasks(...args);
export const getManagedTask = (...args: Parameters<Runtime['getManagedTask']>) =>
  activeRuntime.getManagedTask(...args);
export const restoreManagedTasks = (...args: Parameters<Runtime['restoreManagedTasks']>) =>
  activeRuntime.restoreManagedTasks(...args);
export const scanSkills = (...args: Parameters<Runtime['scanSkills']>) =>
  activeRuntime.scanSkills(...args);
export const updateSkillMeta = (...args: Parameters<Runtime['updateSkillMeta']>) =>
  activeRuntime.updateSkillMeta(...args);
export const loadSkillInstructions = (...args: Parameters<Runtime['loadSkillInstructions']>) =>
  activeRuntime.loadSkillInstructions(...args);
export const resolveSkillEntryScript = (...args: Parameters<Runtime['resolveSkillEntryScript']>) =>
  activeRuntime.resolveSkillEntryScript(...args);
export const validateSkillArgs = (...args: Parameters<Runtime['validateSkillArgs']>) =>
  activeRuntime.validateSkillArgs(...args);
export const loadConfig = (...args: Parameters<Runtime['loadConfig']>) =>
  activeRuntime.loadConfig(...args);
export const saveConfig = (...args: Parameters<Runtime['saveConfig']>) =>
  activeRuntime.saveConfig(...args);
export const loadConversations = (...args: Parameters<Runtime['loadConversations']>) =>
  activeRuntime.loadConversations(...args);
export const saveConversations = (...args: Parameters<Runtime['saveConversations']>) =>
  activeRuntime.saveConversations(...args);
export const listConversationSummaries = (...args: Parameters<Runtime['listConversationSummaries']>) =>
  activeRuntime.listConversationSummaries(...args);
export const loadConversationMessages = (...args: Parameters<Runtime['loadConversationMessages']>) =>
  activeRuntime.loadConversationMessages(...args);
export const upsertConversationRecord = (...args: Parameters<Runtime['upsertConversationRecord']>) =>
  activeRuntime.upsertConversationRecord(...args);
export const appendConversationMessage = (...args: Parameters<Runtime['appendConversationMessage']>) =>
  activeRuntime.appendConversationMessage(...args);
export const updateConversationMessage = (...args: Parameters<Runtime['updateConversationMessage']>) =>
  activeRuntime.updateConversationMessage(...args);
export const replaceConversationMessages = (...args: Parameters<Runtime['replaceConversationMessages']>) =>
  activeRuntime.replaceConversationMessages(...args);
export const deleteConversationRecord = (...args: Parameters<Runtime['deleteConversationRecord']>) =>
  activeRuntime.deleteConversationRecord(...args);
export const connectMCPServer = (...args: Parameters<Runtime['connectMCPServer']>) =>
  activeRuntime.connectMCPServer(...args);
export const disconnectMCPServer = (...args: Parameters<Runtime['disconnectMCPServer']>) =>
  activeRuntime.disconnectMCPServer(...args);
export const listMCPTools = (...args: Parameters<Runtime['listMCPTools']>) =>
  activeRuntime.listMCPTools(...args);
export const getMCPStatus = (...args: Parameters<Runtime['getMCPStatus']>) =>
  activeRuntime.getMCPStatus(...args);
export const callMCPTool = (...args: Parameters<Runtime['callMCPTool']>) =>
  activeRuntime.callMCPTool(...args);
export const getSystemInfo = (...args: Parameters<Runtime['getSystemInfo']>) =>
  activeRuntime.getSystemInfo(...args);
