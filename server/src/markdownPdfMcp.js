import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { renderMarkdownPdfToFile } from './markdownPdfRenderer.js';

const normalizeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
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

const toolDefinition = {
  name: 'render_markdown_pdf',
  description: '将 Markdown 内容渲染为 PDF 文件。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      markdown: { type: 'string' },
      outputPath: { type: 'string' },
    },
    required: ['markdown', 'outputPath'],
    additionalProperties: true,
  },
};

const handleRenderMarkdownPdf = async (id, args) => {
  const title = normalizeText(args?.title, '报告');
  const markdown = typeof args?.markdown === 'string' ? args.markdown : '';
  const outputPath = normalizeText(args?.outputPath);

  if (!markdown) {
    writeResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '缺少 markdown 内容。' }) }],
      isError: true,
    });
    return;
  }
  if (!outputPath) {
    writeResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '缺少输出路径 outputPath。' }) }],
      isError: true,
    });
    return;
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await renderMarkdownPdfToFile({ title, markdown, outputPath });

  writeResult(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          summary: '已生成 PDF 文件。',
          output: {
            type: 'file',
            format: 'pdf',
            mimeType: 'application/pdf',
            fileName: path.basename(outputPath),
            path: outputPath,
          },
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
      capabilities: { tools: {} },
      serverInfo: {
        name: 'markdown_pdf',
        version: '1.0.0',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    writeResult(id, { tools: [toolDefinition] });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    if (toolName !== 'render_markdown_pdf') {
      writeError(id, -32602, `未知工具：${toolName || '<empty>'}`);
      return;
    }
    await handleRenderMarkdownPdf(id, params?.arguments || {});
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
