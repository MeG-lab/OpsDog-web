import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listServerDefinitions } from './serverRegistry.js';

const APP_ROOT = process.cwd();
const SKILLS_DIR = path.join(APP_ROOT, 'tools', 'skills');

const stripQuotes = (value) => String(value || '').trim().replace(/^['"]|['"]$/g, '');
const quoteScalar = (value) => `"${String(value ?? '').replace(/"/g, '\\"')}"`;
const normalizeName = (value) => String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');

const parseScalar = (value) => stripQuotes(value);

const parseStringList = (lines, startIndex) => {
  const values = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith('  - ')) break;
    values.push(parseScalar(line.slice(4)));
    index += 1;
  }
  return { values, nextIndex: index };
};

const parseArgsSchema = (lines, startIndex) => {
  const schemaItems = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith('  - ')) break;

    const item = {
      flag: '',
      type: 'string',
      required: false,
    };

    const firstField = line.slice(4);
    const [firstKeyRaw, ...firstValueParts] = firstField.split(':');
    const firstKey = firstKeyRaw?.trim();
    const firstValue = firstValueParts.join(':').trim();
    if (firstKey) {
      if (firstKey === 'flag') item.flag = parseScalar(firstValue);
      if (firstKey === 'type') item.type = parseScalar(firstValue) || 'string';
      if (firstKey === 'required') item.required = parseScalar(firstValue) === 'true';
      if (firstKey === 'multiple') item.multiple = parseScalar(firstValue) === 'true';
      if (firstKey === 'min') item.min = Number.parseInt(parseScalar(firstValue), 10);
      if (firstKey === 'max') item.max = Number.parseInt(parseScalar(firstValue), 10);
      if (firstKey === 'pattern') item.pattern = parseScalar(firstValue);
    }

    index += 1;
    while (index < lines.length && lines[index].startsWith('    ')) {
      const nested = lines[index].trim();
      const [nestedKeyRaw, ...nestedValueParts] = nested.split(':');
      const nestedKey = nestedKeyRaw?.trim();
      const nestedValue = nestedValueParts.join(':').trim();
      if (nestedKey === 'flag') item.flag = parseScalar(nestedValue);
      if (nestedKey === 'type') item.type = parseScalar(nestedValue) || 'string';
      if (nestedKey === 'required') item.required = parseScalar(nestedValue) === 'true';
      if (nestedKey === 'multiple') item.multiple = parseScalar(nestedValue) === 'true';
      if (nestedKey === 'min') item.min = Number.parseInt(parseScalar(nestedValue), 10);
      if (nestedKey === 'max') item.max = Number.parseInt(parseScalar(nestedValue), 10);
      if (nestedKey === 'pattern') item.pattern = parseScalar(nestedValue);
      index += 1;
    }

    if (item.flag) schemaItems.push(item);
  }
  return { values: schemaItems, nextIndex: index };
};

