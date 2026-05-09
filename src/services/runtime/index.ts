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
export const executeWorkflow = (...args: Parameters<Runtime['executeWorkflow']>) =>
  activeRuntime.executeWorkflow(...args);
export const uploadServerScript = (...args: Parameters<Runtime['uploadServerScript']>) =>
  activeRuntime.uploadServerScript(...args);
export const listServers = (...args: Parameters<Runtime['listServers']>) =>
  activeRuntime.listServers(...args);
export const getServer = (...args: Parameters<Runtime['getServer']>) =>
  activeRuntime.getServer(...args);
export const updateServer = (...args: Parameters<Runtime['updateServer']>) =>
  activeRuntime.updateServer(...args);
export const deleteServer = (...args: Parameters<Runtime['deleteServer']>) =>
  activeRuntime.deleteServer(...args);
export const startServer = (...args: Parameters<Runtime['startServer']>) =>
  activeRuntime.startServer(...args);
export const stopServer = (...args: Parameters<Runtime['stopServer']>) =>
  activeRuntime.stopServer(...args);
export const restartServer = (...args: Parameters<Runtime['restartServer']>) =>
  activeRuntime.restartServer(...args);
export const callServerTool = (...args: Parameters<Runtime['callServerTool']>) =>
  activeRuntime.callServerTool(...args);
export const scanSkills = (...args: Parameters<Runtime['scanSkills']>) =>
  activeRuntime.scanSkills(...args);
export const createSkill = (...args: Parameters<Runtime['createSkill']>) =>
  activeRuntime.createSkill(...args);
export const updateSkillMeta = (...args: Parameters<Runtime['updateSkillMeta']>) =>
  activeRuntime.updateSkillMeta(...args);
export const deleteSkill = (...args: Parameters<Runtime['deleteSkill']>) =>
  activeRuntime.deleteSkill(...args);
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
export const listMCPServers = (...args: Parameters<Runtime['listMCPServers']>) =>
  activeRuntime.listMCPServers(...args);
export const createMCPServer = (...args: Parameters<Runtime['createMCPServer']>) =>
  activeRuntime.createMCPServer(...args);
export const updateMCPServer = (...args: Parameters<Runtime['updateMCPServer']>) =>
  activeRuntime.updateMCPServer(...args);
export const deleteMCPServer = (...args: Parameters<Runtime['deleteMCPServer']>) =>
  activeRuntime.deleteMCPServer(...args);
export const connectMCPServerByName = (...args: Parameters<Runtime['connectMCPServerByName']>) =>
  activeRuntime.connectMCPServerByName(...args);
export const disconnectMCPServerByName = (...args: Parameters<Runtime['disconnectMCPServerByName']>) =>
  activeRuntime.disconnectMCPServerByName(...args);
export const importMCPServersJson = (...args: Parameters<Runtime['importMCPServersJson']>) =>
  activeRuntime.importMCPServersJson(...args);
export const importMCPServerDxt = (...args: Parameters<Runtime['importMCPServerDxt']>) =>
  activeRuntime.importMCPServerDxt(...args);
export const listMCPMarket = (...args: Parameters<Runtime['listMCPMarket']>) =>
  activeRuntime.listMCPMarket(...args);
export const installMCPMarketItem = (...args: Parameters<Runtime['installMCPMarketItem']>) =>
  activeRuntime.installMCPMarketItem(...args);
export const listReports = (...args: Parameters<Runtime['listReports']>) =>
  activeRuntime.listReports(...args);
export const getReportContent = (...args: Parameters<Runtime['getReportContent']>) =>
  activeRuntime.getReportContent(...args);
export const getReportDownloadUrl = (...args: Parameters<Runtime['getReportDownloadUrl']>) =>
  activeRuntime.getReportDownloadUrl(...args);
export const getReportPreviewUrl = (...args: Parameters<Runtime['getReportPreviewUrl']>) =>
  activeRuntime.getReportPreviewUrl(...args);
export const deleteReport = (...args: Parameters<Runtime['deleteReport']>) =>
  activeRuntime.deleteReport(...args);
export const clearReports = (...args: Parameters<Runtime['clearReports']>) =>
  activeRuntime.clearReports(...args);
export const listMCPTools = (...args: Parameters<Runtime['listMCPTools']>) =>
  activeRuntime.listMCPTools(...args);
export const getMCPStatus = (...args: Parameters<Runtime['getMCPStatus']>) =>
  activeRuntime.getMCPStatus(...args);
export const callMCPTool = (...args: Parameters<Runtime['callMCPTool']>) =>
  activeRuntime.callMCPTool(...args);
export const getSystemInfo = (...args: Parameters<Runtime['getSystemInfo']>) =>
  activeRuntime.getSystemInfo(...args);
