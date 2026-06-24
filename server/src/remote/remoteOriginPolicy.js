const normalizeOrigin = (origin) => {
  if (typeof origin !== 'string' || !origin.trim()) return null;
  try {
    return new URL(origin.trim()).origin;
  } catch {
    return null;
  }
};

const getOriginUrl = (origin) => {
  if (!origin) return null;
  try {
    return new URL(origin);
  } catch {
    return null;
  }
};

const normalizeRequestHost = (request) => {
  const host = String(request?.headers?.host || '').split(',')[0].trim().toLowerCase();
  return host || null;
};

const isSameHostBrowserOrigin = (origin, request) => {
  const originUrl = getOriginUrl(origin);
  const requestHost = normalizeRequestHost(request);
  return Boolean(originUrl && requestHost && originUrl.host.toLowerCase() === requestHost);
};

const buildForbiddenError = () => {
  const error = new Error('Remote browser origin is not allowed.');
  error.code = 'REMOTE_ORIGIN_FORBIDDEN';
  error.statusCode = 403;
  return error;
};

export const createRemoteOriginPolicy = ({ allowedOrigins = [] } = {}) => {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));

  const checkRequest = (request) => {
    const origin = normalizeOrigin(request?.headers?.origin);
    if (!origin) return { allowed: true, corsHeaders: {} };
    if (!allowed.has(origin) && !isSameHostBrowserOrigin(origin, request)) {
      return {
        allowed: false,
        code: 'REMOTE_ORIGIN_FORBIDDEN',
        corsHeaders: {},
      };
    }
    return {
      allowed: true,
      corsHeaders: {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
      },
    };
  };

  return {
    checkRequest,
    assertRequestAllowed(request) {
      const result = checkRequest(request);
      if (!result.allowed) throw buildForbiddenError();
      return result;
    },
  };
};
