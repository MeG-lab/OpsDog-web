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
        color: #182230;
        line-height: 1.65;
        font-size: 14px;
      }
      .report-meta {
        margin-bottom: 22px;
        padding: 10px 12px;
        border: 1px solid #d9e2f2;
        border-left: 4px solid #175cd3;
        background: #f8fbff;
        color: #475467;
        font-size: 12px;
      }
      h1, h2, h3 {
        color: #101828;
        line-height: 1.3;
        margin-top: 1.4em;
        margin-bottom: 0.6em;
      }
      h1 { font-size: 28px; border-bottom: 2px solid #dbe5f3; padding-bottom: 10px; }
      h2 { font-size: 20px; padding-left: 10px; border-left: 4px solid #175cd3; }
      h3 { font-size: 16px; }
      p, ul, ol, table, pre, blockquote { margin: 0 0 1em; }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 12px;
        overflow: hidden;
        border-radius: 8px;
      }
      th, td {
        border: 1px solid #d0d5dd;
        padding: 8px 10px;
        vertical-align: top;
        word-break: break-word;
      }
      th { background: #eef4fc; color: #344054; text-align: left; }
      tr.report-row-healthy td { background: #f0fdf4; border-color: #bbf7d0; }
      tr.report-row-warning td { background: #fffbeb; border-color: #fde68a; }
      tr.report-row-critical td { background: #fef2f2; border-color: #fecaca; }
      tr.report-row-healthy td:first-child { box-shadow: inset 4px 0 0 #16a34a; }
      tr.report-row-warning td:first-child { box-shadow: inset 4px 0 0 #d97706; }
      tr.report-row-critical td:first-child { box-shadow: inset 4px 0 0 #dc2626; }
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
      a { color: #175cd3; text-decoration: underline; text-underline-offset: 2px; }
      blockquote {
        border: 1px solid #d0d5dd;
        border-left: 4px solid #667085;
        background: #f8fafc;
        padding: 10px 12px;
        color: #475467;
      }
      h2 + p {
        padding: 10px 12px;
        border-radius: 8px;
        background: #f8fafc;
      }
      .report-trend {
        min-height: 32px;
        border: 1px dashed #98a2b3;
        border-radius: 8px;
        padding: 10px 12px;
      }
    </style>
  </head>
  <body>
    <div class="report-meta">生成时间：${escapeHtml(generatedAt)}</div>
    <article class="markdown-body">${markdown}</article>
    <script>
      const classifyRow = (text) => {
        if (/(异常|严重|critical|error|失败|不可达|离线)/i.test(text)) return 'report-row-critical';
        if (/(告警|需关注|attention|warning|偏高|波动)/i.test(text)) return 'report-row-warning';
        if (/(正常|健康|healthy|running|可达|成功|恢复)/i.test(text)) return 'report-row-healthy';
        return '';
      };
      document.querySelectorAll('table tbody tr').forEach((row) => {
        const className = classifyRow(row.textContent || '');
        if (className) row.classList.add(className);
      });
      document.querySelectorAll('h2').forEach((heading) => {
        if (/(趋势|trend)/i.test(heading.textContent || '')) {
          heading.nextElementSibling?.classList.add('report-trend');
        }
      });
    </script>
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

// ── Browser singleton ──

const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let browserInstance = null;
let browserRefCount = 0;
let browserIdleTimer = null;

const clearIdleTimer = () => {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
};

const startIdleTimer = () => {
  clearIdleTimer();
  browserIdleTimer = setTimeout(async () => {
    if (browserRefCount === 0 && browserInstance) {
      try { await browserInstance.close(); } catch { /* ignore */ }
      browserInstance = null;
    }
  }, BROWSER_IDLE_TIMEOUT_MS);
};

const getBrowser = async () => {
  if (browserInstance && browserInstance.isConnected()) {
    browserRefCount += 1;
    clearIdleTimer();
    return browserInstance;
  }

  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* ignore */ }
    browserInstance = null;
  }

  const { chromium } = await loadRendererDeps();

  try {
    browserInstance = await chromium.launch({ headless: true });
  } catch (primaryError) {
    const fallbackOptions = await resolveLaunchOptions();
    if (!fallbackOptions.executablePath) throw primaryError;
    browserInstance = await chromium.launch(fallbackOptions);
  }

  browserRefCount = 1;
  return browserInstance;
};

const releaseBrowser = () => {
  browserRefCount = Math.max(0, browserRefCount - 1);
  if (browserRefCount === 0) {
    startIdleTimer();
  }
};

export const renderMarkdownPdfToFile = async ({ title, markdown, outputPath }) => {
  const { marked } = await loadRendererDeps();
  for (let attempt = 0; attempt <= 1; attempt++) {
    const browser = await getBrowser();
    try {
      const page = await browser.newPage();
      try {
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
        return;
      } finally {
        await page.close();
      }
    } catch (error) {
      if (attempt < 1 && (error.message?.includes('Target closed') || error.message?.includes('Browser closed'))) {
        try { await browser.close(); } catch { /* ignore */ }
        browserInstance = null;
        continue;
      }
      throw error;
    } finally {
      releaseBrowser();
    }
  }
};
