import type { MCPTool } from '../../types';

type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type ToolNameMap = Map<string, { serverName: string; toolName: string }>;

type ToolResult = {
  content: Array<{ type?: string; text?: string; contentType?: string }>;
  isError?: boolean;
};

type ToolMessage = { role: 'system'; content: string };

type CallToolFn = (
  serverName: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
) => Promise<ToolResult>;

type FilesystemIntent =
  | { kind: 'summarize-file'; target: string; reason: string }
  | { kind: 'read-file'; target: string; reason: string }
  | { kind: 'list-directory'; target: string; reason: string }
  | { kind: 'search-files'; target: string; reason: string };

type DeterministicMcpPlan =
  | { type: 'unhandled' }
  | { type: 'tool-messages'; toolMessages: ToolMessage[]; planner: 'filesystem' }
  | { type: 'failed'; message: string; planner: 'filesystem' };

export type LocalMcpFallbackResult =
  | { type: 'unhandled' }
  | { type: 'tool-messages'; toolMessages: ToolMessage[] }
  | { type: 'failed'; message: string };

const normalizeToolToken = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');

const FILE_OPERATION_INTENT_HINTS = [
  '读取',
  '读',
  '查看',
  '看下',
  '看一下',
  '内容',
  '概括',
  '总结',
  '摘要',
  'summarize',
  'summary',
  'read',
  'show',
  'open',
  'cat',
  '列出',
  '目录',
  '文件夹',
  '查找',
  '搜索',
  'find',
  'search',
];

const GENERIC_FILE_TARGET_HINTS = ['config', '配置', '文档', '文件', '脚本', '目录', 'readme', 'package'];

const formatToolResult = (result: ToolResult) =>
  result.content
    .map((item) => item.text || item.contentType || JSON.stringify(item))
    .filter(Boolean)
    .join('\n');

const buildToolMessage = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): ToolMessage => {
  const raw = formatToolResult(result);
  const status = result.isError ? '失败' : '成功';

  return {
    role: 'system',
    content: [
      `以下是 MCP 工具 ${serverName}/${toolName} 的执行结果。`,
      `执行状态：${status}`,
      `调用参数：${JSON.stringify(args, null, 2)}`,
      raw ? `原始结果：\n${raw}` : '原始结果为空。',
    ].join('\n\n'),
  };
};

const parseSearchPaths = (result: ToolResult): string[] => {
  const raw = formatToolResult(result);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^\[(?:FILE|DIR)\]\s*/i, ''))
    .filter(Boolean)
    .filter((line, index, all) => all.indexOf(line) === index);
};

