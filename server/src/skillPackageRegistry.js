import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APP_ROOT = process.cwd();
const TOOLS_ROOT = path.join(APP_ROOT, 'tools');
const SKILL_PACKAGES_ROOT = path.join(TOOLS_ROOT, 'skill-packages');
const IMPORTS_ROOT = path.join(APP_ROOT, 'server', 'data', 'skill-package-imports');
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_INSTRUCTION_CHARS = 24000;
const PYTHON_BIN = process.env.PYTHON || process.env.PYTHON3 || 'python3';
const BUILTIN_SKILL_PACKAGE_IDS = new Set(['aliyun-voice-notify']);

const nowIso = () => new Date().toISOString();

const execFileAsync = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

const ensureDirectory = async (directory) => {
  await mkdir(directory, { recursive: true });
};

const pathExists = async (targetPath) => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const toPosixRelative = (absolutePath) => path.relative(APP_ROOT, absolutePath).split(path.sep).join(path.posix.sep);

const normalizeId = (value) =>
  String(value || '')
    .trim()
    .replace(/\.zip$/i, '')
    .replace(/\.py$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

const isBuiltinSkillPackageId = (skillId) => BUILTIN_SKILL_PACKAGE_IDS.has(normalizeId(skillId));

const decorateSkillPackageRecord = (record) => {
  const id = normalizeId(record?.id) || String(record?.id || '');
  const builtin = Boolean(record?.builtin) || isBuiltinSkillPackageId(id);
  return {
    ...record,
    id,
    builtin,
    protected: Boolean(record?.protected) || builtin,
  };
};

const flagToKey = (flag) => String(flag || '').replace(/^--?/, '').replace(/-/g, '_');

const clip = (text, max = MAX_INSTRUCTION_CHARS) => {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}\n...（内容过长，已截断）` : value;
};

const stripMarkdownFrontmatter = (content) => {
  const text = String(content || '');
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text };
  const raw = text.slice(3, end).trim();
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const matched = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!matched) continue;
    frontmatter[matched[1]] = matched[2].replace(/^["']|["']$/g, '').trim();
  }
  return { frontmatter, body: text.slice(end + 4).trim() };
};

const firstMarkdownHeading = (content) => {
  const matched = String(content || '').match(/^#\s+(.+)$/m);
  return matched?.[1]?.trim() || '';
};

const walkFiles = async (root, prefix = '') => {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const rel = path.posix.join(prefix.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.name === 'opsdog' || entry.name === '__MACOSX' || entry.name === '__pycache__') continue;
    if (entry.name === '.DS_Store' || entry.name.endsWith('.pyc')) continue;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, rel.split(path.posix.sep).join(path.sep)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
};

const readTextIfExists = async (filePath, maxBytes = 256 * 1024) => {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > maxBytes) return '';
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
};

const extractZipSafely = async (zipPath, destination) => {
  const script = String.raw`
import json
import os
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

zip_path = Path(sys.argv[1])
dest = Path(sys.argv[2]).resolve()
dest.mkdir(parents=True, exist_ok=True)
max_files = 1000
max_total = 200 * 1024 * 1024
total = 0
count = 0
skipped = []
extracted = []

def reject(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(2)

with zipfile.ZipFile(zip_path) as zf:
    infos = zf.infolist()
    if not infos:
        reject("zip 包为空。")
    for info in infos:
        raw_name = info.filename.replace("\\", "/")
        if not raw_name or raw_name.endswith("/"):
            continue
        if raw_name.startswith("/") or re.match(r"^[A-Za-z]:", raw_name):
            reject(f"zip 包含不安全路径：{info.filename}")
        parts = [p for p in PurePosixPath(raw_name).parts if p not in ("", ".")]
        if not parts or any(p == ".." for p in parts):
            reject(f"zip 包含路径穿越：{info.filename}")
        if "__MACOSX" in parts or "__pycache__" in parts or parts[-1] == ".DS_Store" or parts[-1].endswith(".pyc"):
            skipped.append(raw_name)
            continue
        count += 1
        total += int(info.file_size or 0)
        if count > max_files:
            reject("zip 文件数量过多。")
        if total > max_total:
            reject("zip 解压后体积过大。")
        target = dest.joinpath(*parts).resolve()
        if not str(target).startswith(str(dest) + os.sep):
            reject(f"zip 包含不安全目标路径：{info.filename}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, target.open("wb") as out:
            out.write(src.read())
        extracted.append(raw_name)

print(json.dumps({"ok": True, "extracted": extracted, "skipped": skipped, "totalBytes": total}, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync(PYTHON_BIN, ['-c', script, zipPath, destination]);
  const result = JSON.parse(stdout.trim() || '{}');
  if (!result.ok) {
    throw new Error(result.error || 'zip 解压失败。');
  }
  return result;
};

const resolvePackageRoot = async (unpackedDir) => {
  const entries = await readdir(unpackedDir, { withFileTypes: true });
  const realEntries = entries.filter((entry) => !['__MACOSX', '.DS_Store'].includes(entry.name));
  if (realEntries.length === 1 && realEntries[0].isDirectory()) {
    return path.join(unpackedDir, realEntries[0].name);
  }
  return unpackedDir;
};

const parseRequirements = (content) =>
  String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('#'));

const parseEnvExample = (content) =>
  Array.from(new Set(String(content || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/)?.[1])
    .filter(Boolean)));

const extractEnvVarsFromPython = (content) =>
  Array.from(new Set(Array.from(String(content || '').matchAll(/os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g)).map((item) => item[1])));

const parsePythonArgparseTools = (content, relativeEntry, skillId) => {
  const tools = [];
  const subParserRegex = /(\w+)\s*=\s*\w+\.add_parser\(\s*["']([^"']+)["'](?:\s*,\s*help\s*=\s*["']([^"']+)["'])?/g;
  let matched;
  while ((matched = subParserRegex.exec(content))) {
    const variableName = matched[1];
    const command = matched[2];
    const helpText = matched[3] || `${command} action`;
    const properties = {};
    const required = [];
    const argv = [{ kind: 'positional', value: command }];
    const argRegex = new RegExp(`${variableName}\\.add_argument\\(([\\s\\S]*?)\\)`, 'g');
    let argMatched;
    while ((argMatched = argRegex.exec(content))) {
      const raw = argMatched[1];
      const flag = raw.match(/["'](--[^"']+)["']/)?.[1];
      if (!flag) continue;
      const key = flagToKey(flag);
      const help = raw.match(/help\s*=\s*["']([^"']+)["']/)?.[1] || key;
      const type = /type\s*=\s*int/.test(raw) ? 'integer' : /type\s*=\s*float/.test(raw) ? 'number' : 'string';
      const isRequired = /required\s*=\s*True/.test(raw);
      properties[key] = { type, description: help };
      if (isRequired) required.push(key);
      argv.push({ source: key, flag, kind: 'value' });
    }
    tools.push({
      name: command,
      description: helpText,
      inputSchema: {
        type: 'object',
        properties,
        required,
        additionalProperties: true,
      },
      execution: 'oneshot',
      outputMode: 'plain-text',
      entry: relativeEntry,
      adapter: {
        argv,
        passthroughArgs: false,
        stdinMode: 'none',
        stdoutMode: 'plain-text',
        stderrMode: 'text',
      },
      requiredEnv: [],
    });
  }

  if (tools.length === 0) {
    tools.push({
      name: normalizeId(skillId) || 'run',
      description: `运行 ${path.basename(relativeEntry)}`,
      inputSchema: {
        type: 'object',
        properties: {
          args: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
      execution: 'oneshot',
      outputMode: 'plain-text',
      entry: relativeEntry,
      adapter: {
        passthroughArgs: true,
        stdinMode: 'none',
        stdoutMode: 'plain-text',
        stderrMode: 'text',
      },
      requiredEnv: [],
    });
  }

  return tools;
};

const inferPermissions = ({ dependencies, pythonText, readmeText, manifest }) => {
  if (manifest?.permissions) return manifest.permissions;
  const haystack = `${dependencies.join('\n')}\n${pythonText}\n${readmeText}`.toLowerCase();
  return {
    network: /http|request|aliyun|alibabacloud|openai|socket|api/.test(haystack),
    filesystem: 'package-only',
  };
};

const buildRecordFromPackage = async ({ fileName, packageRoot, importId, installPath = '' }) => {
  const files = await walkFiles(packageRoot);
  const skillJsonFile = files.find((file) => path.basename(file).toLowerCase() === 'skill.json');
  const skillJson = skillJsonFile ? JSON.parse(await readFile(path.join(packageRoot, skillJsonFile), 'utf8')) : null;
  const skillMdFile = files.find((file) => path.basename(file).toLowerCase() === 'skill.md');
  const readmeFile = files.find((file) => /^readme\.md$/i.test(path.basename(file)));
  const skillMd = skillMdFile ? await readTextIfExists(path.join(packageRoot, skillMdFile)) : '';
  const readme = readmeFile ? await readTextIfExists(path.join(packageRoot, readmeFile)) : '';
  const { frontmatter, body: skillBody } = stripMarkdownFrontmatter(skillMd);
  const requirementFiles = files.filter((file) => path.basename(file).toLowerCase() === 'requirements.txt');
  const dependencies = Array.from(new Set([
    ...(Array.isArray(skillJson?.dependencies) ? skillJson.dependencies.map(String) : []),
    ...parseRequirements(requirementFiles[0] ? await readTextIfExists(path.join(packageRoot, requirementFiles[0])) : ''),
  ]));
  const envFiles = files.filter((file) => path.basename(file).toLowerCase() === '.env.example');
  const envVars = Array.from(new Set((await Promise.all(envFiles.map((file) => readTextIfExists(path.join(packageRoot, file)))))
    .flatMap(parseEnvExample)));
  const pythonFiles = files.filter((file) => file.toLowerCase().endsWith('.py'));
  const pythonTexts = await Promise.all(pythonFiles.map(async (file) => ({
    file,
    content: await readTextIfExists(path.join(packageRoot, file), 512 * 1024),
  })));
  const pythonEnvVars = pythonTexts.flatMap((item) => extractEnvVarsFromPython(item.content));
  const requiredEnv = Array.from(new Set([...envVars, ...pythonEnvVars]));

  const manifestName = skillJson?.name || frontmatter.name || firstMarkdownHeading(skillMd) || path.basename(fileName, '.zip');
  const id = normalizeId(skillJson?.id || frontmatter.name || manifestName || path.basename(fileName, '.zip')) || `skill-${importId}`;
  const description = String(skillJson?.description || frontmatter.description || frontmatter.summary || firstMarkdownHeading(readme) || '').trim();
  const manifestSource = skillJson ? 'skill.json' : 'generated';
  const selectedPython = pythonTexts.find((item) => /argparse|add_parser|add_argument/.test(item.content)) || pythonTexts[0];
  const manifestTools = Array.isArray(skillJson?.tools)
    ? skillJson.tools.map((tool, index) => ({
        name: String(tool.name || `${id}_${index + 1}`),
        description: String(tool.description || description || tool.name || ''),
        inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
        execution: tool.execution || 'oneshot',
        outputMode: tool.outputMode || 'plain-text',
        entry: tool.entry || skillJson.entry || '',
        adapter: tool.adapter || { passthroughArgs: true, stdinMode: 'none', stdoutMode: 'plain-text', stderrMode: 'text' },
        requiredEnv,
      }))
    : [];
  const generatedTools = selectedPython
    ? parsePythonArgparseTools(selectedPython.content, selectedPython.file, id).map((tool) => ({ ...tool, requiredEnv }))
    : [];
  const tools = manifestTools.length > 0 ? manifestTools : generatedTools;
  const kind = tools.length > 0 ? 'executable' : 'instruction-only';
  const instructionText = clip([
    skillMd ? `# SKILL.md\n${skillBody || skillMd}` : '',
    readme ? `# README.md\n${readme}` : '',
  ].filter(Boolean).join('\n\n'));
  const permissions = inferPermissions({
    dependencies,
    pythonText: pythonTexts.map((item) => item.content).join('\n'),
    readmeText: `${skillMd}\n${readme}`,
    manifest: skillJson,
  });
  const serverIds = kind === 'executable' ? [`skillpkg_${id}`] : [];
  const now = nowIso();

  return decorateSkillPackageRecord({
    importId,
    id,
    name: String(manifestName || id),
    version: String(skillJson?.version || '0.1.0'),
    description: description || (kind === 'instruction-only' ? '外部 Skill 文档能力。' : '外部 Skill 可执行能力。'),
    enabled: true,
    kind,
    installPath,
    manifestSource,
    tools,
    permissions,
    dependencies,
    dependencyFiles: requirementFiles,
    dependencyStatus: dependencies.length > 0 ? 'pending' : 'none',
    dependencyLog: '',
    serverIds,
    instructionFiles: [skillMdFile, readmeFile].filter(Boolean),
    instructionText,
    requiredEnv,
    warnings: [
      ...(skillJson ? [] : ['未找到 skill.json，已根据 SKILL.md/README/Python 脚本生成 OpsDog manifest。']),
      ...(kind === 'instruction-only' ? ['未检测到可执行入口，将作为模型上下文 Skill 使用。'] : []),
      ...(dependencies.length > 0 ? ['检测到 Python 依赖，需用户确认后安装。'] : []),
    ],
    createdAt: now,
    updatedAt: now,
  });
};

const writeOpsdogFiles = async (installDir, record, sourceZipPath) => {
  const opsdogDir = path.join(installDir, 'opsdog');
  await ensureDirectory(opsdogDir);
  const manifest = decorateSkillPackageRecord({ ...record, installPath: toPosixRelative(installDir) });
  await writeFile(path.join(opsdogDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(opsdogDir, 'analysis.json'), JSON.stringify({
    generatedAt: nowIso(),
    manifestSource: record.manifestSource,
    warnings: record.warnings || [],
    instructionFiles: record.instructionFiles,
    dependencyFiles: record.dependencyFiles,
    requiredEnv: record.requiredEnv,
  }, null, 2), 'utf8');
  if (record.kind === 'executable') {
    await writeFile(path.join(opsdogDir, 'server.json'), JSON.stringify(await buildServerDefinition(record), null, 2), 'utf8');
  }
  if (sourceZipPath) {
    await cp(sourceZipPath, path.join(opsdogDir, 'source.zip'));
  }
  return manifest;
};

const readInstalledRecord = async (skillId) => {
  const manifestPath = path.join(SKILL_PACKAGES_ROOT, skillId, 'opsdog', 'manifest.json');
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  return decorateSkillPackageRecord({
    ...parsed,
    installPath: parsed.installPath || toPosixRelative(path.join(SKILL_PACKAGES_ROOT, skillId)),
  });
};

const writeInstalledRecord = async (record) => {
  const installDir = path.join(APP_ROOT, record.installPath || path.join('tools', 'skill-packages', record.id));
  const manifestPath = path.join(installDir, 'opsdog', 'manifest.json');
  const next = decorateSkillPackageRecord({ ...record, updatedAt: nowIso() });
  await writeFile(manifestPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
};

export const previewSkillPackage = async ({ fileName, fileContentBase64 }) => {
  if (!String(fileName || '').toLowerCase().endsWith('.zip')) {
    throw new Error('当前仅支持上传 zip 格式 Skill 包。');
  }
  const buffer = Buffer.from(String(fileContentBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('Skill 包内容为空。');
  if (buffer.length > MAX_ZIP_BYTES) throw new Error('Skill 包超过大小限制。');

  const importId = randomUUID();
  const importDir = path.join(IMPORTS_ROOT, importId);
  const unpackedDir = path.join(importDir, 'unpacked');
  const zipPath = path.join(importDir, 'upload.zip');
  await ensureDirectory(importDir);
  await writeFile(zipPath, buffer);
  const extractResult = await extractZipSafely(zipPath, unpackedDir);
  const packageRoot = await resolvePackageRoot(unpackedDir);
  const record = await buildRecordFromPackage({ fileName, packageRoot, importId });
  await writeFile(path.join(importDir, 'preview.json'), JSON.stringify({
    ...record,
    sourceRoot: packageRoot,
    sourceZipPath: zipPath,
    extractResult,
  }, null, 2), 'utf8');
  return record;
};

export const installSkillPackage = async (importId) => {
  const importDir = path.join(IMPORTS_ROOT, importId);
  const previewPath = path.join(importDir, 'preview.json');
  const preview = JSON.parse(await readFile(previewPath, 'utf8'));
  const skillId = normalizeId(preview.id);
  if (!skillId) throw new Error('Skill 包 ID 不合法。');
  const installDir = path.join(SKILL_PACKAGES_ROOT, skillId);
  if (await pathExists(installDir)) {
    throw new Error(`Skill 包已存在：${skillId}`);
  }
  await ensureDirectory(SKILL_PACKAGES_ROOT);
  await cp(preview.sourceRoot, installDir, { recursive: true });
  const record = {
    ...preview,
    id: skillId,
    installPath: toPosixRelative(installDir),
    sourceRoot: undefined,
    sourceZipPath: undefined,
    extractResult: undefined,
    updatedAt: nowIso(),
  };
  const saved = await writeOpsdogFiles(installDir, decorateSkillPackageRecord(record), preview.sourceZipPath);
  await rm(importDir, { recursive: true, force: true }).catch(() => {});
  return saved;
};

export const listSkillPackages = async () => {
  await ensureDirectory(SKILL_PACKAGES_ROOT);
  const entries = await readdir(SKILL_PACKAGES_ROOT, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      records.push(await readInstalledRecord(entry.name));
    } catch {
      // Ignore malformed package directories.
    }
  }
  return records.sort((left, right) => String(left.name).localeCompare(String(right.name)));
};

export const updateSkillPackage = async (skillId, updates = {}) => {
  const normalizedId = normalizeId(skillId);
  const current = await readInstalledRecord(normalizedId);
  const next = {
    ...current,
    enabled: typeof updates.enabled === 'boolean' ? updates.enabled : current.enabled,
    description: typeof updates.description === 'string' ? updates.description.trim() : current.description,
  };
  return await writeInstalledRecord(next);
};

export const deleteSkillPackage = async (skillId) => {
  const normalizedId = normalizeId(skillId);
  if (!normalizedId) throw new Error('Skill 包 ID 不能为空。');
  if (isBuiltinSkillPackageId(normalizedId)) {
    throw new Error('内置 Skill 包不能删除，可在 Skill 包面板停用。');
  }
  await rm(path.join(SKILL_PACKAGES_ROOT, normalizedId), { recursive: true, force: true });
};

const getVenvPaths = (installDir) => {
  const venvDir = path.join(installDir, '.venv');
  if (process.platform === 'win32') {
    return {
      venvDir,
      python: path.join(venvDir, 'Scripts', 'python.exe'),
      pip: path.join(venvDir, 'Scripts', 'pip.exe'),
    };
  }
  return {
    venvDir,
    python: path.join(venvDir, 'bin', 'python'),
    pip: path.join(venvDir, 'bin', 'pip'),
  };
};

export const installSkillPackageDependencies = async (skillId) => {
  const record = await readInstalledRecord(normalizeId(skillId));
  if (!record.dependencies?.length) {
    return await writeInstalledRecord({ ...record, dependencyStatus: 'none', dependencyLog: '没有需要安装的依赖。' });
  }
  const installDir = path.join(APP_ROOT, record.installPath);
  const requirementFile = record.dependencyFiles?.[0];
  if (!requirementFile) {
    throw new Error('未找到 requirements.txt。');
  }
  const requirementsPath = path.join(installDir, requirementFile);
  const venv = getVenvPaths(installDir);
  let log = '';
  try {
    const created = await execFileAsync(PYTHON_BIN, ['-m', 'venv', venv.venvDir], { cwd: installDir });
    log += created.stdout + created.stderr;
    const installed = await execFileAsync(venv.pip, ['install', '-r', requirementsPath], { cwd: installDir });
    log += installed.stdout + installed.stderr;
    return await writeInstalledRecord({ ...record, dependencyStatus: 'installed', dependencyLog: clip(log, 16000) });
  } catch (error) {
    log += `${error.stdout || ''}${error.stderr || ''}${error.message || String(error)}`;
    await writeInstalledRecord({ ...record, dependencyStatus: 'failed', dependencyLog: clip(log, 16000) });
    throw new Error(`依赖安装失败：${error.message || String(error)}`);
  }
};

const getRuntimeForRecord = async (record) => {
  if (record.dependencyStatus !== 'installed') return PYTHON_BIN;
  const installDir = path.join(APP_ROOT, record.installPath);
  const venv = getVenvPaths(installDir);
  return await pathExists(venv.python) ? venv.python : PYTHON_BIN;
};

export const buildServerDefinition = async (record) => {
  const normalizedRecord = decorateSkillPackageRecord(record);
  const primaryEntry = normalizedRecord.tools?.[0]?.entry;
  const installDir = path.join(APP_ROOT, normalizedRecord.installPath || path.join('tools', 'skill-packages', normalizedRecord.id));
  return {
    id: `skillpkg_${normalizedRecord.id}`,
    name: normalizedRecord.name,
    category: 'instant',
    type: 'python-script',
    runtime: await getRuntimeForRecord(normalizedRecord),
    transport: 'stdio',
    entry: primaryEntry ? toPosixRelative(path.join(installDir, primaryEntry)) : '',
    description: normalizedRecord.description,
    enabled: normalizedRecord.enabled !== false,
    createdAt: normalizedRecord.createdAt || nowIso(),
    updatedAt: normalizedRecord.updatedAt || nowIso(),
    connection: {},
    capabilities: {
      tools: (normalizedRecord.tools || []).map((tool, index) => ({
        name: tool.name,
        description: tool.description || normalizedRecord.description,
        inputSchema: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
        outputMode: tool.outputMode || 'plain-text',
        execution: tool.execution || 'oneshot',
        schemaSource: 'server-metadata',
        isDefault: index === 0,
        adapter: tool.adapter,
      })),
      protocol: {
        mode: 'cli-adapter',
        version: 1,
        io: { stdin: 'optional-json', stdout: 'plain-text-or-json', stderr: 'text' },
      },
      adapter: normalizedRecord.tools?.[0]?.adapter,
      schemaSource: 'server-metadata',
      usageExamples: normalizedRecord.instructionText ? [clip(normalizedRecord.instructionText, 1200)] : [],
      skillPackageId: normalizedRecord.id,
      skillPackageKind: normalizedRecord.kind,
      skillPackageBuiltin: normalizedRecord.builtin === true,
      skillPackageProtected: normalizedRecord.protected === true,
      dependencyStatus: normalizedRecord.dependencyStatus,
      dependencyRequired: Array.isArray(normalizedRecord.dependencies) && normalizedRecord.dependencies.length > 0,
      workingDirectory: toPosixRelative(installDir),
      recentLogs: [],
    },
  };
};

export const listSkillPackageServerDefinitions = async () => {
  const packages = await listSkillPackages();
  const enabledExecutable = packages.filter((record) => record.enabled !== false && record.kind === 'executable' && record.tools?.length);
  return await Promise.all(enabledExecutable.map(buildServerDefinition));
};
