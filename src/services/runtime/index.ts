import { webRuntime } from './webRuntime';
import type { Runtime } from './types';

const activeRuntime: Runtime = webRuntime;

export type { Runtime, RuntimeRequestOptions, RuntimeUnlistenFn } from './types';
export type {
  ChatRequest,
  ChatResponse,
  AuthSessionResponse,
  AuthUser,
  AiRemoteExecuteRequest,
  AiRemoteExecuteResponse,
  ConnectionProfile,
  ConnectionProfileCreateRequest,
  ConnectionProfileUpdateRequest,
  LoginRequest,
  LoginResponse,
  ModelListRequest,
  RemoteConnectionTestResponse,
  RemoteTerminalTokenResponse,
  SshConnectionTestResult,
  SshConnectionTestResponse,
  SshHostKeyView,
  SftpDirectoryEntry,
  SftpEntryKind,
  SftpListResponse,
  SftpMutationResponse,
  SftpSessionReady,
  SftpSessionResponse,
  SftpStatResponse,
  SftpUploadRequest,
  SshTerminalClientFrame,
  SshTerminalServerFrame,
  SshTerminalTokenReady,
  SshTerminalTokenResponse,
  TelnetConnectionTestResult,
  UserAccount,
  UserCreateRequest,
  UserResetPasswordRequest,
  UserUpdateRequest,
} from '../contracts';

export const runtime = activeRuntime;
export const runtimeMode = activeRuntime.mode;
export const isWebRuntime = runtimeMode === 'web';

export const getBackendHealth = (...args: Parameters<Runtime['getBackendHealth']>) =>
  activeRuntime.getBackendHealth(...args);
export const getAuthSession = (...args: Parameters<Runtime['getAuthSession']>) =>
  activeRuntime.getAuthSession(...args);
export const login = (...args: Parameters<Runtime['login']>) =>
  activeRuntime.login(...args);
export const logout = (...args: Parameters<Runtime['logout']>) =>
  activeRuntime.logout(...args);
export const changePassword = (...args: Parameters<Runtime['changePassword']>) =>
  activeRuntime.changePassword(...args);
export const listUsers = (...args: Parameters<Runtime['listUsers']>) =>
  activeRuntime.listUsers(...args);
export const createUser = (...args: Parameters<Runtime['createUser']>) =>
  activeRuntime.createUser(...args);
export const updateUser = (...args: Parameters<Runtime['updateUser']>) =>
  activeRuntime.updateUser(...args);
export const resetUserPassword = (...args: Parameters<Runtime['resetUserPassword']>) =>
  activeRuntime.resetUserPassword(...args);
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
export const executeWorkflow = (...args: Parameters<Runtime['executeWorkflow']>) =>
  activeRuntime.executeWorkflow(...args);
export const uploadServerScript = (...args: Parameters<Runtime['uploadServerScript']>) =>
  activeRuntime.uploadServerScript(...args);
export const generateAiTask = (...args: Parameters<Runtime['generateAiTask']>) =>
  activeRuntime.generateAiTask(...args);
export const validateAiTask = (...args: Parameters<Runtime['validateAiTask']>) =>
  activeRuntime.validateAiTask(...args);
export const createAiTask = (...args: Parameters<Runtime['createAiTask']>) =>
  activeRuntime.createAiTask(...args);
export const listAssetDevices = (...args: Parameters<Runtime['listAssetDevices']>) =>
  activeRuntime.listAssetDevices(...args);
export const createAssetDevice = (...args: Parameters<Runtime['createAssetDevice']>) =>
  activeRuntime.createAssetDevice(...args);
export const updateAssetDevice = (...args: Parameters<Runtime['updateAssetDevice']>) =>
  activeRuntime.updateAssetDevice(...args);
export const deleteAssetDevice = (...args: Parameters<Runtime['deleteAssetDevice']>) =>
  activeRuntime.deleteAssetDevice(...args);
export const listConnectionProfiles = (...args: Parameters<Runtime['listConnectionProfiles']>) =>
  activeRuntime.listConnectionProfiles(...args);
export const createConnectionProfile = (...args: Parameters<Runtime['createConnectionProfile']>) =>
  activeRuntime.createConnectionProfile(...args);
export const updateConnectionProfile = (...args: Parameters<Runtime['updateConnectionProfile']>) =>
  activeRuntime.updateConnectionProfile(...args);
export const deleteConnectionProfile = (...args: Parameters<Runtime['deleteConnectionProfile']>) =>
  activeRuntime.deleteConnectionProfile(...args);
export const probeSshHostKey = (...args: Parameters<Runtime['probeSshHostKey']>) =>
  activeRuntime.probeSshHostKey(...args);
export const trustSshHostKey = (...args: Parameters<Runtime['trustSshHostKey']>) =>
  activeRuntime.trustSshHostKey(...args);
export const listSshHostKeys = (...args: Parameters<Runtime['listSshHostKeys']>) =>
  activeRuntime.listSshHostKeys(...args);
export const testSshConnection = (...args: Parameters<Runtime['testSshConnection']>) =>
  activeRuntime.testSshConnection(...args);
export const testRemoteConnection = (...args: Parameters<Runtime['testRemoteConnection']>) =>
  activeRuntime.testRemoteConnection(...args);
export const createSshTerminalToken = (...args: Parameters<Runtime['createSshTerminalToken']>) =>
  activeRuntime.createSshTerminalToken(...args);
export const createSshTerminalSocket = (...args: Parameters<Runtime['createSshTerminalSocket']>) =>
  activeRuntime.createSshTerminalSocket(...args);
export const createRemoteTerminalToken = (...args: Parameters<Runtime['createRemoteTerminalToken']>) =>
  activeRuntime.createRemoteTerminalToken(...args);
