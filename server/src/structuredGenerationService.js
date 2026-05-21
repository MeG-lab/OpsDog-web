const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'openai',
  'custom',
  'aliyun',
  'deepseek',
  'siliconflow',
  'volcengine',
  'zhipu',
  'moonshot',
]);

const nowIso = () => new Date().toISOString();

const tryParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const stripMarkdownFence = (value) => {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
};

const extractBalancedJsonObject = (value) => {
  const text = stripMarkdownFence(value);
  const direct = tryParseJson(text);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      const candidate = text.slice(start, index + 1);
      const parsed = tryParseJson(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
  }

  return null;
};

const typeMatches = (schemaType, value) => {
  if (!schemaType) return true;
  if (Array.isArray(schemaType)) return schemaType.some((type) => typeMatches(type, value));
  if (schemaType === 'array') return Array.isArray(value);
  if (schemaType === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (schemaType === 'integer') return Number.isInteger(value);
  if (schemaType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schemaType === 'boolean') return typeof value === 'boolean';
  if (schemaType === 'string') return typeof value === 'string';
  return true;
};

const validateAgainstSchema = (value, schema, path = '$') => {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (!typeMatches(schema.type, value)) {
    errors.push(`${path} 类型不符合 ${schema.type}`);
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join(' | ')}`);
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        errors.push(`${path}.${key} 缺失`);
      }
    }

    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        errors.push(...validateAgainstSchema(value[key], childSchema, `${path}.${key}`));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`));
    });
  }

  return errors;
};

const buildJsonPrompt = ({ schemaName, schema, systemPrompt, userPrompt, repairContext }) => [
  systemPrompt,
  '',
  `你必须只输出一个符合 ${schemaName} JSON Schema 的 JSON object。`,
  '禁止 Markdown、代码块、注释、解释、前后缀、undefined、NaN、尾逗号。',
  '所有字符串必须使用双引号，必须能被 JSON.parse 解析。',
  '',
  'JSON Schema:',
  JSON.stringify(schema, null, 2),
  repairContext ? ['', '上一次输出无法解析或不符合 schema，请修复后只输出 JSON object。', repairContext].join('\n') : '',
  '',
  userPrompt,
].filter(Boolean).join('\n');

const buildTool = ({ schemaName, schema, description }) => ({
  type: 'function',
  function: {
    name: schemaName,
    description: description || `Return ${schemaName} as function arguments.`,
    parameters: schema,
  },
});

const extractToolObject = (response, schemaName) => {
  const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
  const toolCall = calls.find((call) => call?.name === schemaName);
  if (!toolCall) return null;
  const parsed = typeof toolCall.arguments === 'string'
    ? tryParseJson(toolCall.arguments.trim())
    : toolCall.arguments;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
};

const assertValidObject = (object, schema) => {
  const errors = validateAgainstSchema(object, schema);
  if (errors.length) {
    throw new Error(errors.slice(0, 8).join('；'));
  }
  return object;
};

const getStructuredGenerationProfile = (model = {}) => {
  const modelName = String(model.modelName || '').toLowerCase();
  const provider = String(model.provider || '').toLowerCase();
  const openAICompatible = OPENAI_COMPATIBLE_PROVIDERS.has(provider);
  const thinkingMode = /thinking|reasoning|minimax-m2|m2\.1|m2\.5/.test(modelName);
  return {
    openAICompatible,
    supportsJsonSchema: openAICompatible,
    supportsToolAuto: openAICompatible,
    supportsForcedToolChoice: openAICompatible && !thinkingMode,
    prefersPromptFallback: !openAICompatible,
  };
};

export const generateStructuredObject = async ({
  schemaName,
  schema,
  description,
  systemPrompt,
  userPrompt,
  model,
  sendChat,
  signal,
  maxTokens,
  temperature,
}) => {
  const attempts = [];
  const profile = getStructuredGenerationProfile(model);
  const baseRequest = {
    provider: model.provider,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl,
    modelName: model.modelName,
    maxTokens: maxTokens || Math.min(Math.max(Number(model.maxTokens || 4096), 4096), 12000),
    temperature: temperature ?? Math.min(Number(model.temperature ?? 0.1), 0.1),
    signal,
  };

  const tryStrategy = async (strategy, buildRequest, extractObject) => {
    const startedAt = Date.now();
    try {
      const response = await sendChat(buildRequest());
      const object = extractObject(response);
      if (!object) throw new Error('模型没有返回可解析的结构化对象。');
      const valid = assertValidObject(object, schema);
      attempts.push({ strategy, ok: true, elapsedMs: Date.now() - startedAt });
      return valid;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ strategy, ok: false, elapsedMs: Date.now() - startedAt, error: message });
      return null;
    }
  };

  if (profile.supportsJsonSchema) {
    const jsonSchemaResult = await tryStrategy(
      'response_format.json_schema',
      () => ({
        ...baseRequest,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: schemaName,
            strict: false,
            schema,
          },
        },
      }),
      (response) => extractBalancedJsonObject(response?.content || ''),
    );
    if (jsonSchemaResult) return { object: jsonSchemaResult, strategy: 'response_format.json_schema', attempts };
  }

  if (profile.supportsToolAuto) {
    const toolAutoResult = await tryStrategy(
      'tool_call.auto',
      () => ({
        ...baseRequest,
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n必须调用 ${schemaName} 函数返回结构化参数。` },
          { role: 'user', content: userPrompt },
        ],
        tools: [buildTool({ schemaName, schema, description })],
        toolChoice: 'auto',
      }),
      (response) => extractToolObject(response, schemaName) || extractBalancedJsonObject(response?.content || ''),
    );
    if (toolAutoResult) return { object: toolAutoResult, strategy: 'tool_call.auto', attempts };
  }

  let repairContext = '';
  let rawOutput = '';
  for (let retry = 0; retry < 2; retry += 1) {
    const promptResult = await tryStrategy(
      retry === 0 ? 'json_prompt' : 'json_prompt.repair',
      () => ({
        ...baseRequest,
        messages: [
          {
            role: 'user',
            content: buildJsonPrompt({ schemaName, schema, systemPrompt, userPrompt, repairContext }),
          },
        ],
      }),
      (response) => {
        rawOutput = String(response?.content || '');
        const object = extractBalancedJsonObject(rawOutput);
        if (!object) {
          repairContext = `原始输出：${rawOutput.slice(0, 2000)}`;
        }
        return object;
      },
    );
    if (promptResult) return { object: promptResult, strategy: retry === 0 ? 'json_prompt' : 'json_prompt.repair', attempts };
    const last = attempts[attempts.length - 1];
    repairContext = [
      repairContext || `原始输出：${rawOutput.slice(0, 2000)}`,
      `错误：${last?.error || '未知解析错误'}`,
    ].filter(Boolean).join('\n');
  }

  const detail = attempts
    .map((attempt) => `${attempt.strategy}: ${attempt.ok ? 'ok' : attempt.error}`)
    .join('；');
  console.warn(`[structured-generation ${nowIso()}] ${schemaName} failed`, attempts);
  throw new Error(`当前模型未能稳定返回结构化任务定义，已尝试降级/重试：${detail}`);
};
