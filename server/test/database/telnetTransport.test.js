import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createTelnetTransport } from '../../src/remote/telnetTransport.js';

const PASSWORD_MARKER = 'sensitive-telnet-password-marker';
const PROFILE = {
  id: 'telnet-profile-one',
  deviceId: 'local:one',
  host: 'legacy-host.test',
  port: 23,
  username: 'operator',
  connectTimeoutMs: 50,
};

class FakeTelnetSocket extends EventEmitter {
  writes = [];
  resizes = [];
  ended = false;
  destroyed = false;

  constructor() {
    super();
    this.reader = {
      flushPolicy: {
        endOfChunk: false,
        goAhead: true,
        endOfRecord: true,
      },
    };
    this.naws = {
      sendResize: (cols, rows) => {
        this.resizes.push({ cols, rows });
      },
    };
  }

  write(data) {
    this.writes.push(String(data));
  }

  getOption(option) {
    return option === 31 ? this.naws : null;
  }

  end() {
    this.ended = true;
    this.emit('end');
    this.emit('close');
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const createFakeConnectionFactory = ({ negotiate = true } = {}) => {
  const sockets = [];
  const createConnection = (options, onConnect) => {
    const socket = new FakeTelnetSocket();
    socket.options = options;
    sockets.push(socket);
    setImmediate(() => {
      onConnect?.();
      socket.emit('connect');
      if (negotiate) socket.emit('negotiated');
    });
    return socket;
  };
  return { sockets, createConnection };
};

const completeLogin = async (socket) => {
  await waitFor(() => socket.listenerCount('data') > 0, 'login listener was not attached');
  socket.emit('data', Buffer.from('login: '));
  await waitFor(() => socket.writes.includes('operator\r\n'), 'username was not written');
  socket.emit('data', Buffer.from('Password: '));
  await waitFor(() => socket.writes.includes(`${PASSWORD_MARKER}\r\n`), 'password was not written');
  socket.emit('data', Buffer.from('Welcome to legacy console\r\n$ '));
};

test('TELNET transport logs in and exposes only the terminal adapter surface', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory();
  const transport = createTelnetTransport({ createConnection });

  const opening = transport.openTerminal(PROFILE, { password: PASSWORD_MARKER }, { cols: 100, rows: 30 });
  await waitFor(() => sockets.length === 1, 'socket was not created');
  await completeLogin(sockets[0]);
  const terminal = await opening;

  assert.deepEqual(Object.keys(terminal).sort(), ['close', 'onClose', 'onData', 'resize', 'write']);
  assert.deepEqual(sockets[0].options, {
    host: PROFILE.host,
    port: PROFILE.port,
    localOptions: [31, 3],
    remoteOptions: [3],
  });
  assert.equal(JSON.stringify(terminal).includes(PASSWORD_MARKER), false);

  const output = [];
  terminal.onData((data) => output.push(String(data)));
  sockets[0].emit('data', Buffer.from('post-login-output'));
  terminal.write('show version\r\n');
  terminal.resize({ cols: 120, rows: 40 });

  assert.deepEqual(output, ['Welcome to legacy console\r\n$ ', 'post-login-output']);
  assert.deepEqual(sockets[0].writes, [
    'operator\r\n',
    `${PASSWORD_MARKER}\r\n`,
    'show version\r\n',
  ]);
  assert.deepEqual(sockets[0].resizes, [{ cols: 120, rows: 40 }]);
});

test('TELNET transport testConnection closes after password authentication', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory();
  const transport = createTelnetTransport({ createConnection });

  const testing = transport.testConnection(PROFILE, { password: PASSWORD_MARKER });
  await waitFor(() => sockets.length === 1, 'socket was not created');
  await completeLogin(sockets[0]);

  assert.deepEqual(await testing, { authenticated: true });
  assert.equal(sockets[0].ended, true);
});

test('TELNET transport opens an interactive terminal without credentials or negotiation', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory({ negotiate: false });
  const transport = createTelnetTransport({ createConnection });

  const terminal = await transport.openTerminal({
    ...PROFILE,
    username: '',
  }, null, { cols: 100, rows: 30 });
  assert.equal(sockets.length, 1);

  const output = [];
  terminal.onData((data) => output.push(String(data)));
  sockets[0].emit('data', Buffer.from('Username: '));
  terminal.write('operator\r\n');
  terminal.resize({ cols: 132, rows: 43 });

  assert.deepEqual(output, ['Username: ']);
  assert.deepEqual(sockets[0].writes, ['operator\r\n']);
  assert.deepEqual(sockets[0].resizes, [{ cols: 132, rows: 43 }]);

  assert.deepEqual(
    await transport.testConnection({ ...PROFILE, username: '' }, null),
    { authenticated: false },
  );
});

