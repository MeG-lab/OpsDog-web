import type { ServerDefinition, Skill } from '../types';

const normalizeLookup = (value: string | null | undefined) =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.py$/i, '')
    .toLowerCase();

const entryBaseName = (entry: string | null | undefined) => {
  const normalized = normalizeLookup(entry);
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
};

export const mapSkillRecord = (input: any, enabled = true): Skill => ({
  name: input.name,
  version: input.version,
  description: input.description,
  triggers: input.triggers || [],
  serverId: input.serverId || input.server_id || '',
  toolName: input.toolName || input.tool_name || undefined,
  resolvedToolName: input.resolvedToolName || undefined,
  executionMode: input.executionMode || input.execution_mode || input.taskKind || input.task_kind || 'instant',
  bindingStatus: input.bindingStatus || 'missing-server',
  bindingError: input.bindingError || null,
  taskKind: input.taskKind || input.task_kind || input.executionMode || input.execution_mode || 'instant',
  entryScript: input.entryScript || input.entry_script || '',
  timeoutSeconds: input.timeoutSeconds || input.timeout_seconds || 60,
  dependencies: input.dependencies || [],
  defaultArgs: input.defaultArgs || input.default_args || [],
  enabled: input.enabled ?? enabled,
  path: input.path,
});

export const findServerForSkill = (skill: Pick<Skill, 'serverId' | 'entryScript' | 'name'>, servers: ServerDefinition[]) => {
  const candidates = new Set([
    normalizeLookup(skill.serverId),
    normalizeLookup(skill.name),
    normalizeLookup(skill.entryScript),
    entryBaseName(skill.entryScript),
  ].filter(Boolean));

  return servers.find((server) => {
    const serverCandidates = [
      normalizeLookup(server.id),
      normalizeLookup(server.name),
      normalizeLookup(server.entry),
      entryBaseName(server.entry),
    ];
    return serverCandidates.some((candidate) => candidate && candidates.has(candidate));
  }) || null;
};

export const resolveDefaultToolName = (server: ServerDefinition | null | undefined) => {
  const tools = Array.isArray(server?.capabilities?.tools) ? server.capabilities.tools : [];
  if (tools.length === 0) {
    return {
      bindingStatus: 'missing-tool' as const,
      bindingError: `Server ${server?.id || '<unknown>'} 没有任何可调用工具。`,
      resolvedToolName: undefined,
    };
  }

  const explicitDefaults = tools.filter((tool) => tool?.isDefault === true);
  if (explicitDefaults.length > 1) {
    return {
      bindingStatus: 'invalid-default-tool-config' as const,
      bindingError: `Server ${server?.id || '<unknown>'} 存在多个默认工具，请显式指定 toolName。`,
      resolvedToolName: undefined,
    };
  }
  if (explicitDefaults.length === 1) {
    return {
      bindingStatus: 'resolved' as const,
      bindingError: null,
      resolvedToolName: explicitDefaults[0].name,
    };
  }
  if (tools.length === 1) {
    return {
      bindingStatus: 'resolved' as const,
      bindingError: null,
      resolvedToolName: tools[0].name,
    };
  }
  return {
    bindingStatus: 'ambiguous-default-tool' as const,
    bindingError: `Server ${server?.id || '<unknown>'} 有多个工具且没有唯一默认工具，请显式指定 toolName。`,
    resolvedToolName: undefined,
  };
};

export const resolveSkillBinding = (skill: Skill, servers: ServerDefinition[]): Skill => {
  const server = findServerForSkill(skill, servers);
  if (!server) {
    return {
      ...skill,
      bindingStatus: 'missing-server',
      bindingError: `Server 未找到：${skill.serverId || '<empty>'}`,
      resolvedToolName: undefined,
      executionMode: skill.executionMode || skill.taskKind || 'instant',
      taskKind: skill.executionMode || skill.taskKind || 'instant',
    };
  }

  const nextMode = skill.executionMode || (server.category === 'managed' ? 'managed' : 'instant');
  if (skill.toolName) {
    const tool = (server.capabilities?.tools || []).find((item) => item.name === skill.toolName);
    if (!tool) {
      return {
        ...skill,
        bindingStatus: 'missing-tool',
        bindingError: `工具未找到：${skill.toolName}`,
        resolvedToolName: undefined,
        executionMode: nextMode,
        taskKind: nextMode,
      };
    }
    return {
      ...skill,
      bindingStatus: 'resolved',
      bindingError: null,
      resolvedToolName: tool.name,
      executionMode: nextMode,
      taskKind: nextMode,
    };
  }

  const resolved = resolveDefaultToolName(server);
  return {
    ...skill,
    bindingStatus: resolved.bindingStatus,
    bindingError: resolved.bindingError,
    resolvedToolName: resolved.resolvedToolName,
    executionMode: nextMode,
    taskKind: nextMode,
  };
};

export const findPreferredSkillForServer = (
  serverId: string,
  skills: Skill[],
  servers: ServerDefinition[] = [],
) => {
  const normalizedServerId = normalizeLookup(serverId);
  const resolvedMatches = skills
    .filter((skill) => {
      if (skill.bindingStatus !== 'resolved') return false;
      if (normalizeLookup(skill.serverId) === normalizedServerId) return true;
      if (normalizeLookup(skill.name) === normalizedServerId) return true;
      if (servers.length > 0) {
        const server = findServerForSkill(skill, servers);
        return Boolean(server && normalizeLookup(server.id) === normalizedServerId);
      }
      return false;
    })
    .sort((left, right) => {
      const leftExact = normalizeLookup(left.name) === normalizedServerId ? 1 : 0;
      const rightExact = normalizeLookup(right.name) === normalizedServerId ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
      return left.name.localeCompare(right.name);
    });

  return resolvedMatches[0] || null;
};
