import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStdioMcpConnection } from './mcpStdio.js';

const APP_ROOT = process.cwd();
const REPORTS_DIR = path.join(APP_ROOT, 'server', 'data', 'reports');
const MARKDOWN_PDF_ENTRY = path.join(APP_ROOT, 'server', 'src', 'markdownPdfMcp.js');

const toolDefinition = {
  name: 'generate_inspection_report',
  description: '根据巡检结果生成巡检报告文件。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      date: { type: 'string' },
      scope: { type: 'string' },
      summary: { type: 'string' },
      servers: {
        type: 'array',
        items: { type: 'object' },
      },
      alerts: {
        type: 'array',
        items: { type: 'object' },
      },
      recoveries: {
        type: 'array',
        items: { type: 'object' },
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
      },
      highlights: {
        type: 'array',
        items: { type: 'string' },
      },
      requestText: {
        type: 'string',
      },
      formats: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['md', 'pdf'],
        },
      },
      format: {
        type: 'string',
        enum: ['md', 'pdf'],
      },
    },
    required: ['title', 'date', 'scope', 'summary', 'servers', 'alerts', 'recoveries', 'recommendations'],
    additionalProperties: true,
  },
};

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

const sanitizeSlug = (value) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

const toArray = (value) => (Array.isArray(value) ? value : []);

const formatTimestamp = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const renderServerRow = (server) => {
  const name = normalizeText(server?.name, 'unknown');
  const category = normalizeText(server?.category, 'unknown');
  const status = normalizeText(server?.status, 'unknown');
  const description = normalizeText(server?.description, '无描述');
  return `| ${name} | ${category} | ${status} | ${description} |`;
};

const renderAlertItem = (item) => {
  const name = normalizeText(item?.name || item?.id, 'unknown');
  const status = normalizeText(item?.status, 'unknown');
  const detail = normalizeText(item?.detail || item?.description, '无补充说明');
  return `- **${name}**（${status}）：${detail}`;
};

const renderMarkdown = (payload) => {
  const title = normalizeText(payload.title, '巡检报告');
  const date = normalizeText(payload.date, new Date().toISOString().slice(0, 10));
  const scope = normalizeText(payload.scope, 'today');
  const summary = normalizeText(payload.summary, '本次巡检未提供摘要。');
  const servers = toArray(payload.servers);
  const alerts = toArray(payload.alerts);
  const recoveries = toArray(payload.recoveries);
  const recommendations = toArray(payload.recommendations).map((item) => normalizeText(item)).filter(Boolean);
  const highlights = toArray(payload.highlights).map((item) => normalizeText(item)).filter(Boolean);

  const lines = [
    `# ${title}`,
    '',
    `- 日期：${date}`,
    `- 范围：${scope}`,
    '',
    '## 总体结论',
    '',
    summary,
    '',
    '## 服务器状态概览',
    '',
    '| 服务器 | 分类 | 状态 | 描述 |',
    '| --- | --- | --- | --- |',
    ...(servers.length > 0 ? servers.map(renderServerRow) : ['| 无 | - | - | 当前没有可用服务器记录 |']),
    '',
    '## 告警项',
    '',
    ...(alerts.length > 0 ? alerts.map(renderAlertItem) : ['- 今日没有检测到告警项。']),
    '',
    '## 已恢复项',
    '',
    ...(recoveries.length > 0 ? recoveries.map(renderAlertItem) : ['- 今日没有检测到恢复项。']),
    '',
    '## 建议动作',
    '',
    ...(recommendations.length > 0 ? recommendations.map((item) => `- ${item}`) : ['- 继续保持巡检，暂未生成额外建议。']),
    '',
    '## 关键发现',
    '',
    ...(highlights.length > 0 ? highlights.map((item) => `- ${item}`) : ['- 无额外关键发现。']),
    '',
  ];

  return `${lines.join('\n')}\n`;
};