test('TELNET transport flushes terminal output chunks before command lines finish', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory({ negotiate: false });
  const transport = createTelnetTransport({ createConnection });

  const terminal = await transport.openTerminal({ ...PROFILE, username: '' }, null);

  assert.equal(sockets[0].reader.flushPolicy.endOfChunk, true);

  const output = [];
  terminal.onData((data) => output.push(String(data)));
  sockets[0].emit('data', Buffer.from('s'));
  sockets[0].emit('data', Buffer.from('h'));

  assert.deepEqual(output, ['s', 'h']);
});

test('TELNET transport decodes GB18030 device prompts without replacement characters', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory({ negotiate: false });
  const transport = createTelnetTransport({ createConnection });

  const terminal = await transport.openTerminal({ ...PROFILE, username: '' }, null);
  const output = [];
  terminal.onData((data) => output.push(String(data)));

  sockets[0].emit('data', Buffer.from([0xc8, 0xf1, 0xbd, 0xdd, 0x31, 0x46, 0x5f, 0x32, 0x3e]));

  assert.deepEqual(output, ['锐捷1F_2>']);
  assert.equal(output.join('').includes('\uFFFD'), false);
});

test('TELNET transport preserves split GB18030 characters across output chunks', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory({ negotiate: false });
  const transport = createTelnetTransport({ createConnection });

  const terminal = await transport.openTerminal({ ...PROFILE, username: '' }, null);
  const output = [];
  terminal.onData((data) => output.push(String(data)));

  sockets[0].emit('data', Buffer.from([0xc8]));
  sockets[0].emit('data', Buffer.from([0xf1, 0xbd, 0xdd]));

  assert.deepEqual(output, ['锐捷']);
  assert.equal(output.join('').includes('\uFFFD'), false);
});

test('TELNET transport ignores late socket errors after interactive test cleanup', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory({ negotiate: false });
  const transport = createTelnetTransport({ createConnection });

  assert.deepEqual(
    await transport.testConnection({ ...PROFILE, username: '' }, null),
    { authenticated: false },
  );

  assert.doesNotThrow(() => {
    sockets[0].emit('error', new Error('read ECONNRESET'));
  });
});

test('TELNET transport maps connect and login timeouts to stable error codes', async () => {
  const neverConnect = () => new FakeTelnetSocket();
  const connectTimeoutTransport = createTelnetTransport({ createConnection: neverConnect });
  await assert.rejects(
    connectTimeoutTransport.openTerminal({ ...PROFILE, connectTimeoutMs: 5 }, { password: PASSWORD_MARKER }),
    (error) => error.code === 'TELNET_CONNECTION_FAILED' && !String(error.message).includes(PASSWORD_MARKER),
  );

  const { createConnection } = createFakeConnectionFactory();
  const loginTimeoutTransport = createTelnetTransport({ createConnection });
  await assert.rejects(
    loginTimeoutTransport.openTerminal({ ...PROFILE, connectTimeoutMs: 5 }, { password: PASSWORD_MARKER }),
    (error) => error.code === 'TELNET_LOGIN_FAILED' && !String(error.message).includes(PASSWORD_MARKER),
  );
});

test('TELNET transport closes only once on operator and socket close paths', async () => {
  const { sockets, createConnection } = createFakeConnectionFactory();
  const transport = createTelnetTransport({ createConnection });

  const opening = transport.openTerminal(PROFILE, { password: PASSWORD_MARKER }, { cols: 80, rows: 24 });
  await waitFor(() => sockets.length === 1, 'socket was not created');
  await completeLogin(sockets[0]);
  const terminal = await opening;

  let closeCount = 0;
  terminal.onClose(() => {
    closeCount += 1;
  });
  terminal.close();
  terminal.close();
  sockets[0].emit('close');

  assert.equal(closeCount, 1);
  assert.equal(sockets[0].ended, true);
});
