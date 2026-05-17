import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP_ROOT = process.cwd();
const DATA_DIR = path.join(APP_ROOT, 'server', 'data', 'ticketing');
const ASSET_MAP_PATH = path.join(DATA_DIR, 'asset-mappings.json');
const TICKET_RECORDS_PATH = path.join(DATA_DIR, 'ticket-records.json');
const DEFAULT_SOURCE_SYSTEM = '资产运维平台';
const DEFAULT_UNIT_NAME = '南京市某单位';
const DEFAULT_PERSON_NAME = '李四';
const DEFAULT_CONTACT_PHONE = '13900000002';
const DEFAULT_ASSET_ID = 'ASSET-20260515-0002';
const CURL_STATUS_MARKER = '__OPSDOG_CURL_STATUS__';

const writeMessage = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const writeResult = (id, result) => {
  writeMessage({
    jsonrpc: '2.0',
    id,
    result,
  });
};

const writeError = (id, code, message) => {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });
};

const execFileAsync = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr || error.message));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const isLocalIssuerCertError = (error) => {
  let current = error;
  while (current) {
    if (current?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
      return true;
    }
    current = current?.cause;
  }
  return false;
};

const curlRequest = async (url, init = {}) => {
  const method = init.method || 'GET';
  const headers = init.headers || {};
  const args = ['-sS', '-L', '-X', method, url];

  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }

  if (init.body) {
    args.push('--data-raw', String(init.body));
  }

  args.push('-w', `\n${CURL_STATUS_MARKER}:%{http_code}`);

  const { stdout } = await execFileAsync('curl', args);
  const markerIndex = stdout.lastIndexOf(`\n${CURL_STATUS_MARKER}:`);
  if (markerIndex === -1) {
    throw new Error('curl fallback did not return an HTTP status marker');
  }

  const body = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + `\n${CURL_STATUS_MARKER}:`.length).trim());

  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
};

const fetchWithTlsFallback = async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (isLocalIssuerCertError(error)) {
      return await curlRequest(url, init);
    }
    throw error;
  }
};

const normalizeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const nowIso = () => new Date().toISOString();

const pad2 = (value) => String(value).padStart(2, '0');

const formatLocalDateTime = (date = new Date()) => [
  date.getFullYear(),
  '-',
  pad2(date.getMonth() + 1),
  '-',
  pad2(date.getDate()),
  ' ',
  pad2(date.getHours()),
  ':',
  pad2(date.getMinutes()),
  ':',
  pad2(date.getSeconds()),
].join('');

const buildSourceNo = (args = {}) => {
  const serverId = normalizeText(args.serverId || args.server_id || args.sourceServerId || args.source_server_id, 'manual');
  const timestamp = formatLocalDateTime().replace(/[-: ]/g, '');
  return `OPSDOG-${serverId}-${timestamp}`;
};

