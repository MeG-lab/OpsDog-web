import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const BACKEND_HOST = '127.0.0.1';
export const BACKEND_PORT = 8788;
export const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

export const ensureBackendPortAvailable = ({
  host = BACKEND_HOST,
  port = BACKEND_PORT,
  createServer = net.createServer,
} = {}) => new Promise((resolve, reject) => {
  const probe = createServer();

  probe.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      reject(new Error(`OpsDog 无法启动：本地端口 ${port} 已被占用，请关闭占用该端口的程序后重试。`));
      return;
    }
    reject(error);
  });

  probe.once('listening', () => {
    probe.close(resolve);
  });

  probe.listen({ host, port, exclusive: true });
});

export const waitForBackendHealth = async ({
  origin = BACKEND_ORIGIN,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  intervalMs = 100,
} = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const response = await fetchImpl(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Startup polling tolerates connection failures until the timeout expires.
    }

    await delay(intervalMs);
  }

  throw new Error(`OpsDog 后端未能在 ${timeoutMs}ms 内启动，请重启应用后重试。`);
};

export const startBackendProcess = async ({
  runtimeRoot,
  serverEntry,
  platform = process.platform,
  forkProcess,
  onLog = () => undefined,
  ensurePortAvailable = ensureBackendPortAvailable,
  waitUntilHealthy = waitForBackendHealth,
}) => {
  await ensurePortAvailable();

  const child = forkProcess(serverEntry, [], {
    cwd: runtimeRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      OPSDOG_SERVER_ORIGIN: BACKEND_ORIGIN,
      ...(platform === 'win32' ? { ASSET_API_MODE: 'local' } : {}),
    },
  });

  child.stdout?.on('data', (data) => onLog(String(data)));
  child.stderr?.on('data', (data) => onLog(String(data)));

  try {
    await waitUntilHealthy();
  } catch (error) {
    child.kill();
    throw error;
  }

  return child;
};

export const stopBackendProcess = (child) => {
  if (child) child.kill();
};

