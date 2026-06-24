import { access, copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER_FILE = '.opsdog-runtime-v1';
const EMPTY_ASSET_FILES = {
  'device.merged.json': {
    generatedAt: null,
    total: 0,
    items: [],
  },
  'device.meta.json': {
    items: [],
  },
  'device.remote.json': {
    code: 0,
    data: [],
    msg: '',
  },
  'device.status.json': {
    items: [],
  },
  'devices.local.json': {
    devices: [],
  },
};

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const replaceDirectory = async (sourcePath, destinationPath) => {
  await rm(destinationPath, { recursive: true, force: true });
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
};

const copyInitialTools = async (sourceRoot, runtimeRoot) => {
  const sourceToolsPath = path.join(sourceRoot, 'tools');
  if (!(await exists(sourceToolsPath))) return;

  await cp(sourceToolsPath, path.join(runtimeRoot, 'tools'), {
    recursive: true,
    filter: (sourcePath) => {
      const relativeParts = path.relative(sourceToolsPath, sourcePath).split(path.sep);
      return !relativeParts.some((part) => (
        part === '.DS_Store' || part === '.venv' || part === '.env' || part.startsWith('.env.')
      ));
    },
  });
};

const initializeWritableData = async (sourceRoot, runtimeRoot) => {
  const runtimeDataRoot = path.join(runtimeRoot, 'server/data');
  const runtimeAssets = path.join(runtimeDataRoot, 'assets');

  await Promise.all([
    mkdir(runtimeAssets, { recursive: true }),
    mkdir(path.join(runtimeDataRoot, 'mcp'), { recursive: true }),
    mkdir(path.join(runtimeDataRoot, 'servers'), { recursive: true }),
    mkdir(path.join(runtimeDataRoot, 'reports'), { recursive: true }),
    mkdir(path.join(runtimeDataRoot, 'ticketing'), { recursive: true }),
  ]);

  await Promise.all(Object.entries(EMPTY_ASSET_FILES).map(([fileName, content]) => (
    writeFile(path.join(runtimeAssets, fileName), `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  )));

  await copyFile(
    path.join(sourceRoot, 'server/data/mcp-market.json'),
    path.join(runtimeDataRoot, 'mcp-market.json'),
  );
  await Promise.all([
    writeFile(path.join(runtimeDataRoot, 'ticketing/asset-mappings.json'), '[]\n', 'utf8'),
    writeFile(path.join(runtimeDataRoot, 'ticketing/ticket-records.json'), '[]\n', 'utf8'),
    copyInitialTools(sourceRoot, runtimeRoot),
  ]);
  await writeFile(path.join(runtimeRoot, MARKER_FILE), 'initialized\n', 'utf8');
};

export const prepareRuntimeWorkspace = async ({ sourceRoot, runtimeRoot }) => {
  await mkdir(runtimeRoot, { recursive: true });
  await Promise.all([
    replaceDirectory(path.join(sourceRoot, 'dist'), path.join(runtimeRoot, 'dist')),
    writeFile(path.join(runtimeRoot, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8'),
  ]);

  if (!(await exists(path.join(runtimeRoot, MARKER_FILE)))) {
    await initializeWritableData(sourceRoot, runtimeRoot);
  }

  return runtimeRoot;
};