const callMarkdownPdfTool = async ({ title, markdown, outputPath }) => {
  const connection = await createStdioMcpConnection({
    name: 'markdown_pdf',
    command: process.execPath,
    args: [MARKDOWN_PDF_ENTRY],
    riskLevel: 'state-change',
    toolRiskOverrides: {
      render_markdown_pdf: 'state-change',
    },
    timeoutMs: 30000,
  });
  try {
    const result = await connection.request('tools/call', {
      name: 'render_markdown_pdf',
      arguments: {
        title,
        markdown,
        outputPath,
      },
    });
    if (result?.isError) {
      const text = Array.isArray(result.content) ? result.content.find((item) => item?.type === 'text')?.text : '';
      throw new Error(text || 'Markdown 转 PDF 失败。');
    }
    return result;
  } finally {
    await connection.close?.();
  }
};

const resolveRequestedFormats = (payload) => {
  if (Array.isArray(payload.formats) && payload.formats.length > 0) {
    return payload.formats.filter((item) => item === 'md' || item === 'pdf');
  }
  if (payload.format === 'pdf') {
    return ['pdf'];
  }
  if (payload.format === 'md') {
    return ['md'];
  }
  return ['md', 'pdf'];
};

const validatePayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '报告输入必须是对象。';
  }
  const formats = resolveRequestedFormats(payload);
  if (formats.length === 0) {
    return '当前只支持生成 md 或 pdf 报告。';
  }
  if (!normalizeText(payload.title)) return '缺少标题 title。';
  if (!normalizeText(payload.date)) return '缺少日期 date。';
  if (!Array.isArray(payload.servers)) return '缺少服务器清单 servers。';
  if (!Array.isArray(payload.alerts)) return '缺少告警项 alerts。';
  if (!Array.isArray(payload.recoveries)) return '缺少恢复项 recoveries。';
  if (!Array.isArray(payload.recommendations)) return '缺少建议 recommendations。';
  return null;
};

const handleGenerateInspectionReport = async (id, args) => {
  const validationError = validatePayload(args);
  if (validationError) {
    writeResult(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: validationError,
          }),
        },
      ],
      isError: true,
    });
    return;
  }

  const timestamp = formatTimestamp();
  await mkdir(REPORTS_DIR, { recursive: true });
  const markdown = renderMarkdown(args);
  const baseName = `生成报告_${timestamp}`;
  const formats = resolveRequestedFormats(args);
  const outputs = [];

  if (formats.includes('md')) {
    const fileName = `${baseName}.md`;
    const absolutePath = path.join(REPORTS_DIR, fileName);
    await writeFile(absolutePath, markdown, 'utf8');
    outputs.push({
      type: 'file',
      format: 'md',
      mimeType: 'text/markdown',
      fileName,
      path: absolutePath,
    });
  }

  if (formats.includes('pdf')) {
    const fileName = `${baseName}.pdf`;
    const absolutePath = path.join(REPORTS_DIR, fileName);
    await callMarkdownPdfTool({
      title: normalizeText(args.title, '巡检报告'),
      markdown,
      outputPath: absolutePath,
    });
    outputs.push({
      type: 'file',
      format: 'pdf',
      mimeType: 'application/pdf',
      fileName,
      path: absolutePath,
    });
  }

  writeResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          summary: `已生成 ${outputs.length} 份巡检报告文件。`,
          highlights: toArray(args.highlights).map((item) => normalizeText(item)).filter(Boolean),
          outputs,
        }),
      },
    ],
    isError: false,
  });
};

const handleRequest = async (message) => {
  const { id, method, params } = message || {};

  if (method === 'initialize') {
    writeResult(id, {
      protocolVersion: '2025-03-26',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'reporting',
        version: '1.0.0',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    writeResult(id, {
      tools: [toolDefinition],
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    if (toolName !== 'generate_inspection_report') {
      writeError(id, -32602, `未知工具：${toolName || '<empty>'}`);
      return;
    }
    await handleGenerateInspectionReport(id, params?.arguments || {});
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
