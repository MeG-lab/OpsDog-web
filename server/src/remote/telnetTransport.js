import { TextDecoder } from 'node:util';

const DEFAULT_TELNET_OPTIONS = {
  NAWS: 31,
  SGA: 3,
};

const buildTelnetError = (code, message, statusCode = 502) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const asText = (chunk) => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');

const socketsWithErrorSink = new WeakSet();

const stripReplacementCharacters = (text) => text.replace(/\uFFFD/g, '');

const utf8FatalDecoder = () => new TextDecoder('utf-8', { fatal: true });

const utf8SequenceLength = (byte) => {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
};

const incompleteUtf8TailLength = (buffer) => {
  if (!buffer.length) return 0;
  let continuationBytes = 0;
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const byte = buffer[index];
    if (byte >= 0x80 && byte <= 0xbf) {
      continuationBytes += 1;
      continue;
    }
    const expectedLength = utf8SequenceLength(byte);
    if (!expectedLength) return 0;
    const availableLength = continuationBytes + 1;
    return availableLength < expectedLength ? availableLength : 0;
  }
  return continuationBytes;
};

const decodeUtf8Strict = (buffer) => utf8FatalDecoder().decode(buffer);

const canDecodeUtf8 = (buffer) => {
  try {
    decodeUtf8Strict(buffer);
    return true;
  } catch {
    return false;
  }
};

const createTerminalDecoder = (encoding = 'auto') => {
  const requestedEncoding = String(encoding || 'auto').trim().toLowerCase();
  const gb18030Decoder = new TextDecoder('gb18030');
  let activeEncoding = requestedEncoding === 'gb18030' || requestedEncoding === 'gbk' || requestedEncoding === 'gb2312'
    ? 'gb18030'
    : 'utf-8';
  let pendingUtf8Bytes = Buffer.alloc(0);

  return (chunk) => {
    if (!Buffer.isBuffer(chunk)) return stripReplacementCharacters(String(chunk ?? ''));
    if (activeEncoding === 'gb18030') {
      return stripReplacementCharacters(gb18030Decoder.decode(chunk, { stream: true }));
    }
    const candidate = pendingUtf8Bytes.length ? Buffer.concat([pendingUtf8Bytes, chunk]) : chunk;
    try {
      const text = decodeUtf8Strict(candidate);
      pendingUtf8Bytes = Buffer.alloc(0);
      return stripReplacementCharacters(text);
    } catch {
      const tailLength = incompleteUtf8TailLength(candidate);
      if (tailLength > 0) {
        const prefix = candidate.subarray(0, candidate.length - tailLength);
        if (!prefix.length || canDecodeUtf8(prefix)) {
          pendingUtf8Bytes = candidate.subarray(candidate.length - tailLength);
          return prefix.length ? stripReplacementCharacters(decodeUtf8Strict(prefix)) : '';
        }
      }
      activeEncoding = 'gb18030';
      pendingUtf8Bytes = Buffer.alloc(0);
      return stripReplacementCharacters(gb18030Decoder.decode(candidate, { stream: true }));
    }
  };
};

const withTimeout = async (promise, timeoutMs, createError) => {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const removeListener = (emitter, eventName, listener) => {
  if (!emitter) return;
  if (typeof emitter.off === 'function') emitter.off(eventName, listener);
  else emitter.removeListener?.(eventName, listener);
};

const attachSocketErrorSink = (socket) => {
  if (!socket || socketsWithErrorSink.has(socket)) return;
  socket.on?.('error', () => {});
  socketsWithErrorSink.add(socket);
};

const enableTerminalChunkFlush = (socket) => {
  if (socket?.reader?.flushPolicy) {
    socket.reader.flushPolicy.endOfChunk = true;
  }
};

const waitForPattern = async (socket, pattern, timeoutMs, decode = asText) => await withTimeout(
  new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      removeListener(socket, 'data', onData);
      removeListener(socket, 'error', onError);
      removeListener(socket, 'close', onClose);
    };
    const onData = (chunk) => {
      buffer = `${buffer}${decode(chunk)}`.slice(-4096);
      if (pattern.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = () => {
      cleanup();
      reject(buildTelnetError('TELNET_LOGIN_FAILED', 'TELNET login failed.', 401));
    };
    const onClose = () => {
      cleanup();
      reject(buildTelnetError('TELNET_LOGIN_FAILED', 'TELNET login failed.', 401));
    };
    socket.on?.('data', onData);
    socket.once?.('error', onError);
    socket.once?.('close', onClose);
  }),
  timeoutMs,
  () => buildTelnetError('TELNET_LOGIN_FAILED', 'TELNET login timed out.', 401),
);

