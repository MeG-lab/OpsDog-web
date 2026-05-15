import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP_ROOT = process.cwd();
const DATA_DIR = path.join(APP_ROOT, 'server', 'data', 'ticketing');
const ASSET_MAP_PATH = path.join(DATA_DIR, 'asset-mappings.json');

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

const normalizeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const nowIso = () => new Date().toISOString();

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

const buildMappingKey = (record = {}) => {
  const serverId = normalizeText(record.serverId || record.server_id);
  const targetKey = normalizeText(record.targetKey || record.target_key);
  return `${serverId}::${targetKey}`;
};

const normalizeAssetRecord = (record = {}) => ({
  serverId: normalizeText(record.serverId || record.server_id),
  targetKey: normalizeText(record.targetKey || record.target_key),
  organizationName: normalizeText(record.organizationName || record.organization_name),
  deviceDisplayName: normalizeText(record.deviceDisplayName || record.device_display_name),
  ownerName: normalizeText(record.ownerName || record.owner_name),
  ownerPhone: normalizeText(record.ownerPhone || record.owner_phone),
  updatedAt: normalizeText(record.updatedAt || record.updated_at, nowIso()),
});

const buildTicketPayload = (args = {}) => {
  const organizationName = normalizeText(args.organizationName || args.organization_name, '待补充单位');
  const deviceName = normalizeText(args.deviceName || args.device_name, '待补充设备');
  const faultInfo = normalizeText(args.faultInfo || args.fault_info, '待补充故障信息');
  const faultTime = normalizeText(args.faultTime || args.fault_time, nowIso());
  const ownerName = normalizeText(args.ownerName || args.owner_name, '待补充负责人');

  return {
    organizationName,
    deviceName,
    faultInfo,
    faultTime,
    ownerName,
    summary: `${organizationName}-${deviceName} 故障工单`,
    description: [
      `单位名称：${organizationName}`,
      `设备名称：${deviceName}`,
      `故障信息：${faultInfo}`,
      `故障时间：${faultTime}`,
      `运维负责人：${ownerName}`,
    ].join('\n'),
  };
};

const buildAlertPayloadPreview = async (args = {}) => {
  const serverId = normalizeText(args.serverId || args.server_id);
  const targetKey = normalizeText(args.targetKey || args.target_key);
  const alertStatus = normalizeText(args.alertStatus || args.alert_status, 'warning');
  const alertMessage = normalizeText(args.alertMessage || args.alert_message, '检测到异常告警');
  const alertDetail = normalizeText(args.alertDetail || args.alert_detail);
  const alertTime = normalizeText(args.alertTime || args.alert_time, nowIso());
  const mappings = await readAssetMappings();
  const mapping = mappings.find((item) => buildMappingKey(item) === `${serverId}::${targetKey}`) || null;

  const payload = buildTicketPayload({
    organizationName: mapping?.organizationName || '',
    deviceName: mapping?.deviceDisplayName || targetKey || serverId,
    faultInfo: alertDetail ? `${alertMessage} | ${alertDetail}` : alertMessage,
    faultTime: alertTime,
    ownerName: mapping?.ownerName || '',
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
      organizationName: mapping?.organizationName ? 'from-asset-directory' : 'missing',
      ownerName: mapping?.ownerName ? 'from-asset-directory' : 'missing',
      deviceName: mapping?.deviceDisplayName ? 'from-asset-directory' : 'from-alert-context',
      faultInfo: 'from-alert-context',
      faultTime: 'from-alert-context',
    },
  };
};

const toolDefinitions = [
  {
    name: 'preview_ticket_payload',
    description: '根据传入参数预览工单 payload，不调用外部工单系统。',
    inputSchema: {
      type: 'object',
      properties: {
        organizationName: { type: 'string' },
        deviceName: { type: 'string' },
        faultInfo: { type: 'string' },
        faultTime: { type: 'string' },
        ownerName: { type: 'string' },
      },
      required: ['deviceName', 'faultInfo'],
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
      },
      required: ['serverId', 'targetKey', 'alertMessage'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_ticket',
    description: '工单创建占位工具。当前只返回即将提交的 payload，后续替换为真实 API 调用。',
    inputSchema: {
      type: 'object',
      properties: {
        organizationName: { type: 'string' },
        deviceName: { type: 'string' },
        faultInfo: { type: 'string' },
        faultTime: { type: 'string' },
        ownerName: { type: 'string' },
      },
      required: ['organizationName', 'deviceName', 'faultInfo', 'faultTime', 'ownerName'],
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
        deviceDisplayName: { type: 'string' },
        ownerName: { type: 'string' },
        ownerPhone: { type: 'string' },
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
    writeResult(id, toToolTextResult({
      ok: true,
      mode: 'placeholder',
      ticketId: null,
      message: 'ticketing 内置服务器骨架已预留，当前尚未接入真实工单 API。',
      payload: buildTicketPayload(args),
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
