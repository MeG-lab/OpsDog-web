import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const HASH_ITERATIONS = 120000;
const HASH_KEY_LENGTH = 32;
const HASH_DIGEST = 'sha256';
const DEFAULT_AUTH_FILE_PATH = path.resolve(process.cwd(), 'server/data/opsdog/auth.json');
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'opsDog2026!!';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const safeStringEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeUsername = (username) => String(username || '').trim();

const hashPassword = ({
  password,
  salt,
  iterations = HASH_ITERATIONS,
  digest = HASH_DIGEST,
}) => pbkdf2Sync(String(password), String(salt), Number(iterations), HASH_KEY_LENGTH, digest).toString('base64');

const hashSessionToken = (token) =>
  createHash('sha256').update(String(token)).digest('base64');

const toIso = (value) => value instanceof Date ? value.toISOString() : String(value);

const readLegacyAuthRecord = (authFilePath) => {
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

const publicUser = (row) => row ? ({
  id: row.id,
  username: row.username,
  enabled: Boolean(row.enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at || null,
}) : null;

export const createAppAuthService = ({
  database,
  authFilePath = DEFAULT_AUTH_FILE_PATH,
  defaultUsername = process.env.OPSDOG_BASIC_AUTH_USERNAME || DEFAULT_USERNAME,
  defaultPassword = process.env.OPSDOG_BASIC_AUTH_PASSWORD || DEFAULT_PASSWORD,
  now = () => new Date().toISOString(),
  createId = (prefix) => `${prefix}-${randomUUID()}`,
  createSessionToken = () => randomBytes(32).toString('base64url'),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
} = {}) => {
  if (!database) throw new Error('database is required');

  const currentTime = () => toIso(now());

  const buildPasswordRecord = (password) => {
    const salt = randomBytes(18).toString('base64');
    return {
      salt,
      passwordHash: hashPassword({ password, salt }),
      iterations: HASH_ITERATIONS,
      digest: HASH_DIGEST,
    };
  };

  const insertUser = ({ username, password, enabled = true }) => {
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername) throw new Error('用户名不能为空。');
    if (String(password || '').length < 8) throw new Error('密码至少需要 8 位。');

    const existing = database.get('SELECT id FROM users WHERE username = ?', cleanUsername);
    if (existing) throw new Error('用户名已存在。');

    const passwordRecord = buildPasswordRecord(password);
    const timestamp = currentTime();
    const id = createId('user');
    database.run(`
      INSERT INTO users
        (id, username, salt, password_hash, iterations, digest, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, cleanUsername, passwordRecord.salt, passwordRecord.passwordHash,
    passwordRecord.iterations, passwordRecord.digest, enabled ? 1 : 0, timestamp, timestamp);

    return publicUser(database.get('SELECT * FROM users WHERE id = ?', id));
  };

  const verifyUserPassword = (row, password) => {
    if (!row) return false;
    const calculated = hashPassword({
      password,
      salt: row.salt,
      iterations: row.iterations,
      digest: row.digest,
    });
    return safeStringEqual(calculated, row.password_hash);
  };

  const replacePassword = (userId, newPassword) => {
    if (String(newPassword || '').length < 8) {
      return { ok: false, statusCode: 400, message: '新密码至少需要 8 位。' };
    }
    const row = database.get('SELECT id FROM users WHERE id = ?', userId);
    if (!row) return { ok: false, statusCode: 404, message: '账号不存在。' };

    const passwordRecord = buildPasswordRecord(newPassword);
    database.run(`
      UPDATE users
      SET salt = ?, password_hash = ?, iterations = ?, digest = ?, updated_at = ?
      WHERE id = ?
    `, passwordRecord.salt, passwordRecord.passwordHash, passwordRecord.iterations,
    passwordRecord.digest, currentTime(), userId);
    return { ok: true };
  };

  const countEnabledUsersExcluding = (userId) =>
    database.get('SELECT COUNT(*) AS count FROM users WHERE enabled = 1 AND id <> ?', userId).count;

  return {
    ensureSeedUser() {
      const existing = database.get('SELECT COUNT(*) AS count FROM users').count;
      if (existing > 0) return;

      const legacyRecord = readLegacyAuthRecord(authFilePath);
      const timestamp = currentTime();
      if (legacyRecord) {
        database.run(`
          INSERT INTO users
            (id, username, salt, password_hash, iterations, digest, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `, createId('user'), normalizeUsername(legacyRecord.username),
        String(legacyRecord.salt), String(legacyRecord.passwordHash),
        Number(legacyRecord.iterations || HASH_ITERATIONS), String(legacyRecord.digest || HASH_DIGEST),
        timestamp, timestamp);
        return;
      }

      insertUser({ username: defaultUsername, password: defaultPassword });
    },

    listUsers() {
      return database.all('SELECT * FROM users ORDER BY created_at ASC, username ASC').map(publicUser);
    },

    login(payload, meta = {}) {
      const username = normalizeUsername(payload?.username);
      const password = String(payload?.password || '');
      if (!username || !password) {
        return { ok: false, statusCode: 400, message: '用户名和密码不能为空。' };
      }

      const userRow = database.get('SELECT * FROM users WHERE username = ?', username);
      if (!userRow || !userRow.enabled || !verifyUserPassword(userRow, password)) {
        return { ok: false, statusCode: 401, message: '用户名或密码不正确。' };
      }

      const sessionToken = createSessionToken();
      const timestamp = currentTime();
      const expiresAt = new Date(Date.parse(timestamp) + sessionTtlMs).toISOString();
      database.run(`
        INSERT INTO sessions
          (id, user_id, token_hash, expires_at, user_agent, remote_address, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, createId('session'), userRow.id, hashSessionToken(sessionToken), expiresAt,
      String(meta.userAgent || ''), String(meta.remoteAddress || ''), timestamp, timestamp);
      database.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', timestamp, timestamp, userRow.id);

      return {
        ok: true,
        sessionToken,
        user: publicUser(database.get('SELECT * FROM users WHERE id = ?', userRow.id)),
      };
    },

    authenticateSessionToken(token) {
      if (!token) return null;
      const sessionRow = database.get(`
        SELECT
          sessions.*,
          users.username,
          users.enabled,
          users.created_at AS user_created_at,
          users.updated_at AS user_updated_at,
          users.last_login_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > ?
          AND users.enabled = 1
      `, hashSessionToken(token), currentTime());
      if (!sessionRow) return null;
      return {
        session: {
          id: sessionRow.id,
          userId: sessionRow.user_id,
          expiresAt: sessionRow.expires_at,
        },
        user: {
          id: sessionRow.user_id,
          username: sessionRow.username,
          enabled: true,
          createdAt: sessionRow.user_created_at,
          updatedAt: sessionRow.user_updated_at,
          lastLoginAt: sessionRow.last_login_at || null,
        },
      };
    },

    logout(token) {
      if (!token) return { ok: true };
      database.run(
        'UPDATE sessions SET revoked_at = ?, updated_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
        currentTime(),
        currentTime(),
        hashSessionToken(token),
      );
      return { ok: true };
    },

    createUser(payload) {
      return insertUser(payload || {});
    },

    updateUser(userId, patch = {}) {
      const row = database.get('SELECT * FROM users WHERE id = ?', userId);
      if (!row) throw new Error('账号不存在。');

      const updates = [];
      const values = [];
      if (Object.hasOwn(patch, 'username')) {
        const username = normalizeUsername(patch.username);
        if (!username) throw new Error('用户名不能为空。');
        const duplicate = database.get('SELECT id FROM users WHERE username = ? AND id <> ?', username, userId);
        if (duplicate) throw new Error('用户名已存在。');
        updates.push('username = ?');
        values.push(username);
      }
      if (Object.hasOwn(patch, 'enabled')) {
        const enabled = patch.enabled ? 1 : 0;
        if (row.enabled && !enabled && countEnabledUsersExcluding(userId) < 1) {
          throw new Error('至少保留一个启用账号。');
        }
        updates.push('enabled = ?');
        values.push(enabled);
      }
      if (!updates.length) return publicUser(row);

      updates.push('updated_at = ?');
      values.push(currentTime(), userId);
      database.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...values);
      return publicUser(database.get('SELECT * FROM users WHERE id = ?', userId));
    },

    resetUserPassword(userId, payload = {}) {
      const result = replacePassword(userId, payload.newPassword);
      if (!result.ok) throw new Error(result.message);
      return result;
    },

    changePassword(userId, payload = {}) {
      const currentPassword = String(payload.currentPassword || '');
      const newPassword = String(payload.newPassword || '');
      if (!currentPassword || !newPassword) {
        return { ok: false, statusCode: 400, message: '当前密码和新密码不能为空。' };
      }

      const row = database.get('SELECT * FROM users WHERE id = ?', userId);
      if (!row) return { ok: false, statusCode: 404, message: '账号不存在。' };
      if (!verifyUserPassword(row, currentPassword)) {
        return { ok: false, statusCode: 401, message: '当前密码不正确。' };
      }

      return replacePassword(userId, newPassword);
    },
  };
};