export const createRemoteTerminalSocket = (...args: Parameters<Runtime['createRemoteTerminalSocket']>) =>
  activeRuntime.createRemoteTerminalSocket(...args);
export const executeAiRemoteCommands = (...args: Parameters<Runtime['executeAiRemoteCommands']>) =>
  activeRuntime.executeAiRemoteCommands(...args);
export const createSftpSession = (...args: Parameters<Runtime['createSftpSession']>) =>
  activeRuntime.createSftpSession(...args);
export const listSftpEntries = (...args: Parameters<Runtime['listSftpEntries']>) =>
  activeRuntime.listSftpEntries(...args);
export const statSftpEntry = (...args: Parameters<Runtime['statSftpEntry']>) =>
  activeRuntime.statSftpEntry(...args);
export const getSftpDownloadUrl = (...args: Parameters<Runtime['getSftpDownloadUrl']>) =>
  activeRuntime.getSftpDownloadUrl(...args);
export const closeSftpSession = (...args: Parameters<Runtime['closeSftpSession']>) =>
  activeRuntime.closeSftpSession(...args);
export const uploadSftpFile = (...args: Parameters<Runtime['uploadSftpFile']>) =>
  activeRuntime.uploadSftpFile(...args);
export const createSftpDirectory = (...args: Parameters<Runtime['createSftpDirectory']>) =>
  activeRuntime.createSftpDirectory(...args);
export const renameSftpEntry = (...args: Parameters<Runtime['renameSftpEntry']>) =>
  activeRuntime.renameSftpEntry(...args);
export const deleteSftpFile = (...args: Parameters<Runtime['deleteSftpFile']>) =>
  activeRuntime.deleteSftpFile(...args);
export const listServers = (...args: Parameters<Runtime['listServers']>) =>
  activeRuntime.listServers(...args);
export const getServer = (...args: Parameters<Runtime['getServer']>) =>
  activeRuntime.getServer(...args);
export const updateServer = (...args: Parameters<Runtime['updateServer']>) =>
  activeRuntime.updateServer(...args);
export const getServerScript = (...args: Parameters<Runtime['getServerScript']>) =>
  activeRuntime.getServerScript(...args);
export const duplicateServer = (...args: Parameters<Runtime['duplicateServer']>) =>
  activeRuntime.duplicateServer(...args);
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
export const previewSkillPackage = (...args: Parameters<Runtime['previewSkillPackage']>) =>
  activeRuntime.previewSkillPackage(...args);
export const installSkillPackage = (...args: Parameters<Runtime['installSkillPackage']>) =>
  activeRuntime.installSkillPackage(...args);
export const listSkillPackages = (...args: Parameters<Runtime['listSkillPackages']>) =>
  activeRuntime.listSkillPackages(...args);
export const updateSkillPackage = (...args: Parameters<Runtime['updateSkillPackage']>) =>
  activeRuntime.updateSkillPackage(...args);
export const deleteSkillPackage = (...args: Parameters<Runtime['deleteSkillPackage']>) =>
  activeRuntime.deleteSkillPackage(...args);
export const listSchedules = (...args: Parameters<Runtime['listSchedules']>) =>
  activeRuntime.listSchedules(...args);
export const createSchedule = (...args: Parameters<Runtime['createSchedule']>) =>
  activeRuntime.createSchedule(...args);
export const updateSchedule = (...args: Parameters<Runtime['updateSchedule']>) =>
  activeRuntime.updateSchedule(...args);
export const deleteSchedule = (...args: Parameters<Runtime['deleteSchedule']>) =>
  activeRuntime.deleteSchedule(...args);
export const triggerSchedule = (...args: Parameters<Runtime['triggerSchedule']>) =>
  activeRuntime.triggerSchedule(...args);
export const getScheduleHistory = (...args: Parameters<Runtime['getScheduleHistory']>) =>
  activeRuntime.getScheduleHistory(...args);
export const installSkillPackageDependencies = (...args: Parameters<Runtime['installSkillPackageDependencies']>) =>
  activeRuntime.installSkillPackageDependencies(...args);
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
export const createReportDraft = (...args: Parameters<Runtime['createReportDraft']>) =>
  activeRuntime.createReportDraft(...args);
export const exportReportDraft = (...args: Parameters<Runtime['exportReportDraft']>) =>
  activeRuntime.exportReportDraft(...args);
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
export const listMCPToolCatalog = (...args: Parameters<Runtime['listMCPToolCatalog']>) =>
  activeRuntime.listMCPToolCatalog(...args);
export const getMCPStatus = (...args: Parameters<Runtime['getMCPStatus']>) =>
  activeRuntime.getMCPStatus(...args);
export const refreshMCPServerTools = (...args: Parameters<Runtime['refreshMCPServerTools']>) =>
  activeRuntime.refreshMCPServerTools(...args);
export const testMCPServer = (...args: Parameters<Runtime['testMCPServer']>) =>
  activeRuntime.testMCPServer(...args);
export const callMCPTool = (...args: Parameters<Runtime['callMCPTool']>) =>
  activeRuntime.callMCPTool(...args);
export const listMcpResources = (...args: Parameters<Runtime['listMcpResources']>) =>
  activeRuntime.listMcpResources(...args);
export const readMcpResource = (...args: Parameters<Runtime['readMcpResource']>) =>
  activeRuntime.readMcpResource(...args);
export const listMcpPrompts = (...args: Parameters<Runtime['listMcpPrompts']>) =>
  activeRuntime.listMcpPrompts(...args);
export const getMcpPrompt = (...args: Parameters<Runtime['getMcpPrompt']>) =>
  activeRuntime.getMcpPrompt(...args);
export const getSystemInfo = (...args: Parameters<Runtime['getSystemInfo']>) =>
  activeRuntime.getSystemInfo(...args);
