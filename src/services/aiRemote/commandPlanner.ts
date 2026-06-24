import type { AssetDevice, AiRemoteCommandPlan } from '../../types';
import { sendChatMessage, type ConnectionProfile } from '../runtime';

type AiRemotePlannerModel = {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
};

type BuildAiRemoteCommandPlanOptions = {
  userInput: string;
  device: AssetDevice;
  profile: ConnectionProfile;
  model: AiRemotePlannerModel;
  recentOutput?: string;
  conversationMessages?: Array<{ role: string; content: string }>;
};

type SummarizeAiRemoteCommandResultOptions = {
  userInput: string;
  device: AssetDevice;
  profile: ConnectionProfile;
  model: AiRemotePlannerModel;
  commands: string[];
  terminalOutput: string;
};

const tryParseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const direct = tryParseJson(text.trim());
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  return null;
};

const normalizeCommandList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 20);
};

const normalizeNotes = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
};

const buildPrompt = ({
  userInput,
  device,
  profile,
  recentOutput = '',
}: Omit<BuildAiRemoteCommandPlanOptions, 'model' | 'conversationMessages'>) => [
  '你是 OpsDog 的远程设备操作 AI。',
  '用户已经选择了设备并打开了当前可见终端，本轮给你完全控制当前可见终端的权限。',
  '你只能为这个已打开的终端生成要输入的命令；不要要求、猜测或输出密码、私钥、Token、Cookie 等凭据。',
  '命令会逐条写入终端并自动回车。请把复杂操作拆成短命令，避免交互式等待；需要确认时用非交互参数。',
  '如果用户只是问问题、不需要终端操作，commands 返回空数组，并用 summary 简短回答。',
  '只返回 JSON，不要输出 Markdown，不要解释 JSON 之外的内容。',
  '',
  'JSON 格式：{"summary":"本轮会做什么","commands":["命令1","命令2"],"notes":["可选注意事项"]}',
  '',
  `设备名称：${device.name || '未命名设备'}`,
  `设备 IP：${device.ipAddress || '未知'}`,
  `连接协议：${profile.protocol.toUpperCase()}`,
  `连接目标：${profile.username ? `${profile.username}@` : ''}${profile.host}:${profile.port}`,
  `连接配置：${profile.name}`,
  '',
  `最近终端输出：\n${recentOutput.slice(-4000) || '(暂无)'}`,
  '',
  `用户请求：${userInput}`,
].join('\n');

export const buildAiRemoteCommandPlan = async ({
  userInput,
  device,
  profile,
  model,
  recentOutput,
  conversationMessages = [],
}: BuildAiRemoteCommandPlanOptions): Promise<AiRemoteCommandPlan> => {
  const response = await sendChatMessage({
    messages: [
      ...conversationMessages.slice(-4).map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 1200),
      })),
      {
        role: 'user',
        content: buildPrompt({ userInput, device, profile, recentOutput }),
      },
    ],
    provider: model.provider,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    modelName: model.modelName,
    maxTokens: Math.min(Math.max(model.maxTokens || 1024, 512), 2048),
    temperature: 0,
  });

  const parsed = extractJsonObject(response.content || '');
  if (!parsed) {
    throw new Error('AI 没有返回可执行的 JSON 命令计划。');
  }

  const commands = normalizeCommandList(parsed.commands);
  return {
    summary: String(parsed.summary || (commands.length > 0 ? '准备在远程终端执行命令。' : '没有需要执行的终端命令。')),
    commands,
    notes: normalizeNotes(parsed.notes),
  };
};

export const summarizeAiRemoteCommandResult = async ({
  userInput,
  device,
  profile,
  model,
  commands,
  terminalOutput,
}: SummarizeAiRemoteCommandResultOptions): Promise<string> => {
  const trimmedOutput = terminalOutput.trim();
  if (!trimmedOutput) {
    return '命令已下发，但暂未捕获到可用于汇总的终端输出。';
  }

  const response = await sendChatMessage({
    messages: [{
      role: 'user',
      content: [
        '你是 OpsDog 的远程设备执行结果分析员。',
        '请根据终端输出精准回答用户原问题，不要泛泛总结，不要重复罗列完整命令输出。',
        '如果输出不足以回答，直接说明缺少哪些关键信息。',
        '回答要简洁，优先给结论；必要时用 2-4 个要点补充证据。',
        '',
        `设备名称：${device.name || '未命名设备'}`,
        `设备 IP：${device.ipAddress || '未知'}`,
        `连接协议：${profile.protocol.toUpperCase()}`,
        `连接配置：${profile.name}`,
        '',
        `用户原问题：${userInput}`,
        '',
        `已下发命令：\n${commands.map((command) => `$ ${command}`).join('\n')}`,
        '',
        `终端输出：\n${trimmedOutput.slice(-8000)}`,
      ].join('\n'),
    }],
    provider: model.provider,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    modelName: model.modelName,
    maxTokens: Math.min(Math.max(model.maxTokens || 1024, 512), 2048),
    temperature: 0,
  });

  return String(response.content || '').trim() || '命令已执行，但模型没有返回结果概要。';
};
