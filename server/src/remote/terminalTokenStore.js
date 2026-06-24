import { randomUUID } from 'node:crypto';

const buildTokenError = () => {
  const error = new Error('Terminal connection token is invalid or expired.');
  error.code = 'TERMINAL_TOKEN_INVALID';
  error.statusCode = 401;
  return error;
};

const boundedInteger = (value, fallback, minimum, maximum) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
};

export const normalizeTerminalDimensions = ({ cols, rows } = {}) => ({
  cols: boundedInteger(cols, 80, 20, 500),
  rows: boundedInteger(rows, 24, 5, 200),
});

export const createTerminalTokenStore = ({
  now = () => Date.now(),
  createToken = () => randomUUID(),
  ttlMs = 30_000,
} = {}) => {
  const tokens = new Map();

  return {
    issue({ profileId, cols, rows }) {
      const token = createToken();
      const expiresAt = now() + ttlMs;
      const dimensions = normalizeTerminalDimensions({ cols, rows });
      tokens.set(token, {
        profileId: String(profileId || '').trim(),
        ...dimensions,
        expiresAt,
      });
      return {
        token,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    consume(token) {
      const value = tokens.get(token);
      tokens.delete(token);
      if (!value || value.expiresAt <= now()) throw buildTokenError();
      return {
        profileId: value.profileId,
        cols: value.cols,
        rows: value.rows,
      };
    },
  };
};
