type RawSkillMeta = {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  taskKind: 'instant' | 'managed';
  entryScript: string;
  timeoutSeconds: number;
  dependencies: string[];
  defaultArgs: string[];
  argsSchema: Array<{
    flag: string;
    type: 'string' | 'integer';
    required: boolean;
    multiple?: boolean;
    min?: number;
    max?: number;
    pattern?: string;
  }>;
  path: string;
};

type SkillMetaOverride = {
  description?: string;
  triggers?: string[];
};

const skillYamlModules = import.meta.glob('/skills/**/skill.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const skillInstructionModules = import.meta.glob('/skills/**/instructions.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SKILL_OVERRIDE_STORAGE_KEY = 'aiops_web_skill_overrides';

const stripQuotes = (value: string) => value.replace(/^['"]|['"]$/g, '');

function parseScalar(value: string): string {
  return stripQuotes(value.trim());
}

function parseStringList(lines: string[], startIndex: number): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith('  - ')) break;
    values.push(parseScalar(line.slice(4)));
    index += 1;
  }
  return { values, nextIndex: index };
}

function parseSkillYaml(content: string, path: string): RawSkillMeta {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.replace(/\t/g, '  '))
    .filter(line => line.trim().length > 0 && !line.trim().startsWith('#'));

  const result: RawSkillMeta = {
    name: '',
    version: '1.0.0',
    description: '',
    triggers: [],
    taskKind: 'instant',
    entryScript: '',
    timeoutSeconds: 60,
    dependencies: [],
    defaultArgs: [],
    argsSchema: [],
    path,
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

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
    if (trimmed.startsWith('task_kind:')) {
      result.taskKind = (parseScalar(trimmed.slice('task_kind:'.length)) || 'instant') as RawSkillMeta['taskKind'];
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
      const schemaItems: RawSkillMeta['argsSchema'] = [];
      let nextIndex = index + 1;

      while (nextIndex < lines.length) {
        const line = lines[nextIndex];
        if (!line.startsWith('  - ')) break;

        const item: RawSkillMeta['argsSchema'][number] = {
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
          if (firstKey === 'type') item.type = (parseScalar(firstValue) || 'string') as 'string' | 'integer';
          if (firstKey === 'required') item.required = parseScalar(firstValue) === 'true';
          if (firstKey === 'multiple') item.multiple = parseScalar(firstValue) === 'true';
          if (firstKey === 'min') item.min = Number.parseInt(parseScalar(firstValue), 10);
          if (firstKey === 'max') item.max = Number.parseInt(parseScalar(firstValue), 10);
          if (firstKey === 'pattern') item.pattern = parseScalar(firstValue);
        }

        nextIndex += 1;
        while (nextIndex < lines.length && lines[nextIndex].startsWith('    ')) {
          const nested = lines[nextIndex].trim();
          const [nestedKeyRaw, ...nestedValueParts] = nested.split(':');
          const nestedKey = nestedKeyRaw?.trim();
          const nestedValue = nestedValueParts.join(':').trim();
          if (!nestedKey) {
            nextIndex += 1;
            continue;
          }
          if (nestedKey === 'flag') item.flag = parseScalar(nestedValue);
          if (nestedKey === 'type') item.type = (parseScalar(nestedValue) || 'string') as 'string' | 'integer';
          if (nestedKey === 'required') item.required = parseScalar(nestedValue) === 'true';
          if (nestedKey === 'multiple') item.multiple = parseScalar(nestedValue) === 'true';
          if (nestedKey === 'min') item.min = Number.parseInt(parseScalar(nestedValue), 10);
          if (nestedKey === 'max') item.max = Number.parseInt(parseScalar(nestedValue), 10);
          if (nestedKey === 'pattern') item.pattern = parseScalar(nestedValue);
          nextIndex += 1;
        }

        if (item.flag) {
          schemaItems.push(item);
        }
      }

      result.argsSchema = schemaItems;
      index = nextIndex;
      continue;
    }

    index += 1;
  }

  return result;
}

function readOverrides(): Record<string, SkillMetaOverride> {
  try {
    const raw = localStorage.getItem(SKILL_OVERRIDE_STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, SkillMetaOverride> : {};
  } catch {
    return {};
  }
}

function writeOverrides(overrides: Record<string, SkillMetaOverride>): void {
  localStorage.setItem(SKILL_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
}

export function getBundledSkills(): RawSkillMeta[] {
  const overrides = readOverrides();
  return Object.entries(skillYamlModules)
    .map(([modulePath, content]) => {
      const folderPath = modulePath.replace(/\/skill\.yaml$/, '');
      const base = parseSkillYaml(content, folderPath);
      const override = overrides[base.name];
      if (!override) return base;
      return {
        ...base,
        description: override.description ?? base.description,
        triggers: override.triggers ?? base.triggers,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getBundledSkillInstructions(skillPath: string): string {
  const modulePath = `${skillPath}/instructions.md`;
  return skillInstructionModules[modulePath] ?? '';
}

export function updateBundledSkillOverride(skillName: string, override: SkillMetaOverride): RawSkillMeta {
  const skills = getBundledSkills();
  const current = skills.find(skill => skill.name === skillName);
  if (!current) {
    throw new Error(`Skill not found: ${skillName}`);
  }

  const overrides = readOverrides();
  overrides[skillName] = {
    ...(overrides[skillName] ?? {}),
    ...override,
  };
  writeOverrides(overrides);

  return {
    ...current,
    description: override.description ?? current.description,
    triggers: override.triggers ?? current.triggers,
  };
}
