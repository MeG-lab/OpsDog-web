const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:4173';
const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:8787';
const DEFAULT_API_BASE_URL = '/api';

const readValue = (env, key, fallback) => {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

const toUrl = (value, label) => {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL: ${value}`);
  }
};

export const getAppConfig = (env = process.env) => {
  const webOrigin = readValue(env, 'OPSDOG_WEB_ORIGIN', DEFAULT_WEB_ORIGIN);
  const serverOrigin = readValue(env, 'OPSDOG_SERVER_ORIGIN', DEFAULT_SERVER_ORIGIN);
  const apiBaseUrl = readValue(env, 'VITE_API_BASE_URL', DEFAULT_API_BASE_URL);

  const webUrl = toUrl(webOrigin, 'OPSDOG_WEB_ORIGIN');
  const serverUrl = toUrl(serverOrigin, 'OPSDOG_SERVER_ORIGIN');

  return {
    webOrigin: webUrl.origin,
    webHost: webUrl.hostname,
    webPort: Number(webUrl.port || (webUrl.protocol === 'https:' ? 443 : 80)),
    serverOrigin: serverUrl.origin,
    serverHost: serverUrl.hostname,
    serverPort: Number(serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80)),
    apiBaseUrl,
  };
};
