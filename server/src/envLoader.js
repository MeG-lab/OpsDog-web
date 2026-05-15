import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = process.cwd();

const parseEnvFile = (raw) => {
  const parsed = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value.replace(/\\n/g, '\n');
  }
  return parsed;
};

export const loadDotEnv = (fileName = '.env') => {
  const filePath = path.join(APP_ROOT, fileName);
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseEnvFile(raw);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return parsed;
  } catch {
    return {};
  }
};