const normalizeRawPayload = (value) => {
  if (value === undefined || value === null || value === '') return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const ensureDataDir = async () => {
  await mkdir(DATA_DIR, { recursive: true });
};

const readAssetMappings = async () => {
  await ensureDataDir();
  try {
    const raw = await readFile(ASSET_MAP_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeArray(parsed);
  } catch {
    return [];
  }
};

const writeAssetMappings = async (records) => {
  await ensureDataDir();
  await writeFile(ASSET_MAP_PATH, JSON.stringify(records, null, 2));
};

const readTicketRecords = async () => {
  await ensureDataDir();
  try {
    const raw = await readFile(TICKET_RECORDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeArray(parsed);
  } catch {
    return [];
  }
};

const writeTicketRecords = async (records) => {
  await ensureDataDir();
  await writeFile(TICKET_RECORDS_PATH, JSON.stringify(records, null, 2));
};

const buildMappingKey = (record = {}) => {
  const serverId = normalizeText(record.serverId || record.server_id);
  const targetKey = normalizeText(record.targetKey || record.target_key);
  return `${serverId}::${targetKey}`;
};

const normalizeAssetRecord = (record = {}) => ({
  serverId: normalizeText(record.serverId || record.server_id),
  targetKey: normalizeText(record.targetKey || record.target_key),
  organizationName: normalizeText(record.organizationName || record.organization_name || record.unitName || record.unit_name),
  deviceDisplayName: normalizeText(record.deviceDisplayName || record.device_display_name),
  ownerName: normalizeText(record.ownerName || record.owner_name || record.personName || record.person_name),
  ownerPhone: normalizeText(record.ownerPhone || record.owner_phone || record.contactPhone || record.contact_phone),
  assetId: normalizeText(record.assetId || record.asset_id),
  contactPhone: normalizeText(record.contactPhone || record.contact_phone || record.ownerPhone || record.owner_phone),
  updatedAt: normalizeText(record.updatedAt || record.updated_at, nowIso()),
});

const buildTicketPayload = (args = {}) => {
  const unitName = normalizeText(
    args.unitName || args.unit_name || args.organizationName || args.organization_name,
    process.env.TICKETING_DEFAULT_UNIT_NAME || DEFAULT_UNIT_NAME,
  );
  const deviceName = normalizeText(args.deviceName || args.device_name, '待补充设备');
  const faultDescription = normalizeText(
    args.faultDescription || args.fault_description || args.faultInfo || args.fault_info,
    '待补充故障信息',
  );
  const eventTime = normalizeText(args.eventTime || args.event_time || args.faultTime || args.fault_time, formatLocalDateTime());
  const personName = normalizeText(
    args.personName || args.person_name || args.ownerName || args.owner_name,
    process.env.TICKETING_DEFAULT_PERSON_NAME || DEFAULT_PERSON_NAME,
  );
  const assetId = normalizeText(args.assetId || args.asset_id, process.env.TICKETING_DEFAULT_ASSET_ID || DEFAULT_ASSET_ID);
  const contactPhone = normalizeText(
    args.contactPhone || args.contact_phone || args.ownerPhone || args.owner_phone,
    process.env.TICKETING_DEFAULT_CONTACT_PHONE || DEFAULT_CONTACT_PHONE,
  );
  const sourceSystem = normalizeText(args.sourceSystem || args.source_system, process.env.TICKETING_SOURCE_SYSTEM || DEFAULT_SOURCE_SYSTEM);
  const sourceNo = normalizeText(args.sourceNo || args.source_no, buildSourceNo(args));

  return {
    eventTime,
    deviceName,
    faultDescription,
    personName,
    unitName,
    assetId,
    contactPhone,
    sourceSystem,
    sourceNo,
    rawPayload: normalizeRawPayload(args.rawPayload || args.raw_payload),
    remark: normalizeText(args.remark),
  };
};

const buildAlertPayloadPreview = async (args = {}) => {
  const serverId = normalizeText(args.serverId || args.server_id);
  const targetKey = normalizeText(args.targetKey || args.target_key);
  const alertStatus = normalizeText(args.alertStatus || args.alert_status, 'warning');
  const alertMessage = normalizeText(args.alertMessage || args.alert_message, '检测到异常告警');
  const alertDetail = normalizeText(args.alertDetail || args.alert_detail);
  const alertTime = normalizeText(args.alertTime || args.alert_time, formatLocalDateTime());
  const mappings = await readAssetMappings();
  const mapping = mappings.find((item) => buildMappingKey(item) === `${serverId}::${targetKey}`) || null;

  const payload = buildTicketPayload({
    unitName: mapping?.organizationName || '',
    deviceName: mapping?.deviceDisplayName || targetKey || serverId,
    faultDescription: alertDetail ? `${alertMessage} | ${alertDetail}` : alertMessage,
    eventTime: alertTime,
    personName: mapping?.ownerName || '',
    assetId: mapping?.assetId || '',
    contactPhone: mapping?.contactPhone || mapping?.ownerPhone || '',
    sourceNo: normalizeText(args.sourceNo || args.source_no, buildSourceNo({ ...args, serverId })),
    rawPayload: args.rawPayload || args.raw_payload || {
      serverId,
      targetKey,
      alertStatus,
      alertMessage,
      alertDetail,
      alertTime,
    },
    remark: normalizeText(args.remark),
  });

  return {
    ok: true,
    source: {
      serverId,
      targetKey,
      alertStatus,
      alertMessage,
      alertDetail,
      alertTime,
    },
    mappingFound: Boolean(mapping),
    mapping,
    payload,
    suggestions: {
      unitName: mapping?.organizationName ? 'from-asset-directory' : 'missing',
      personName: mapping?.ownerName ? 'from-asset-directory' : 'missing',
      deviceName: mapping?.deviceDisplayName ? 'from-asset-directory' : 'from-alert-context',
      assetId: mapping?.assetId ? 'from-asset-directory' : 'missing',
      contactPhone: mapping?.contactPhone || mapping?.ownerPhone ? 'from-asset-directory' : 'missing',
      faultDescription: 'from-alert-context',
      eventTime: 'from-alert-context',
    },
  };
};

const validateTicketPayload = (payload = {}) => {
  const requiredFields = ['eventTime', 'deviceName', 'faultDescription', 'personName', 'unitName', 'sourceSystem', 'sourceNo'];
  return requiredFields.filter((field) => !normalizeText(payload[field]));
};

const createExternalTicket = async (payload) => {
  const createUrl = normalizeText(process.env.TICKETING_CREATE_URL);
  const apiKey = normalizeText(process.env.TICKETING_API_KEY);
  if (!createUrl) {
    return {
      ok: false,
      skipped: true,
      error: '未配置 TICKETING_CREATE_URL，已跳过外部工单创建请求。',
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      skipped: true,
      error: '未配置 TICKETING_API_KEY，已跳过外部工单创建请求。',
    };
  }

  let response;
  let responseBody = null;
  let responseText = '';
  try {
    response = await fetchWithTlsFallback(createUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    responseText = await response.text();
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = null;
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const ticketId = responseBody?.data ? String(responseBody.data) : '';
  if (!response.ok || responseBody?.code !== 0 || !ticketId) {
    return {
      ok: false,
      status: response.status,
      error: responseBody?.msg || response.statusText || '工单接口返回失败。',
      response: responseBody || responseText,
    };
  }

  return {
    ok: true,
    ticketId,
    status: response.status,
    response: responseBody,
  };
};

const toolDefinitions = [
  {
    name: 'preview_ticket_payload',
    description: '根据传入参数预览工单 payload，不调用外部工单系统。',
    inputSchema: {
      type: 'object',
      properties: {
        eventTime: { type: 'string' },
        organizationName: { type: 'string' },
        unitName: { type: 'string' },
        deviceName: { type: 'string' },
        faultInfo: { type: 'string' },
        faultDescription: { type: 'string' },
        faultTime: { type: 'string' },
        ownerName: { type: 'string' },
        personName: { type: 'string' },
        assetId: { type: 'string' },
        contactPhone: { type: 'string' },
        sourceSystem: { type: 'string' },
        sourceNo: { type: 'string' },
        rawPayload: {},
        remark: { type: 'string' },
      },
      required: ['deviceName'],
      additionalProperties: true,
    },
  },
  {
    name: 'build_alert_ticket_payload',
    description: '根据告警上下文和资产映射生成推荐工单 payload。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        targetKey: { type: 'string' },
        alertStatus: { type: 'string' },
        alertMessage: { type: 'string' },
        alertDetail: { type: 'string' },
        alertTime: { type: 'string' },
        sourceNo: { type: 'string' },
        rawPayload: {},
        remark: { type: 'string' },
      },
      required: ['serverId', 'targetKey', 'alertMessage'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_ticket',
    description: '调用外部工单系统创建工单，并记录返回的工单 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        eventTime: { type: 'string' },
        organizationName: { type: 'string' },
        unitName: { type: 'string' },
        deviceName: { type: 'string' },
        faultInfo: { type: 'string' },
        faultDescription: { type: 'string' },
        faultTime: { type: 'string' },
        ownerName: { type: 'string' },
        personName: { type: 'string' },
        assetId: { type: 'string' },
        contactPhone: { type: 'string' },
        sourceSystem: { type: 'string' },
        sourceNo: { type: 'string' },
        rawPayload: {},
        remark: { type: 'string' },
      },
      required: ['deviceName'],
      additionalProperties: true,
    },
  },
  {
    name: 'upsert_asset_mapping',
    description: '新增或更新单位、设备展示名和运维负责人的主数据映射。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        targetKey: { type: 'string' },
        organizationName: { type: 'string' },
        unitName: { type: 'string' },
        deviceDisplayName: { type: 'string' },
        ownerName: { type: 'string' },
        personName: { type: 'string' },
        ownerPhone: { type: 'string' },
        contactPhone: { type: 'string' },
        assetId: { type: 'string' },
      },
      required: ['serverId', 'targetKey'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_asset_mapping',
    description: '根据 serverId 和 targetKey 读取一条资产映射。',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        targetKey: { type: 'string' },
      },
      required: ['serverId', 'targetKey'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_asset_mappings',
    description: '列出当前保存的资产映射。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  },
];

const toToolTextResult = (payload, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  isError,
});

const handleToolCall = async (id, toolName, args = {}) => {
  if (toolName === 'preview_ticket_payload') {
    writeResult(id, toToolTextResult({
      ok: true,
      mode: 'preview',
      payload: buildTicketPayload(args),
    }));
    return;
  }

  if (toolName === 'build_alert_ticket_payload') {
    writeResult(id, toToolTextResult(await buildAlertPayloadPreview(args)));
    return;
  }

  if (toolName === 'create_ticket') {
    const payload = buildTicketPayload(args);
    const missingFields = validateTicketPayload(payload);
    if (missingFields.length > 0) {
      writeResult(id, toToolTextResult({
        ok: false,
        error: `工单 payload 缺少必填字段：${missingFields.join(', ')}`,
        payload,
      }, true));
      return;
    }

    const existingRecords = await readTicketRecords();
    const existingRecord = existingRecords.find((record) => record.sourceNo === payload.sourceNo && record.ticketId);
    if (existingRecord) {
      writeResult(id, toToolTextResult({
        ok: true,
        deduplicated: true,
        ticketId: existingRecord.ticketId,
        sourceNo: payload.sourceNo,
        message: '相同 sourceNo 已成功创建过工单，已返回已有工单 ID。',
        record: existingRecord,
      }));
      return;
    }

    const createResult = await createExternalTicket(payload);
    if (!createResult.ok) {
      writeResult(id, toToolTextResult({
        ok: false,
        mode: 'create',
        payload,
        ...createResult,
      }, true));
      return;
    }

    const record = {
      sourceNo: payload.sourceNo,
      ticketId: createResult.ticketId,
      payload,
      response: createResult.response,
      createdAt: nowIso(),
    };
    await writeTicketRecords([...existingRecords, record]);
    writeResult(id, toToolTextResult({
      ok: true,
      mode: 'create',
      ticketId: createResult.ticketId,
      sourceNo: payload.sourceNo,
      payload,
      response: createResult.response,
    }));
    return;
  }

  if (toolName === 'upsert_asset_mapping') {
    const nextRecord = normalizeAssetRecord(args);
    const key = buildMappingKey(nextRecord);
    if (!nextRecord.serverId || !nextRecord.targetKey) {
      writeResult(id, toToolTextResult({ ok: false, error: 'serverId 和 targetKey 为必填项。' }, true));
      return;
    }
    const records = await readAssetMappings();
    const nextRecords = records.filter((item) => buildMappingKey(item) !== key);
    nextRecords.push(nextRecord);
    await writeAssetMappings(nextRecords);
    writeResult(id, toToolTextResult({ ok: true, record: nextRecord, total: nextRecords.length }));
    return;
  }

  if (toolName === 'get_asset_mapping') {
    const serverId = normalizeText(args.serverId || args.server_id);
    const targetKey = normalizeText(args.targetKey || args.target_key);
    const records = await readAssetMappings();
    const record = records.find((item) => buildMappingKey(item) === `${serverId}::${targetKey}`) || null;
    writeResult(id, toToolTextResult({ ok: true, record }));
    return;
  }

  if (toolName === 'list_asset_mappings') {
    const records = await readAssetMappings();
    writeResult(id, toToolTextResult({ ok: true, records, total: records.length }));
    return;
  }

  writeError(id, -32602, `未知工具：${toolName || '<empty>'}`);
};

const handleRequest = async (message) => {
  const { id, method, params } = message || {};

  if (method === 'initialize') {
    writeResult(id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'ticketing',
        version: '0.1.0',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    writeResult(id, { tools: toolDefinitions });
    return;
  }

  if (method === 'tools/call') {
    await handleToolCall(id, params?.name, params?.arguments || {});
    return;
  }

  writeError(id, -32601, `不支持的方法：${method || '<empty>'}`);
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) break;
    const raw = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!raw) continue;
    try {
      const payload = JSON.parse(raw);
      await handleRequest(payload);
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : 'Invalid JSON payload',
        },
      });
    }
  }
});
