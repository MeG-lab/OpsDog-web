import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createTerminalWebSocket } from '../../src/remote/terminalWebSocket.js';

const buildError = (code) => {
  const error = new Error('Safe terminal failure.');
  error.code = code;
  error.statusCode = 401;
  return error;
};

class FakeTerminalService {
  consumed = new Set();
  writes = [];
  resizes = [];
  closes = [];
  listeners = new Map();
  closedSessions = new Set();

  async openTerminal(token) {
    if (token === 'telnet-login-failed') {
      throw buildError('TELNET_LOGIN_FAILED');
    }
    if (!token || token === 'invalid-token' || this.consumed.has(token)) {
      throw buildError('TERMINAL_TOKEN_INVALID');
    }
    this.consumed.add(token);
    const sessionId = `session-${token}`;
    if (token === 'closed-before-input') {
      this.closedSessions.add(sessionId);
    }
    return {
      sessionId,
      onData: (listener) => {
        this.listeners.set(sessionId, listener);
        return () => this.listeners.delete(sessionId);
      },
    };
  }

  write(sessionId, data) {
    if (this.closedSessions.has(sessionId)) {
      throw buildError('TERMINAL_SESSION_CLOSED');
    }
    this.writes.push({ sessionId, data });
  }

  resize(sessionId, dimensions) {
    if (this.closedSessions.has(sessionId)) {
      throw buildError('TERMINAL_SESSION_CLOSED');
    }
    this.resizes.push({ sessionId, ...dimensions });
  }

  close(sessionId, reason) {
    this.closes.push({ sessionId, reason });
  }

  emitOutput(sessionId, data) {
    this.listeners.get(sessionId)?.(data);
  }
}

const listen = async (server) => await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(`ws://127.0.0.1:${address.port}`);
  });
});

const createHarness = async (options = {}) => {
  const service = new FakeTerminalService();
  const gateway = createTerminalWebSocket(service, options);
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
  });
  const origin = await listen(server);
  return {
    service,
    gateway,
    origin,
    async close() {
      await gateway.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const connectRejected = async (url, origin) => await new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  socket.once('unexpected-response', (_request, response) => {
    socket.terminate();
    resolve(response.statusCode);
  });
  socket.once('open', () => {
    socket.terminate();
    reject(new Error('WebSocket unexpectedly opened.'));
  });
  socket.once('error', reject);
});

const connect = async (url) => {
  const socket = new WebSocket(url);
  const frames = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await once(socket, 'open');
  return {
    socket,
    nextFrame(timeoutMs = 1000) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const waiter = (frame) => {
          clearTimeout(timeout);
          resolve(frame);
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for terminal websocket frame.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
};

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('websocket accepts one token and forwards validated terminal frames', async () => {
  const harness = await createHarness();
  const client = await connect(`${harness.origin}/api/remote/terminal?token=one-use-token`);
  try {
    assert.deepEqual(await client.nextFrame(), {
      type: 'ready',
      sessionId: 'session-one-use-token',
    });

    client.socket.send(JSON.stringify({ type: 'input', data: 'whoami\n' }));
    client.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 32 }));
    await waitFor(
      () => harness.service.writes.length === 1 && harness.service.resizes.length === 1,
      'terminal frames were not forwarded before timeout',
    );
    assert.deepEqual(harness.service.writes, [{
      sessionId: 'session-one-use-token',
      data: 'whoami\n',
    }]);
    assert.deepEqual(harness.service.resizes, [{
      sessionId: 'session-one-use-token',
      cols: 120,
      rows: 32,
    }]);

    harness.service.emitOutput('session-one-use-token', 'output-only');
    assert.deepEqual(await client.nextFrame(), { type: 'output', data: 'output-only' });
    client.socket.send(JSON.stringify({ type: 'close' }));
    assert.deepEqual(await client.nextFrame(), { type: 'closed', reason: 'operator_closed' });
    assert.deepEqual(harness.service.closes, [{
      sessionId: 'session-one-use-token',
      reason: 'operator_closed',
    }]);
  } finally {
    client.socket.terminate();
    await harness.close();
  }
});

test('websocket closes gracefully when terminal session is already closed before input', async () => {
  const harness = await createHarness();
  const client = await connect(`${harness.origin}/api/remote/terminal?token=closed-before-input`);
  try {
    assert.deepEqual(await client.nextFrame(), {
      type: 'ready',
      sessionId: 'session-closed-before-input',
    });

    client.socket.send(JSON.stringify({ type: 'input', data: 'after-exit\r\n' }));

    assert.deepEqual(await client.nextFrame(), { type: 'closed', reason: 'remote_closed' });
    await waitFor(
      () => harness.service.closes.length === 1,
      'terminal session was not closed after a stale input frame',
    );
    assert.deepEqual(harness.service.closes, [{
      sessionId: 'session-closed-before-input',
      reason: 'remote_closed',
    }]);
    assert.deepEqual(harness.service.writes, []);
  } finally {
    client.socket.terminate();
    await harness.close();
  }
});

test('websocket rejects consumed tokens and malformed terminal frames safely', async () => {
  const harness = await createHarness();
  const first = await connect(`${harness.origin}/api/remote/terminal?token=reused-token`);
  assert.equal((await first.nextFrame()).type, 'ready');
  first.socket.terminate();

  const reused = await connect(`${harness.origin}/api/remote/terminal?token=reused-token`);
  assert.deepEqual(await reused.nextFrame(), {
    type: 'error',
    code: 'TERMINAL_TOKEN_INVALID',
    message: 'Unable to open the terminal connection.',
  });
  reused.socket.terminate();

  const malformed = await connect(`${harness.origin}/api/remote/terminal?token=malformed-token`);
  assert.equal((await malformed.nextFrame()).type, 'ready');
  malformed.socket.send('{');
  assert.deepEqual(await malformed.nextFrame(), {
    type: 'error',
    code: 'TERMINAL_FRAME_INVALID',
    message: 'Invalid terminal message.',
  });
  malformed.socket.terminate();

  const invalidResize = await connect(`${harness.origin}/api/remote/terminal?token=resize-token`);
  assert.equal((await invalidResize.nextFrame()).type, 'ready');
  invalidResize.socket.send(JSON.stringify({ type: 'resize', cols: 0, rows: 32 }));
  assert.deepEqual(await invalidResize.nextFrame(), {
    type: 'error',
    code: 'TERMINAL_FRAME_INVALID',
    message: 'Invalid terminal message.',
  });
  invalidResize.socket.terminate();

  const telnetLoginFailed = await connect(`${harness.origin}/api/remote/terminal?token=telnet-login-failed`);
  assert.deepEqual(await telnetLoginFailed.nextFrame(), {
    type: 'error',
    code: 'TELNET_LOGIN_FAILED',
    message: 'Unable to open the terminal connection.',
  });
  telnetLoginFailed.socket.terminate();

  await harness.close();
});

test('websocket rejects disallowed browser origins before consuming terminal tokens', async () => {
  const harness = await createHarness({
    isOriginAllowed: (request) => request.headers.origin === 'http://127.0.0.1:4175',
  });
  try {
    const statusCode = await connectRejected(
      `${harness.origin}/api/remote/terminal?token=origin-token`,
      'https://example.invalid',
    );

    assert.equal(statusCode, 403);
    assert.equal(harness.service.consumed.has('origin-token'), false);
  } finally {
    await harness.close();
  }
});