const waitForAnyData = async (socket, timeoutMs, decode = asText) => await withTimeout(
  new Promise((resolve, reject) => {
    const cleanup = () => {
      removeListener(socket, 'data', onData);
      removeListener(socket, 'error', onError);
      removeListener(socket, 'close', onClose);
    };
    const onData = (chunk) => {
      cleanup();
      resolve(decode(chunk));
    };
    const onError = () => {
      cleanup();
      reject(buildTelnetError('TELNET_LOGIN_FAILED', 'TELNET login failed.', 401));
    };
    const onClose = () => {
      cleanup();
      reject(buildTelnetError('TELNET_LOGIN_FAILED', 'TELNET login failed.', 401));
    };
    socket.once?.('data', onData);
    socket.once?.('error', onError);
    socket.once?.('close', onClose);
  }),
  timeoutMs,
  () => buildTelnetError('TELNET_LOGIN_FAILED', 'TELNET login timed out.', 401),
);

const loadTelnetRuntime = async (createConnection) => {
  if (createConnection) {
    return {
      createConnection,
      options: DEFAULT_TELNET_OPTIONS,
    };
  }
  const imported = await import('telnetlib');
  const telnetlib = imported.default || imported;
  return {
    createConnection: telnetlib.createConnection,
    options: telnetlib.options || DEFAULT_TELNET_OPTIONS,
  };
};

const connectSocket = async (profile, runtime) => {
  const timeoutMs = Number(profile.connectTimeoutMs || 10000);
  let socket = null;
  const connectionOptions = {
    host: profile.host,
    port: profile.port,
    localOptions: [runtime.options.NAWS, runtime.options.SGA],
    remoteOptions: [runtime.options.SGA],
  };
  const readyPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      removeListener(socket, 'connect', onConnect);
      removeListener(socket, 'negotiated', onNegotiated);
      removeListener(socket, 'error', onError);
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const onConnect = () => {
      finish();
    };
    const onNegotiated = () => {
      finish();
    };
    const onError = () => {
      cleanup();
      reject(buildTelnetError('TELNET_CONNECTION_FAILED', 'TELNET connection failed.'));
    };
    socket = runtime.createConnection(connectionOptions, onConnect);
    attachSocketErrorSink(socket);
    enableTerminalChunkFlush(socket);
    socket.once?.('connect', onConnect);
    socket.once?.('negotiated', onNegotiated);
    socket.once?.('error', onError);
  });
  await withTimeout(
    readyPromise,
    timeoutMs,
    () => buildTelnetError('TELNET_CONNECTION_FAILED', 'TELNET connection timed out.'),
  );
  return socket;
};

const loginWithPassword = async (socket, profile, credentials) => {
  const timeoutMs = Number(profile.connectTimeoutMs || 10000);
  const decodeTerminalOutput = createTerminalDecoder(profile.encoding);
  await waitForPattern(socket, /(login|username)[: ]*$/i, timeoutMs, decodeTerminalOutput);
  socket.write(`${profile.username}\r\n`);
  await waitForPattern(socket, /password[: ]*$/i, timeoutMs, decodeTerminalOutput);
  socket.write(`${credentials.password}\r\n`);
  return await waitForAnyData(socket, timeoutMs, decodeTerminalOutput);
};

const shouldAttemptLogin = (profile, credentials) =>
  Boolean(String(profile.username || '').trim() && credentials?.password);

const createAdapter = (socket, optionCodes, initialData, encoding) => {
  const dataListeners = new Set();
  const closeListeners = new Set();
  let pendingInitialData = initialData || '';
  let closed = false;
  const decodeTerminalOutput = createTerminalDecoder(encoding);

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener();
  };
  const forwardData = (data) => {
    const text = decodeTerminalOutput(data);
    if (!text) return;
    for (const listener of [...dataListeners]) listener(text);
  };

  socket.on?.('data', forwardData);
  socket.once?.('end', finish);
  socket.once?.('close', finish);
  socket.once?.('error', finish);

  return {
    onData(listener) {
      if (pendingInitialData) {
        listener(pendingInitialData);
        pendingInitialData = '';
      }
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },

    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },

    write(data) {
      if (!closed) socket.write(String(data));
    },

    resize({ cols, rows }) {
      if (closed) return;
      socket.getOption?.(optionCodes.NAWS)?.sendResize?.(cols, rows);
    },

    close() {
      if (closed) return;
      finish();
      try {
        socket.end?.();
      } catch {
        socket.destroy?.();
      }
    },
  };
};

export const createTelnetTransport = ({
  createConnection = null,
} = {}) => {
  const connectOnly = async (profile) => {
    const runtime = await loadTelnetRuntime(createConnection);
    const socket = await connectSocket(profile, runtime);
    return { socket, optionCodes: runtime.options, initialData: '' };
  };

  const connectAndMaybeLogin = async (profile, credentials) => {
    const connected = await connectOnly(profile);
    if (!shouldAttemptLogin(profile, credentials)) {
      return { ...connected, authenticated: false };
    }
    const initialData = await loginWithPassword(connected.socket, profile, credentials);
    return { ...connected, initialData, authenticated: true };
  };

  return {
    async testConnection(profile, credentials) {
      const { socket, authenticated } = await connectAndMaybeLogin(profile, credentials);
      socket.end?.();
      return { authenticated };
    },

    async openTerminal(profile, credentials) {
      const { socket, optionCodes, initialData } = await connectAndMaybeLogin(profile, credentials);
      return createAdapter(socket, optionCodes, initialData, profile.encoding);
    },
  };
};
