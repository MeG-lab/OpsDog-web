import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const APP_ROOT = process.cwd();
const RUNTIME_TEMPLATE_DIR = path.join(APP_ROOT, '.desktop-runtime');

const copyDirectory = async (from, to, options = {}) => {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, ...options });
};

await rm(RUNTIME_TEMPLATE_DIR, { recursive: true, force: true });
await mkdir(RUNTIME_TEMPLATE_DIR, { recursive: true });

await Promise.all([
  copyDirectory(path.join(APP_ROOT, 'dist'), path.join(RUNTIME_TEMPLATE_DIR, 'dist')),
  copyDirectory(
    path.join(APP_ROOT, 'server/data/assets/templates'),
    path.join(RUNTIME_TEMPLATE_DIR, 'server/data/assets/templates'),
  ),
  copyDirectory(path.join(APP_ROOT, 'server/data/mcp-market.json'), path.join(RUNTIME_TEMPLATE_DIR, 'server/data/mcp-market.json')),
  copyDirectory(path.join(APP_ROOT, 'tools'), path.join(RUNTIME_TEMPLATE_DIR, 'tools'), {
    filter: (sourcePath) => {
      const relativeParts = path.relative(path.join(APP_ROOT, 'tools'), sourcePath).split(path.sep);
      return !relativeParts.some((part) => (
        part === '.DS_Store' || part === '.venv' || part === '.env' || part.startsWith('.env.')
      ));
    },
  }),
]);

process.stdout.write(`${RUNTIME_TEMPLATE_DIR}\n`);