const extractBacktickedTarget = (input: string): string | null =>
  input.match(/`([^`]+)`/)?.[1]?.trim() || null;

const normalizeExtractedTarget = (value: string | null) => {
  if (!value) return null;
  return value
    .trim()
    .replace(/[“”‘’]/g, '')
    .replace(/([A-Za-z0-9_-])'(?=[A-Za-z0-9_-]+\b)/g, '$1');
};

const extractFileTarget = (input: string): string | null => {
  const fromBackticks = normalizeExtractedTarget(extractBacktickedTarget(input));
  if (fromBackticks) return fromBackticks;

  const normalizedInput = input.replace(/([A-Za-z0-9_-])'(?=[A-Za-z0-9_-]+\b)/g, '$1');
  const fileMatch = normalizedInput.match(/(?:^|[\s(（])([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)(?=$|[\s)）,，。！？])/);
  return normalizeExtractedTarget(fileMatch?.[1] || null);
};

const extractDirectoryTarget = (input: string): string | null => {
  const fromBackticks = normalizeExtractedTarget(extractBacktickedTarget(input));
  if (fromBackticks && !fromBackticks.includes('.')) return fromBackticks;

  const dirWithKeyword =
    input.match(/([A-Za-z0-9_./-]+)\s*(?:目录|文件夹)/)?.[1]?.trim() ||
    input.match(/(?:目录|文件夹)\s*([A-Za-z0-9_./-]+)/)?.[1]?.trim();
  if (dirWithKeyword) return dirWithKeyword;

  const repoDir = input.match(/\b(src|server|skills|scripts|docs|config)(?:\/[A-Za-z0-9_.-]+)*\b/i)?.[0];
  return repoDir?.trim() || null;
};

const inferFilesystemIntent = (input: string): FilesystemIntent | null => {
  const normalized = input.trim().toLowerCase();
  if (!FILE_OPERATION_INTENT_HINTS.some((hint) => normalized.includes(hint))) {
    return null;
  }

  const fileTarget = extractFileTarget(input);
  const directoryTarget = extractDirectoryTarget(input);

  if (/(概括|总结|摘要|summarize|summary)/i.test(input) && fileTarget) {
    return {
      kind: 'summarize-file',
      target: fileTarget,
      reason: `用户请求概括文件 ${fileTarget} 的内容`,
    };
  }

  if (/(读取|读|查看|内容|open|show|read|cat)/i.test(input) && fileTarget) {
    return {
      kind: 'read-file',
      target: fileTarget,
      reason: `用户请求读取文件 ${fileTarget}`,
    };
  }

  if (/(列出|目录|文件夹|主要文件|有哪些)/i.test(input) && directoryTarget) {
    return {
      kind: 'list-directory',
      target: directoryTarget,
      reason: `用户请求查看目录 ${directoryTarget}`,
    };
  }

  if (/(查找|搜索|find|search)/i.test(input) && (fileTarget || directoryTarget)) {
    return {
      kind: 'search-files',
      target: fileTarget || directoryTarget || '',
      reason: `用户请求查找目标 ${fileTarget || directoryTarget || ''}`,
    };
  }

  if (fileTarget) {
    return {
      kind: 'read-file',
      target: fileTarget,
      reason: `用户提到了文件 ${fileTarget}`,
    };
  }

  if (directoryTarget) {
    return {
      kind: 'list-directory',
      target: directoryTarget,
      reason: `用户提到了目录 ${directoryTarget}`,
    };
  }

  return null;
};

export const isFilesystemMcpIntent = (input: string) => Boolean(inferFilesystemIntent(input));

const selectFilesystemServer = (mcpTools: MCPTool[]) => {
  const grouped = new Map<string, Set<string>>();
  for (const tool of mcpTools) {
    if (!grouped.has(tool.serverName)) {
      grouped.set(tool.serverName, new Set());
    }
    grouped.get(tool.serverName)?.add(tool.name);
  }

  for (const [serverName, toolNames] of grouped.entries()) {
    if (toolNames.has('read_text_file') || toolNames.has('read_file')) {
      return {
        serverName,
        toolNames,
      };
    }
  }

  return null;
};

const resolvePathFromSearch = async (
  serverName: string,
  toolNames: Set<string>,
  target: string,
  callTool: CallToolFn,
): Promise<{ ok: true; path: string; toolMessages: ToolMessage[] } | { ok: false; message: string }> => {
  if (!toolNames.has('search_files')) {
    return { ok: false, message: `没有可用的 search_files 工具，无法定位 ${target}。` };
  }

  const pattern = target.includes('/') ? `**/${target.split('/').pop()}` : `**/${target}`;
  const result = await callTool(serverName, 'search_files', {
    path: '.',
    pattern,
  });

  if (result.isError) {
    return { ok: false, message: `搜索文件 ${target} 失败：${formatToolResult(result)}` };
  }

  const matches = parseSearchPaths(result);
  const searchMessage = buildToolMessage(serverName, 'search_files', { path: '.', pattern }, result);

  if (matches.length === 1) {
    return {
      ok: true,
      path: matches[0],
      toolMessages: [searchMessage],
    };
  }

  if (matches.length === 0) {
    return { ok: false, message: `没有找到 ${target}。请确认文件名是否正确。` };
  }

  return {
    ok: false,
    message: `找到了多个可能的目标：${matches.slice(0, 5).join('、')}。请把要操作的路径说得更具体一些。`,
  };
};

const resolveReadablePath = async (
  serverName: string,
  toolNames: Set<string>,
  target: string,
  callTool: CallToolFn,
): Promise<{ ok: true; path: string; toolMessages: ToolMessage[] } | { ok: false; message: string }> => {
  if (toolNames.has('get_file_info')) {
    const infoResult = await callTool(serverName, 'get_file_info', { path: target });
    if (!infoResult.isError) {
      return { ok: true, path: target, toolMessages: [] };
    }
  }

  return resolvePathFromSearch(serverName, toolNames, target, callTool);
};

const listDirectoryDeterministically = async (
  serverName: string,
  toolNames: Set<string>,
  target: string,
  callTool: CallToolFn,
): Promise<{ ok: true; path: string; toolMessages: ToolMessage[] } | { ok: false; message: string }> => {
  if (toolNames.has('get_file_info')) {
    const infoResult = await callTool(serverName, 'get_file_info', { path: target });
    if (!infoResult.isError) {
      return { ok: true, path: target, toolMessages: [] };
    }
  }

  return resolvePathFromSearch(serverName, toolNames, target, callTool);
};

const buildFailureMessage = (input: string, reason: string) =>
  [
    `⚠️ 无法为这条 MCP 请求生成可执行的工具调用。`,
    '',
    `- 请求：${input}`,
    `- 原因：${reason}`,
  ].join('\n');

export const buildMcpToolDefinitions = (mcpTools: MCPTool[]): {
  toolDefinitions: ToolDefinition[];
  toolNameMap: ToolNameMap;
} => {
  const toolNameMap: ToolNameMap = new Map();
  const toolDefinitions = mcpTools.map((tool, index) => {
    const definitionName = `mcp_tool_${index + 1}`;
    toolNameMap.set(definitionName, {
      serverName: tool.serverName,
      toolName: tool.name,
    });

    return {
      type: 'function' as const,
      function: {
        name: definitionName,
        description: [
          `真实工具名：${tool.serverName}/${tool.name}`,
          tool.description || `${tool.serverName} / ${tool.name}`,
          '当你决定调用工具时，请返回真实 tool call，不要用自然语言描述“准备去查看”。',
        ].join(' | '),
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    };
  });

  return { toolDefinitions, toolNameMap };
};

export const resolveToolCallTarget = (
  requestedName: string,
  toolNameMap: ToolNameMap,
) => {
  const direct = toolNameMap.get(requestedName);
  if (direct) return direct;

  const normalizedRequested = normalizeToolToken(requestedName);
  for (const [alias, target] of toolNameMap.entries()) {
    if (normalizeToolToken(alias) === normalizedRequested) {
      return target;
    }
  }

  if (requestedName.includes('/')) {
    const [serverName, ...toolNameParts] = requestedName.split('/');
    const toolName = toolNameParts.join('/').trim();
    if (serverName && toolName) {
      return { serverName: serverName.trim(), toolName };
    }
  }

  for (const entry of toolNameMap.values()) {
    if (normalizeToolToken(entry.toolName) === normalizedRequested) {
      return entry;
    }
    const compound = `${entry.serverName}/${entry.toolName}`;
    if (normalizeToolToken(compound) === normalizedRequested) {
      return entry;
    }
  }

  return null;
};

export const shouldPreferLocalFallbackForToolCalls = ({
  input,
  toolCalls,
  toolNameMap,
}: {
  input: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  toolNameMap: ToolNameMap;
}) => {
  const intent = inferFilesystemIntent(input);
  if (!intent) return false;

  for (const toolCall of toolCalls) {
    const resolved = resolveToolCallTarget(toolCall.name, toolNameMap);
    if (!resolved) return true;

    if (resolved.toolName === 'list_allowed_directories') {
      return true;
    }

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = toolCall.arguments?.trim() ? JSON.parse(toolCall.arguments) : {};
    } catch {
      return true;
    }

    const pathValue = typeof parsedArgs.path === 'string' ? parsedArgs.path.trim() : '';
    const weakPath = !pathValue || pathValue === '.' || pathValue === '/' || pathValue === '/Users';

    if (intent.kind === 'summarize-file' || intent.kind === 'read-file') {
      if (!['read_text_file', 'read_file', 'search_files'].includes(resolved.toolName)) {
        return true;
      }
      if ((resolved.toolName === 'read_text_file' || resolved.toolName === 'read_file') && weakPath) {
        return true;
      }
      if (resolved.toolName === 'search_files' && weakPath) {
        return true;
      }
    }

    if (intent.kind === 'list-directory') {
      if (resolved.toolName !== 'list_directory' && resolved.toolName !== 'search_files') {
        return true;
      }
      if (resolved.toolName === 'list_directory' && weakPath) {
        return true;
      }
    }
  }

  return false;
};

export const containsPseudoToolMarkup = (content: string) =>
  /<invoke\b[^>]*>[\s\S]*?<\/invoke>/i.test(content) ||
  /<parameter\b[^>]*>[\s\S]*?<\/parameter>/i.test(content);

export const shouldUseDeterministicFilesystemPlan = ({
  input,
  mcpTools,
}: {
  input: string;
  mcpTools: MCPTool[];
}) => {
  const intent = inferFilesystemIntent(input);
  if (!intent) return false;
  return Boolean(selectFilesystemServer(mcpTools));
};

export const runLocalMcpFallbackPlan = async ({
  input,
  mcpTools,
  callTool,
}: {
  input: string;
  mcpTools: MCPTool[];
  callTool: CallToolFn;
}): Promise<LocalMcpFallbackResult> => {
  const normalized = input.trim().toLowerCase();
  const intent = inferFilesystemIntent(input);
  if (!intent) {
    const looksLikeFilesystemRequest =
      FILE_OPERATION_INTENT_HINTS.some((hint) => normalized.includes(hint)) ||
      normalized.includes('mcp') ||
      normalized.includes('filesystem');
    const genericTarget = GENERIC_FILE_TARGET_HINTS.find((hint) => normalized.includes(hint));

    if (looksLikeFilesystemRequest && genericTarget) {
      return {
        type: 'failed',
        message: buildFailureMessage(input, `当前目标“${genericTarget}”过于模糊。请直接说明文件名或目录名，例如 tsconfig.json、AGENTS.md 或 src。`),
      };
    }

    return { type: 'unhandled' };
  }

  const filesystem = selectFilesystemServer(mcpTools);
  if (!filesystem) {
    return {
      type: 'failed',
      message: buildFailureMessage(input, '当前没有可用于文件操作的 filesystem MCP 工具。'),
    };
  }

  const { serverName, toolNames } = filesystem;
  const toolMessages: ToolMessage[] = [];

  try {
    if (intent.kind === 'list-directory') {
      if (!toolNames.has('list_directory')) {
        return {
          type: 'failed',
          message: buildFailureMessage(input, '当前 MCP 里没有 list_directory 工具。'),
        };
      }

      const result = await callTool(serverName, 'list_directory', { path: intent.target });
      if (result.isError) {
        return {
          type: 'failed',
          message: buildFailureMessage(input, `读取目录 ${intent.target} 失败：${formatToolResult(result)}`),
        };
      }

      toolMessages.push(buildToolMessage(serverName, 'list_directory', { path: intent.target }, result));
      return { type: 'tool-messages', toolMessages };
    }

    if (intent.kind === 'search-files') {
      const resolved = await resolvePathFromSearch(serverName, toolNames, intent.target, callTool);
      if (!resolved.ok) {
        return {
          type: 'failed',
          message: buildFailureMessage(input, resolved.message),
        };
      }

      return { type: 'tool-messages', toolMessages: resolved.toolMessages };
    }

    if (!toolNames.has('read_text_file') && !toolNames.has('read_file')) {
      return {
        type: 'failed',
        message: buildFailureMessage(input, '当前 MCP 里没有可用的读文件工具。'),
      };
    }

    const resolved = await resolveReadablePath(serverName, toolNames, intent.target, callTool);
    if (!resolved.ok) {
      return {
        type: 'failed',
        message: buildFailureMessage(input, resolved.message),
      };
    }

    toolMessages.push(...resolved.toolMessages);

    const readToolName = toolNames.has('read_text_file') ? 'read_text_file' : 'read_file';
    const readArgs = { path: resolved.path };
    const readResult = await callTool(serverName, readToolName, readArgs);
    if (readResult.isError) {
      return {
        type: 'failed',
        message: buildFailureMessage(input, `读取文件 ${resolved.path} 失败：${formatToolResult(readResult)}`),
      };
    }

    toolMessages.push(buildToolMessage(serverName, readToolName, readArgs, readResult));
    return { type: 'tool-messages', toolMessages };
  } catch (error) {
    return {
      type: 'failed',
      message: buildFailureMessage(input, error instanceof Error ? error.message : String(error)),
    };
  }
};

export const formatMcpToolResult = formatToolResult;

export const runDeterministicMcpPlan = async ({
  input,
  mcpTools,
  callTool,
}: {
  input: string;
  mcpTools: MCPTool[];
  callTool: CallToolFn;
}): Promise<DeterministicMcpPlan> => {
  const intent = inferFilesystemIntent(input);
  if (!intent) {
    return { type: 'unhandled' };
  }

  const filesystem = selectFilesystemServer(mcpTools);
  if (!filesystem) {
    return {
      type: 'failed',
      planner: 'filesystem',
      message: buildFailureMessage(input, '当前没有可用于文件操作的 filesystem MCP 工具。'),
    };
  }

  const { serverName, toolNames } = filesystem;
  if (intent.kind === 'list-directory') {
    const resolved = await listDirectoryDeterministically(serverName, toolNames, intent.target, callTool);
    if (!resolved.ok) {
      return {
        type: 'failed',
        planner: 'filesystem',
        message: buildFailureMessage(input, resolved.message),
      };
    }

    if (!toolNames.has('list_directory')) {
      return {
        type: 'failed',
        planner: 'filesystem',
        message: buildFailureMessage(input, '当前 MCP 里没有 list_directory 工具。'),
      };
    }

    const args = { path: resolved.path };
    const result = await callTool(serverName, 'list_directory', args);
    if (result.isError) {
      return {
        type: 'failed',
        planner: 'filesystem',
        message: buildFailureMessage(input, `读取目录 ${resolved.path} 失败：${formatToolResult(result)}`),
      };
    }

    return {
      type: 'tool-messages',
      planner: 'filesystem',
      toolMessages: [...resolved.toolMessages, buildToolMessage(serverName, 'list_directory', args, result)],
    };
  }

  if (intent.kind === 'search-files') {
    const resolved = await resolvePathFromSearch(serverName, toolNames, intent.target, callTool);
    if (!resolved.ok) {
      return {
        type: 'failed',
        planner: 'filesystem',
        message: buildFailureMessage(input, resolved.message),
      };
    }

    return {
      type: 'tool-messages',
      planner: 'filesystem',
      toolMessages: resolved.toolMessages,
    };
  }

  const resolved = await resolveReadablePath(serverName, toolNames, intent.target, callTool);
  if (!resolved.ok) {
    return {
      type: 'failed',
      planner: 'filesystem',
      message: buildFailureMessage(input, resolved.message),
    };
  }

  const readToolName = toolNames.has('read_text_file') ? 'read_text_file' : toolNames.has('read_file') ? 'read_file' : '';
  if (!readToolName) {
    return {
      type: 'failed',
      planner: 'filesystem',
      message: buildFailureMessage(input, '当前 MCP 里没有可用的读文件工具。'),
    };
  }

  const args = { path: resolved.path };
  const readResult = await callTool(serverName, readToolName, args);
  if (readResult.isError) {
    return {
      type: 'failed',
      planner: 'filesystem',
      message: buildFailureMessage(input, `读取文件 ${resolved.path} 失败：${formatToolResult(readResult)}`),
    };
  }

  return {
    type: 'tool-messages',
    planner: 'filesystem',
    toolMessages: [
      ...resolved.toolMessages,
      buildToolMessage(serverName, readToolName, args, readResult),
    ],
  };
};