const parseSkillYaml = (content, skillPath) => {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'));

  const result = {
    name: '',
    version: '1.0.0',
    description: '',
    triggers: [],
    workflowId: '',
    serverId: '',
    toolName: '',
    executionMode: '',
    taskKind: 'instant',
    entryScript: '',
    timeoutSeconds: 60,
    dependencies: [],
    defaultArgs: [],
    argsSchema: [],
    path: skillPath,
  };

  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('name:')) {
      result.name = parseScalar(trimmed.slice('name:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('version:')) {
      result.version = parseScalar(trimmed.slice('version:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('description:')) {
      result.description = parseScalar(trimmed.slice('description:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('workflow_id:')) {
      result.workflowId = parseScalar(trimmed.slice('workflow_id:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('server_id:')) {
      result.serverId = parseScalar(trimmed.slice('server_id:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('tool_name:')) {
      result.toolName = parseScalar(trimmed.slice('tool_name:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('execution_mode:')) {
      result.executionMode = parseScalar(trimmed.slice('execution_mode:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('task_kind:')) {
      result.taskKind = parseScalar(trimmed.slice('task_kind:'.length)) || 'instant';
      index += 1;
      continue;
    }
    if (trimmed.startsWith('entry_script:')) {
      result.entryScript = parseScalar(trimmed.slice('entry_script:'.length));
      index += 1;
      continue;
    }
    if (trimmed.startsWith('timeout_seconds:')) {
      result.timeoutSeconds = Number.parseInt(parseScalar(trimmed.slice('timeout_seconds:'.length)), 10) || 0;
      index += 1;
      continue;
    }
    if (trimmed === 'triggers:') {
      const { values, nextIndex } = parseStringList(lines, index + 1);
      result.triggers = values;
      index = nextIndex;
      continue;
    }
    if (trimmed === 'dependencies:') {
      if (lines[index + 1]?.trim() === '[]') {
        result.dependencies = [];
        index += 2;
      } else {
        const { values, nextIndex } = parseStringList(lines, index + 1);
        result.dependencies = values;
        index = nextIndex;
      }
      continue;
    }
    if (trimmed === 'default_args:') {
      const { values, nextIndex } = parseStringList(lines, index + 1);
      result.defaultArgs = values;
      index = nextIndex;
      continue;
    }
    if (trimmed === 'args_schema:') {
      const { values, nextIndex } = parseArgsSchema(lines, index + 1);
      result.argsSchema = values;
      index = nextIndex;
      continue;
    }
    index += 1;
  }

  return result;
};

const stringifyArgsSchemaItem = (item) => {
  const lines = [
    `  - flag: ${quoteScalar(item.flag)}`,
    `    type: ${item.type === 'integer' ? 'integer' : 'string'}`,
    `    required: ${item.required ? 'true' : 'false'}`,
  ];
  if (item.multiple) lines.push('    multiple: true');
  if (typeof item.min === 'number') lines.push(`    min: ${item.min}`);
  if (typeof item.max === 'number') lines.push(`    max: ${item.max}`);
  if (item.pattern) lines.push(`    pattern: ${quoteScalar(item.pattern)}`);
  return lines;
};

const stringifySkillYaml = (skill) => {
  const lines = [
    `name: ${skill.name}`,
    `version: ${skill.version || '1.0.0'}`,
    `description: ${quoteScalar(skill.description || '')}`,
    'triggers:',
    ...(skill.triggers || []).map((trigger) => `  - ${quoteScalar(trigger)}`),
  ];

  if (skill.workflowId) {
    lines.push(`workflow_id: ${skill.workflowId}`);
  }
  if (skill.serverId) {
    lines.push(`server_id: ${skill.serverId}`);
  }

  if (skill.toolName) {
    lines.push(`tool_name: ${skill.toolName}`);
  }
  if (skill.executionMode) {
    lines.push(`execution_mode: ${skill.executionMode}`);
  }
  lines.push(
    `task_kind: ${skill.taskKind || 'instant'}`,
    `entry_script: ${skill.entryScript || ''}`,
    `timeout_seconds: ${skill.timeoutSeconds || 0}`,
  );

  if (Array.isArray(skill.dependencies) && skill.dependencies.length > 0) {
    lines.push('dependencies:');
    lines.push(...skill.dependencies.map((dependency) => `  - ${quoteScalar(dependency)}`));
  } else {
    lines.push('dependencies: []');
  }

  if (Array.isArray(skill.defaultArgs) && skill.defaultArgs.length > 0) {
    lines.push('default_args:');
    lines.push(...skill.defaultArgs.map((item) => `  - ${quoteScalar(item)}`));
  }

  if (Array.isArray(skill.argsSchema) && skill.argsSchema.length > 0) {
    lines.push('args_schema:');
    for (const item of skill.argsSchema) {
      lines.push(...stringifyArgsSchemaItem(item));
    }
  }

  return `${lines.join('\n')}\n`;
};

const resolveDefaultTool = (server) => {
  const tools = Array.isArray(server?.capabilities?.tools) ? server.capabilities.tools : [];
  if (tools.length === 0) {
    return {
      bindingStatus: 'missing-tool',
      bindingError: `Server ${server?.id || '<unknown>'} 没有任何可调用工具。`,
    };
  }

  const explicitDefaults = tools.filter((tool) => tool?.isDefault === true);
  if (explicitDefaults.length > 1) {
    return {
      bindingStatus: 'invalid-default-tool-config',
      bindingError: `Server ${server.id} 存在多个默认工具，请显式指定 tool_name。`,
    };
  }
  if (explicitDefaults.length === 1) {
    return {
      bindingStatus: 'resolved',
      resolvedToolName: explicitDefaults[0].name,
      bindingError: null,
    };
  }
  if (tools.length === 1) {
    return {
      bindingStatus: 'resolved',
      resolvedToolName: tools[0].name,
      bindingError: null,
    };
  }
  return {
    bindingStatus: 'ambiguous-default-tool',
    bindingError: `Server ${server.id} 有多个工具且没有唯一默认工具，请显式指定 tool_name。`,
  };
};

const resolveSkillBinding = (skill, servers) => {
  const server = servers.find((item) => item.id === skill.serverId || item.name === skill.serverId);
  if (!server) {
    return {
      bindingStatus: 'missing-server',
      bindingError: `Server 未找到：${skill.serverId || '<empty>'}`,
      resolvedToolName: '',
      executionMode: skill.executionMode || skill.taskKind || 'instant',
    };
  }

  if (skill.toolName) {
    const tool = (server.capabilities?.tools || []).find((item) => item.name === skill.toolName);
    if (!tool) {
      return {
        bindingStatus: 'missing-tool',
        bindingError: `工具未找到：${skill.toolName}`,
        resolvedToolName: '',
        executionMode: skill.executionMode || (server.category === 'managed' ? 'managed' : 'instant'),
      };
    }
    return {
      bindingStatus: 'resolved',
      bindingError: null,
      resolvedToolName: tool.name,
      executionMode: skill.executionMode || (server.category === 'managed' ? 'managed' : 'instant'),
    };
  }

  const resolved = resolveDefaultTool(server);
  return {
    bindingStatus: resolved.bindingStatus,
    bindingError: resolved.bindingError || null,
    resolvedToolName: resolved.resolvedToolName || '',
    executionMode: skill.executionMode || (server.category === 'managed' ? 'managed' : 'instant'),
  };
};

const enrichSkill = (skill, servers) => {
  if (skill.workflowId) {
    return {
      ...skill,
      toolName: skill.toolName || undefined,
      resolvedToolName: undefined,
      bindingStatus: 'resolved',
      bindingError: null,
      executionMode: skill.executionMode || skill.taskKind || 'instant',
      taskKind: skill.executionMode || skill.taskKind || 'instant',
    };
  }
  const binding = resolveSkillBinding(skill, servers);
  return {
    ...skill,
    toolName: skill.toolName || undefined,
    resolvedToolName: binding.resolvedToolName || undefined,
    bindingStatus: binding.bindingStatus,
    bindingError: binding.bindingError,
    executionMode: binding.executionMode,
    taskKind: binding.executionMode,
  };
};

const toSkillResponse = (skill) => ({
  name: skill.name,
  version: skill.version,
  description: skill.description,
  triggers: skill.triggers || [],
  workflowId: skill.workflowId || undefined,
  serverId: skill.serverId || '',
  toolName: skill.toolName || undefined,
  resolvedToolName: skill.resolvedToolName || undefined,
  executionMode: skill.executionMode || skill.taskKind || 'instant',
  bindingStatus: skill.bindingStatus,
  bindingError: skill.bindingError || null,
  taskKind: skill.taskKind || skill.executionMode || 'instant',
  entryScript: skill.entryScript || '',
  timeoutSeconds: skill.timeoutSeconds || 0,
  dependencies: skill.dependencies || [],
  defaultArgs: skill.defaultArgs || [],
  path: skill.path,
});

const readSkillFile = async (skillDir) => {
  const filePath = path.join(SKILLS_DIR, skillDir, 'skill.yaml');
  const content = await readFile(filePath, 'utf8');
  const parsed = parseSkillYaml(content, path.posix.join('/tools/skills', skillDir));
  return {
    ...parsed,
    filePath,
    dirName: skillDir,
  };
};

export const listSkills = async () => {
  const [entries, servers] = await Promise.all([
    readdir(SKILLS_DIR, { withFileTypes: true }),
    listServerDefinitions(),
  ]);

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = await readSkillFile(entry.name);
      skills.push(enrichSkill(parsed, servers));
    } catch {
      // ignore malformed skill directories for now
    }
  }

  return skills
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(toSkillResponse);
};

export const getSkillByName = async (skillName) => {
  const skills = await listSkills();
  return skills.find((skill) => skill.name === skillName) || null;
};

export const updateSkill = async (skillName, updates) => {
  const [entries, servers] = await Promise.all([
    readdir(SKILLS_DIR, { withFileTypes: true }),
    listServerDefinitions(),
  ]);
  const skillDir = entries.find((entry) => entry.isDirectory() && entry.name === skillName);
  if (!skillDir) {
    throw new Error(`Skill 未找到：${skillName}`);
  }

  const current = await readSkillFile(skillDir.name);
  const next = {
    ...current,
    description: updates.description ?? current.description,
    triggers: Array.isArray(updates.triggers) ? updates.triggers : current.triggers,
    workflowId: updates.workflowId === null ? '' : String(updates.workflowId ?? current.workflowId ?? '').trim(),
    serverId: String(updates.serverId ?? current.serverId ?? '').trim(),
    toolName: updates.toolName === null ? '' : String(updates.toolName ?? current.toolName ?? '').trim(),
  };

  if (!next.workflowId && !next.serverId) {
    throw new Error('workflowId 或 serverId 至少需要一个。');
  }

  const resolved = enrichSkill(next, servers);
  if (resolved.bindingStatus !== 'resolved') {
    throw new Error(resolved.bindingError || `Skill 绑定无效：${resolved.bindingStatus}`);
  }

  const payload = {
    ...next,
    executionMode: resolved.executionMode,
    taskKind: resolved.executionMode,
  };
  await writeFile(current.filePath, stringifySkillYaml(payload), 'utf8');
  return toSkillResponse(enrichSkill(payload, servers));
};

export const createSkill = async (payload = {}) => {
  const name = normalizeName(payload.name);
  if (!name) {
    throw new Error('Skill 名称不能为空。');
  }

  await mkdir(SKILLS_DIR, { recursive: true });
  const [entries, servers] = await Promise.all([
    readdir(SKILLS_DIR, { withFileTypes: true }),
    listServerDefinitions(),
  ]);

  if (entries.some((entry) => entry.isDirectory() && entry.name === name)) {
    throw new Error(`Skill 已存在：${name}`);
  }

  const serverId = String(payload.serverId || '').trim();
  const workflowId = String(payload.workflowId || '').trim();
  if (!workflowId && !serverId) {
    throw new Error('workflowId 或 serverId 至少需要一个。');
  }

  const next = {
    name,
    version: '1.0.0',
    description: String(payload.description || '').trim(),
    triggers: Array.isArray(payload.triggers) ? payload.triggers.map((item) => String(item).trim()).filter(Boolean) : [],
    workflowId,
    serverId,
    toolName: payload.toolName ? String(payload.toolName).trim() : '',
    executionMode: String(payload.executionMode || '').trim(),
    taskKind: 'instant',
    entryScript: String(payload.entryScript || '').trim(),
    timeoutSeconds: Number.parseInt(String(payload.timeoutSeconds || 30), 10) || 30,
    dependencies: [],
    defaultArgs: Array.isArray(payload.defaultArgs) ? payload.defaultArgs.map((item) => String(item)) : [],
    argsSchema: [],
    path: path.posix.join('/tools/skills', name),
  };

  const resolved = enrichSkill(next, servers);
  if (resolved.bindingStatus !== 'resolved') {
    throw new Error(resolved.bindingError || `Skill 绑定无效：${resolved.bindingStatus}`);
  }

  const normalized = {
    ...next,
    executionMode: resolved.executionMode,
    taskKind: resolved.executionMode,
    entryScript: next.entryScript || '',
  };

  const skillDir = path.join(SKILLS_DIR, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'skill.yaml'), stringifySkillYaml(normalized), 'utf8');
  return toSkillResponse(enrichSkill(normalized, servers));
};

export const deleteSkill = async (skillName) => {
  const normalizedName = normalizeName(skillName);
  if (!normalizedName) {
    throw new Error('Skill 名称不能为空。');
  }

  const skillDir = path.join(SKILLS_DIR, normalizedName);
  await rm(skillDir, { recursive: true, force: false });
  return { ok: true };
};
