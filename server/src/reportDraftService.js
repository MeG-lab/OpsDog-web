import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultReportsDir } from './serverRegistry.js';
import { renderMarkdownPdfToFile } from './markdownPdfRenderer.js';

const REPORTS_DIR = getDefaultReportsDir();
const MAX_CONTEXT_CHARS = 18000;
const MAX_SKILL_CHARS = 12000;

const normalizeText = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clip = (value, max) => {
  const text = normalizeText(value);
  return text.length > max ? `${text.slice(0, max)}\n...（内容过长，已截断）` : text;
};

const pad2 = (value) => String(value).padStart(2, '0');

const timestampSlug = (date = new Date()) =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;

const sanitizeFileBase = (value) => {
  const sanitized = normalizeText(value, 'report')
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'report';
};

const stripMarkdownFence = (value) => {
  const text = normalizeText(value);
  const fenced = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return normalizeText(fenced?.[1] || text);
};

const markdownTitle = (markdown, fallback = '运维报告') => {
  const matched = normalizeText(markdown).match(/^#\s+(.+)$/m);
  return normalizeText(matched?.[1], fallback).replace(/\s+#*$/, '');
};

const formatSkillOption = (skill) => ({
  id: normalizeText(skill?.id),
  name: normalizeText(skill?.name, normalizeText(skill?.id, '报告格式 Skill')),
  description: normalizeText(skill?.description),
});

const reportFormatSkills = (packages) => (Array.isArray(packages) ? packages : [])
  .filter((skill) => skill?.enabled !== false && skill?.reportFormat === true)
  .filter((skill) => normalizeText(skill?.id) && normalizeText(skill?.instructionText));

const resolveFormatSkill = ({ packages, requestedId, draft }) => {
  const candidates = reportFormatSkills(packages);
  const preferredId = normalizeText(requestedId || draft?.formatSkill?.id);
  if (preferredId) {
    const matched = candidates.find((skill) => skill.id === preferredId);
    return {
      skill: matched || null,
      options: candidates.map(formatSkillOption),
      requiresSelection: !matched && candidates.length > 0,
    };
  }
  if (candidates.length === 1) {
    return { skill: candidates[0], options: candidates.map(formatSkillOption), requiresSelection: false };
  }
  return {
    skill: null,
    options: candidates.map(formatSkillOption),
    requiresSelection: candidates.length > 1,
  };
};

const compactExecutionResult = (result) => {
  if (!result || typeof result !== 'object') return undefined;
  return {
    ok: Boolean(result.ok),
    kind: normalizeText(result.kind),
    workflowId: normalizeText(result.workflowId),
    summary: normalizeText(result.summary),
    highlights: Array.isArray(result.highlights) ? result.highlights.map((item) => normalizeText(item)).filter(Boolean).slice(0, 16) : [],
    errors: Array.isArray(result.errors) ? result.errors.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8) : [],
    artifacts: Array.isArray(result.artifacts) ? result.artifacts.map((item) => ({
      fileName: normalizeText(item?.fileName),
      format: normalizeText(item?.format),
      mimeType: normalizeText(item?.mimeType),
    })).slice(0, 8) : [],
    steps: Array.isArray(result.steps) ? result.steps.map((step) => ({
      title: normalizeText(step?.title),
      status: normalizeText(step?.status),
      summary: normalizeText(step?.summary),
      findings: Array.isArray(step?.findings) ? step.findings.map((item) => normalizeText(item)).filter(Boolean).slice(0, 10) : [],
      error: normalizeText(step?.error),
      data: step?.data && typeof step.data === 'object' ? step.data : undefined,
    })).slice(0, 20) : [],
  };
};

const compactMessages = (messages) => (Array.isArray(messages) ? messages : [])
  .filter((message) => message && ['user', 'assistant'].includes(message.role))
  .map((message) => ({
    role: message.role,
    content: clip(message.content, 4000),
    executionResult: compactExecutionResult(message.executionResult),
  }))
  .filter((message) => message.content || message.executionResult);

const defaultDraftMarkdown = ({ sourceScope, contextMessages }) => {
  const assistantMessages = contextMessages.filter((message) => message.role === 'assistant');
  const findings = assistantMessages
    .map((message) => normalizeText(message.executionResult?.summary || message.content))
    .filter(Boolean)
    .slice(-6);
  return [
    '# 运维报告',
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 来源：${sourceScope === 'message' ? '单次对话输出' : '当前对话上下文'}`,
    '',
    '## 总体结论',
    '',
    findings[0] || '已基于当前对话整理报告草稿。',
    '',
    '## 关键结果',
    '',
    ...(findings.length > 0 ? findings.map((item) => `- ${item}`) : ['- 当前上下文暂未提取到可展示结果。']),
    '',
    '## 建议动作',
    '',
    '- 复核草稿中的关键结论后再导出。',
    '',
  ].join('\n');
};

const buildDraftPrompt = ({ sourceScope, contextMessages, currentDraft, instruction, formatSkill }) => {
  const formatInstruction = formatSkill
    ? [
        '',
        `本次报告格式必须遵循报告格式 Skill：${formatSkill.name} (${formatSkill.id})。`,
        '报告格式 Skill 文档：',
        clip(formatSkill.instructionText, MAX_SKILL_CHARS),
      ].join('\n')
    : '\n本次没有启用报告格式 Skill，请根据上下文自由组织最有用的报告结构。';
  const systemPrompt = [
    '你是 OpsDog 的对话式运维报告编辑器。',
    '你的任务是把给定对话和执行结果整理为一份可预览、可继续修订的 Markdown 报告草稿。',
    '只输出 Markdown 报告正文，不要输出说明、JSON、代码围栏或导出确认话术。',
    '报告必须使用中文；首行必须是 # 一级标题。',
    '不要编造不存在的检查、设备、工单、历史趋势或维护公告。',
    '优先保留结构化执行结果中的关键指标、异常、表格数据、建议和可复核事实。',
    '如果状态结果适合表格，请使用 Markdown 表格，并保留“状态”字段。',
    '如上下文提供系统内链接，可在设备名称上保留 Markdown 链接；没有链接时使用纯文本。',
    formatInstruction,
  ].join('\n');
  const payload = {
    sourceScope,
    instruction: normalizeText(instruction),
    currentDraft: currentDraft ? {
      title: currentDraft.title,
      markdown: clip(currentDraft.markdown, 14000),
      summary: currentDraft.summary,
    } : null,
    contextMessages,
  };
  const userPrompt = [
    currentDraft ? '请根据修订指令和新增上下文更新当前报告草稿。' : '请根据上下文生成报告草稿。',
    '',
    '输入上下文：',
    '```json',
    clip(JSON.stringify(payload, null, 2), MAX_CONTEXT_CHARS),
    '```',
  ].join('\n');
  return { systemPrompt, userPrompt };
};

const buildDraftSummary = ({ sourceScope, title, formatSkill, instruction }) => {
  const sourceText = sourceScope === 'message' ? '单次对话输出' : '当前对话';
  const actionText = normalizeText(instruction) ? '已更新' : '已整理';
  const skillText = formatSkill ? `，按“${formatSkill.name}”格式` : '';
  return `${actionText}${sourceText}的报告草稿${skillText}：${title}`;
};

export const createReportDraft = async ({ payload, sendChat, skillPackages }) => {
  const sourceScope = payload?.sourceScope === 'message' ? 'message' : 'conversation';
  const contextMessages = compactMessages(payload?.contextMessages);
  const formatResolution = resolveFormatSkill({
    packages: skillPackages,
    requestedId: payload?.formatSkillId,
    draft: payload?.draft,
  });

  if (formatResolution.requiresSelection) {
    return {
      requiresFormatSelection: true,
      formatSkills: formatResolution.options,
    };
  }

  if (contextMessages.length === 0 && !payload?.draft) {
    throw new Error('没有可整理为报告的对话上下文。');
  }

  const currentDraft = payload?.draft && typeof payload.draft === 'object' ? payload.draft : null;
  const { systemPrompt, userPrompt } = buildDraftPrompt({
    sourceScope,
    contextMessages,
    currentDraft,
    instruction: payload?.instruction,
    formatSkill: formatResolution.skill,
  });

  let markdown = '';
  if (payload?.model?.provider && payload?.model?.apiKey && payload?.model?.modelName) {
    const response = await sendChat({
      provider: payload.model.provider,
      apiKey: payload.model.apiKey,
      baseUrl: payload.model.baseUrl || undefined,
      modelName: payload.model.modelName,
      maxTokens: payload.model.maxTokens || 4096,
      temperature: Math.min(payload.model.temperature ?? 0.3, 0.5),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    markdown = stripMarkdownFence(response.content);
  }

  if (!/^#\s+\S/m.test(markdown)) {
    markdown = defaultDraftMarkdown({ sourceScope, contextMessages });
  }

  const title = markdownTitle(markdown, currentDraft?.title || '运维报告');
  const formatSkill = formatResolution.skill ? formatSkillOption(formatResolution.skill) : null;
  const draft = {
    id: normalizeText(currentDraft?.id, randomUUID()),
    title,
    markdown: `${normalizeText(markdown)}\n`,
    summary: buildDraftSummary({ sourceScope, title, formatSkill, instruction: payload?.instruction }),
    sourceScope,
    formatSkill,
    updatedAt: new Date().toISOString(),
  };
  return { draft };
};

export const exportReportDraft = async (payload) => {
  const draft = payload?.draft && typeof payload.draft === 'object' ? payload.draft : null;
  const markdown = normalizeText(draft?.markdown);
  if (!markdown) {
    throw new Error('缺少可导出的报告草稿。');
  }
  const formats = Array.from(new Set(Array.isArray(payload?.formats) && payload.formats.length > 0
    ? payload.formats.filter((format) => format === 'md' || format === 'pdf')
    : ['pdf']));
  if (formats.length === 0) {
    throw new Error('当前只支持导出 PDF 或 Markdown。');
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const baseName = `${sanitizeFileBase(payload?.fileName || draft.title)}_${timestampSlug()}`;
  const outputs = [];

  if (formats.includes('md')) {
    const fileName = `${baseName}.md`;
    const outputPath = path.join(REPORTS_DIR, fileName);
    await writeFile(outputPath, `${markdown}\n`, 'utf8');
    outputs.push({
      type: 'file',
      format: 'md',
      mimeType: 'text/markdown',
      fileName,
      path: outputPath,
    });
  }

  if (formats.includes('pdf')) {
    const fileName = `${baseName}.pdf`;
    const outputPath = path.join(REPORTS_DIR, fileName);
    await renderMarkdownPdfToFile({
      title: draft.title || markdownTitle(markdown),
      markdown,
      outputPath,
    });
    outputs.push({
      type: 'file',
      format: 'pdf',
      mimeType: 'application/pdf',
      fileName,
      path: outputPath,
    });
  }

  return {
    ok: true,
    summary: `已导出 ${outputs.length} 份报告文件。`,
    outputs,
  };
};
