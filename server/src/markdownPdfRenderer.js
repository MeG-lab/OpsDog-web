import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const BUNDLED_NODE_MODULES = path.join(
  process.env.HOME || '',
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'node',
  'node_modules',
);

let cachedDeps = null;

const FALLBACK_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const loadRendererDeps = async () => {
  if (cachedDeps) return cachedDeps;

  const playwrightPath = require.resolve('playwright', { paths: [BUNDLED_NODE_MODULES] });
  const markedPath = require.resolve('marked', { paths: [BUNDLED_NODE_MODULES] });
  const playwrightModule = await import(pathToFileURL(playwrightPath).href);
  const markedModule = await import(pathToFileURL(markedPath).href);
  const chromium = playwrightModule.chromium || playwrightModule.default?.chromium;
  const marked = markedModule.marked || markedModule.default?.marked || markedModule.parse || markedModule.default;

  if (!chromium) {
    throw new Error('无法加载 Playwright Chromium 运行时。');
  }
  if (typeof marked !== 'function') {
    throw new Error('无法加载 Markdown 渲染器。');
  }

  cachedDeps = { chromium, marked };
  return cachedDeps;
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildHtmlDocument = ({ title, markdown, generatedAt }) => {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { size: A4; margin: 20mm 16mm; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        color: #172033;
        line-height: 1.65;
        font-size: 14px;
      }
      .report-meta {
        margin-bottom: 18px;
        color: #667085;
        font-size: 12px;
      }
      h1, h2, h3 {
        color: #101828;
        line-height: 1.3;
        margin-top: 1.4em;
        margin-bottom: 0.6em;
      }
      h1 { font-size: 28px; border-bottom: 1px solid #e4e7ec; padding-bottom: 10px; }
      h2 { font-size: 20px; }
      h3 { font-size: 16px; }
      p, ul, ol, table, pre, blockquote { margin: 0 0 1em; }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 12px;
      }
      th, td {
        border: 1px solid #d0d5dd;
        padding: 8px 10px;
        vertical-align: top;
        word-break: break-word;
      }
      th { background: #f8fafc; text-align: left; }
      code, pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      pre {
        background: #f8fafc;
        border: 1px solid #eaecf0;
        border-radius: 8px;
        padding: 12px;
        overflow: hidden;
        white-space: pre-wrap;
        word-break: break-word;
      }
      a { color: #175cd3; text-decoration: none; }
      blockquote {
        border-left: 3px solid #d0d5dd;
        padding-left: 12px;
        color: #475467;
      }
    </style>
  </head>
  <body>
    <div class="report-meta">生成时间：${escapeHtml(generatedAt)}</div>
    <article class="markdown-body">${markdown}</article>
  </body>
</html>`;
};

const resolveLaunchOptions = async () => {
  for (const executablePath of FALLBACK_BROWSER_PATHS) {
    try {
      await access(executablePath);
      return {
        headless: true,
        executablePath,
      };
    } catch {
      // continue
    }
  }

  return { headless: true };
};

export const renderMarkdownPdfToFile = async ({ title, markdown, outputPath }) => {
  const { chromium, marked } = await loadRendererDeps();
  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (primaryError) {
      const fallbackOptions = await resolveLaunchOptions();
      if (!fallbackOptions.executablePath) {
        throw primaryError;
      }
      browser = await chromium.launch(fallbackOptions);
    }
    const page = await browser.newPage();
    const renderedMarkdown = marked(String(markdown || ''));
    const html = buildHtmlDocument({
      title: title || '报告',
      markdown: renderedMarkdown,
      generatedAt: new Date().toLocaleString('zh-CN'),
    });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '16mm',
        bottom: '20mm',
        left: '16mm',
      },
    });
  } finally {
    await browser?.close();
  }
};
