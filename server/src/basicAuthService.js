import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HASH_ITERATIONS = 120000;
const HASH_KEY_LENGTH = 32;
const HASH_DIGEST = 'sha256';
const DEFAULT_AUTH_FILE_PATH = path.resolve(process.cwd(), 'server/data/opsdog/auth.json');
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'opsDog2026!!';

const safeStringEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const hashPassword = (password, salt) =>
  pbkdf2Sync(String(password), String(salt), HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_DIGEST).toString('base64');

const buildPasswordRecord = (username, password) => {
  const salt = randomBytes(18).toString('base64');
  return {
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    iterations: HASH_ITERATIONS,
    digest: HASH_DIGEST,
    updatedAt: new Date().toISOString(),
  };
};

const parseBasicAuthorization = (authorization) => {
  const header = String(authorization || '');
  if (!header.startsWith('Basic ')) return null;

  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) return null;

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
};

export const createBasicAuthService = ({
  authFilePath = DEFAULT_AUTH_FILE_PATH,
  defaultUsername = process.env.OPSDOG_BASIC_AUTH_USERNAME || DEFAULT_USERNAME,
  defaultPassword = process.env.OPSDOG_BASIC_AUTH_PASSWORD || DEFAULT_PASSWORD,
} = {}) => {
  const readLocalRecord = () => {
    if (!existsSync(authFilePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(authFilePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.username || !parsed.salt || !parsed.passwordHash) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const verifyPassword = (password) => {
    const localRecord = readLocalRecord();
    if (!localRecord) return safeStringEqual(password, defaultPassword);

    const digest = localRecord.digest || HASH_DIGEST;
    const iterations = Number(localRecord.iterations || HASH_ITERATIONS);
    const calculated = pbkdf2Sync(
      String(password),
      String(localRecord.salt),
      iterations,
      HASH_KEY_LENGTH,
      digest,
    ).toString('base64');

    return safeStringEqual(calculated, localRecord.passwordHash);
  };

  const currentUsername = () => readLocalRecord()?.username || defaultUsername;

  const writeLocalRecord = (password) => {
    mkdirSync(path.dirname(authFilePath), { recursive: true });
    const record = buildPasswordRecord(currentUsername(), password);
    writeFileSync(authFilePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  };

  return {
    isAuthorizationValid(authorization) {
      const credentials = parseBasicAuthorization(authorization);
      if (!credentials) return false;
      return safeStringEqual(credentials.username, currentUsername()) && verifyPassword(credentials.password);
    },

    changePassword(payload) {
      const currentPassword = String(payload?.currentPassword || '');
      const newPassword = String(payload?.newPassword || '');

      if (!currentPassword || !newPassword) {
        return { ok: false, statusCode: 400, message: '当前密码和新密码不能为空。' };
      }
      if (newPassword.length < 8) {
        return { ok: false, statusCode: 400, message: '新密码至少需要 8 位。' };
      }
      if (!verifyPassword(currentPassword)) {
        return { ok: false, statusCode: 401, message: '当前密码不正确。' };
      }

      writeLocalRecord(newPassword);
      return { ok: true };
    },
  };
};
