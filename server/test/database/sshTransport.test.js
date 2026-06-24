import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  createSshTransport,
  fingerprintHostKey,
  readHostKeyType,
} from '../../src/remote/sshTransport.js';

const lengthPrefixed = (value) => {
  const bytes = Buffer.from(value, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

const HOST_KEY = Buffer.concat([
  lengthPrefixed('ssh-ed25519'),
  Buffer.from('disposable-public-host-key', 'utf8'),
]);
const CHANGED_HOST_KEY = Buffer.concat([
  lengthPrefixed('ssh-ed25519'),
  Buffer.from('changed-disposable-public-host-key', 'utf8'),
]);

const verifyHost = (hostVerifier, hostKey, onAccepted) => {
  let settled = false;
  const returned = hostVerifier(hostKey, (accepted) => {
    if (settled) return;
    settled = true;
    onAccepted(accepted);
  });
  if (returned !== undefined) {
    settled = true;
    onAccepted(returned);
  }
};

class FakeProbeClient extends EventEmitter {
  connectOptions = null;
  ended = false;
  destroyed = false;

  connect(options) {
    this.connectOptions = options;
    queueMicrotask(() => {
      verifyHost(options.hostVerifier, HOST_KEY, (accepted) => {
        assert.equal(accepted, false);
        this.emit('error', new Error('Host denied after observation.'));
      });
    });
    return this;
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeAuthenticatedClient extends EventEmitter {
  constructor(hostKey) {
    super();
    this.hostKey = hostKey;
    this.connectOptions = null;
    this.sftpRequested = false;
    this.ended = false;
    this.destroyed = false;
  }

  connect(options) {
    this.connectOptions = options;
    queueMicrotask(() => {
      verifyHost(options.hostVerifier, this.hostKey, (accepted) => {
        if (accepted) this.emit('ready');
        else this.emit('error', new Error('Host verification failed.'));
      });
    });
    return this;
  }

  sftp(callback) {
    this.sftpRequested = true;
    callback(null, { end() {} });
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeSftpHandle {
  ended = false;
  listRequests = [];
  statRequests = [];
  streamRequests = [];
  writeRequests = [];
  mkdirRequests = [];
  renameRequests = [];
  unlinkRequests = [];
  entries = [{ filename: 'app.log', attrs: { size: 1204 } }];
  attrs = { size: 1204, mode: 0o100644 };
  stream = new EventEmitter();

  readdir(remotePath, callback) {
    this.listRequests.push(remotePath);
    callback(null, this.entries);
  }

  stat(remotePath, callback) {
    this.statRequests.push(remotePath);
    callback(null, this.attrs);
  }

  createReadStream(remotePath) {
    this.streamRequests.push(remotePath);
    return this.stream;
  }

  createWriteStream(remotePath, options) {
    const chunks = [];
    this.writeRequests.push({ remotePath, options, chunks });
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
  }

  mkdir(remotePath, callback) {
    this.mkdirRequests.push(remotePath);
    callback(null);
  }

  rename(fromPath, toPath, callback) {
    this.renameRequests.push([fromPath, toPath]);
    callback(null);
  }

  unlink(remotePath, callback) {
    this.unlinkRequests.push(remotePath);
    callback(null);
  }

  end() {
    this.ended = true;
  }
}

class FakeSftpClient extends EventEmitter {
  constructor(hostKey, { openError = null } = {}) {
    super();
    this.hostKey = hostKey;
    this.openError = openError;
    this.connectOptions = null;
    this.sftpRequested = false;
    this.sftpHandle = new FakeSftpHandle();
    this.ended = false;
    this.destroyed = false;
  }

  connect(options) {
    this.connectOptions = options;
    queueMicrotask(() => {
      verifyHost(options.hostVerifier, this.hostKey, (accepted) => {
        if (accepted) this.emit('ready');
        else this.emit('error', new Error('Host verification failed.'));
      });
    });
    return this;
  }

  sftp(callback) {
    this.sftpRequested = true;
    callback(this.openError, this.sftpHandle);
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeShellStream extends EventEmitter {
  writes = [];
  windows = [];
  ended = false;

  write(data) {
    this.writes.push(data);
  }

  setWindow(rows, cols, height, width) {
    this.windows.push({ rows, cols, height, width });
  }

  end() {
    this.ended = true;
    this.emit('close');
  }
}

class FakeShellClient extends EventEmitter {
  constructor(hostKey) {
    super();
    this.hostKey = hostKey;
    this.connectOptions = null;
    this.shellOptions = null;
    this.stream = new FakeShellStream();
    this.ended = false;
    this.destroyed = false;
  }

  connect(options) {
    this.connectOptions = options;
    queueMicrotask(() => {
      verifyHost(options.hostVerifier, this.hostKey, (accepted) => {
        if (accepted) this.emit('ready');
        else this.emit('error', new Error('Host verification failed.'));
      });
    });
    return this;
  }

  shell(options, callback) {
    this.shellOptions = options;
    callback(null, this.stream);
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeSsh2VerifierClient extends FakeShellClient {
  hostVerifierReturn = undefined;
  hostVerifierCallbackCalls = 0;
  hostVerifierCallbackCallsAfterReturn = null;

  connect(options) {
    this.connectOptions = options;
    queueMicrotask(() => {
      let callbackAccepted;
      this.hostVerifierReturn = options.hostVerifier(this.hostKey, (accepted) => {
        this.hostVerifierCallbackCalls += 1;
        callbackAccepted = accepted;
        if (accepted) this.emit('ready');
        else this.emit('error', new Error('Host verification failed.'));
      });
      this.hostVerifierCallbackCallsAfterReturn = this.hostVerifierCallbackCalls;
      if (this.hostVerifierReturn !== undefined) {
        if (this.hostVerifierReturn) this.emit('ready');
        else this.emit('error', new Error('Host verification failed.'));
      } else if (callbackAccepted !== undefined) {
        if (callbackAccepted) this.emit('ready');
        else this.emit('error', new Error('Host verification failed.'));
      }
    });
    return this;
  }
}

class FakeClosedClient extends EventEmitter {
  ended = false;
  destroyed = false;

  connect() {
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

const PROFILE = {
  host: '10.0.0.1',
  port: 22,
  username: 'operator',
  connectTimeoutMs: 1000,
  keepaliveIntervalMs: 0,
};

test('host-key utility derives the algorithm and OpenSSH SHA256 fingerprint from an SSH public blob', () => {
  assert.equal(readHostKeyType(HOST_KEY), 'ssh-ed25519');
  assert.match(fingerprintHostKey(HOST_KEY), /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(fingerprintHostKey(HOST_KEY).endsWith('='), false);
  assert.throws(() => readHostKeyType(Buffer.from([0, 0, 0, 20, 1])), /host key/i);
});

test('host-key probe captures safe key metadata and rejects the handshake before authentication', async () => {
  const client = new FakeProbeClient();
  const transport = createSshTransport({ createClient: () => client });

  const observed = await transport.probeHostKey(PROFILE);

  assert.deepEqual(observed, {
    host: PROFILE.host,
    port: PROFILE.port,
    keyType: 'ssh-ed25519',
    fingerprintSha256: fingerprintHostKey(HOST_KEY),
    publicKeyBase64: HOST_KEY.toString('base64'),
  });
  assert.equal('password' in client.connectOptions, false);
  assert.equal(client.ended || client.destroyed, true);
});

test('host-key probe fails closed when the server disconnects before presenting a key', async () => {
  const client = new FakeClosedClient();
  const transport = createSshTransport({ createClient: () => client });

  await assert.rejects(
    Promise.race([
      transport.probeHostKey(PROFILE),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe remained pending')), 50)),
    ]),
    (error) => error.code === 'SSH_PROBE_FAILED',
  );
  assert.equal(client.ended || client.destroyed, true);
});

test('authenticated test accepts only the trusted key and reports SFTP availability', async () => {
  const client = new FakeAuthenticatedClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  const result = await transport.testPasswordConnection(
    PROFILE,
    'disposable-transport-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
  );

  assert.deepEqual(result, { sftpAvailable: true });
  assert.equal(client.connectOptions.password, 'disposable-transport-password');
  assert.equal(client.sftpRequested, true);
  assert.equal(client.ended || client.destroyed, true);
});

test('authenticated sessions keep a practical ready timeout floor for slow SSH auth banners', async () => {
  const client = new FakeAuthenticatedClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  await transport.testPasswordConnection(
    { ...PROFILE, connectTimeoutMs: 1000 },
    'disposable-transport-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
  );

  assert.equal(client.connectOptions.readyTimeout, 15000);
});

test('authenticated test fails closed when the server disconnects before it becomes ready', async () => {
  const client = new FakeClosedClient();
  const transport = createSshTransport({ createClient: () => client });

  await assert.rejects(
    Promise.race([
      transport.testPasswordConnection(
        PROFILE,
        'disposable-transport-password',
        { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test remained pending')), 50)),
    ]),
    (error) => error.code === 'SSH_CONNECTION_FAILED',
  );
  assert.equal(client.ended || client.destroyed, true);
});

test('authenticated test rejects a changed server key before SFTP capability testing', async () => {
  const client = new FakeAuthenticatedClient(CHANGED_HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  await assert.rejects(
    transport.testPasswordConnection(
      PROFILE,
      'disposable-transport-password',
      { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    ),
    (error) => error.code === 'HOST_KEY_MISMATCH',
  );

  assert.equal(client.sftpRequested, false);
  assert.equal(client.ended || client.destroyed, true);
});

test('authenticated SFTP verifies host key and exposes only read-only operations', async () => {
  const client = new FakeSftpClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  const sftp = await transport.openSftp(
    PROFILE,
    'disposable-sftp-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
  );

  assert.equal(client.connectOptions.password, 'disposable-sftp-password');
  assert.equal(client.sftpRequested, true);
  assert.deepEqual(Object.keys(sftp).sort(), ['close', 'createReadStream', 'list', 'stat']);
  assert.equal('createWriteStream' in sftp, false);
  assert.equal('mkdir' in sftp, false);
  assert.equal('rename' in sftp, false);
  assert.equal('unlink' in sftp, false);
  assert.deepEqual(await sftp.list('/var/log'), client.sftpHandle.entries);
  assert.deepEqual(await sftp.stat('/var/log/app.log'), client.sftpHandle.attrs);
  assert.equal(sftp.createReadStream('/var/log/app.log'), client.sftpHandle.stream);
  assert.deepEqual(client.sftpHandle.listRequests, ['/var/log']);
  assert.deepEqual(client.sftpHandle.statRequests, ['/var/log/app.log']);
  assert.deepEqual(client.sftpHandle.streamRequests, ['/var/log/app.log']);
  sftp.close();
  sftp.close();
  assert.equal(client.sftpHandle.ended, true);
  assert.equal(client.ended || client.destroyed, true);
});

test('authenticated SFTP mutation adapter exposes only approved write operations', async () => {
  const client = new FakeSftpClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  const adapter = await transport.openSftpMutations(
    PROFILE,
    'disposable-sftp-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
  );

  assert.deepEqual(Object.keys(adapter).sort(), [
    'close',
    'deleteFile',
    'mkdir',
    'rename',
    'uploadStream',
  ]);
  assert.equal(adapter.rmdir, undefined);
  assert.equal(adapter.recursiveDelete, undefined);
  assert.equal(adapter.createWriteStream, undefined);
  assert.equal(adapter.unlink, undefined);

  await adapter.uploadStream('/tmp/opsdog.txt', Readable.from(['payload']));
  await adapter.uploadStream('/tmp/opsdog-new.txt', Readable.from(['new']), { overwrite: false });
  await adapter.mkdir('/tmp/opsdog');
  await adapter.rename('/tmp/opsdog.txt', '/tmp/opsdog-renamed.txt');
  await adapter.deleteFile('/tmp/opsdog-renamed.txt');

  assert.deepEqual(client.sftpHandle.writeRequests.map((item) => item.remotePath), ['/tmp/opsdog.txt', '/tmp/opsdog-new.txt']);
  assert.equal(client.sftpHandle.writeRequests[0].options, undefined);
  assert.deepEqual(client.sftpHandle.writeRequests[1].options, { flags: 'wx' });
  assert.equal(Buffer.concat(client.sftpHandle.writeRequests[0].chunks).toString('utf8'), 'payload');
  assert.equal(Buffer.concat(client.sftpHandle.writeRequests[1].chunks).toString('utf8'), 'new');
  assert.deepEqual(client.sftpHandle.mkdirRequests, ['/tmp/opsdog']);
  assert.deepEqual(client.sftpHandle.renameRequests, [['/tmp/opsdog.txt', '/tmp/opsdog-renamed.txt']]);
  assert.deepEqual(client.sftpHandle.unlinkRequests, ['/tmp/opsdog-renamed.txt']);
  adapter.close();
  assert.equal(client.sftpHandle.ended, true);
  assert.equal(client.ended || client.destroyed, true);
});

test('authenticated SFTP refuses changed host keys and failed subsystem opens', async () => {
  const changedClient = new FakeSftpClient(CHANGED_HOST_KEY);
  const changedTransport = createSshTransport({ createClient: () => changedClient });

  await assert.rejects(
    changedTransport.openSftp(
      PROFILE,
      'disposable-sftp-password',
      { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    ),
    (error) => error.code === 'HOST_KEY_MISMATCH',
  );
  assert.equal(changedClient.sftpRequested, false);
  assert.equal(changedClient.ended || changedClient.destroyed, true);

  const failedClient = new FakeSftpClient(HOST_KEY, { openError: new Error('subsystem unavailable') });
  const failedTransport = createSshTransport({ createClient: () => failedClient });
  await assert.rejects(
    failedTransport.openSftp(
      PROFILE,
      'disposable-sftp-password',
      { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    ),
    (error) => error.code === 'SFTP_UNAVAILABLE',
  );
  assert.equal(failedClient.sftpRequested, true);
  assert.equal(failedClient.ended || failedClient.destroyed, true);
});

test('authenticated terminal verifies the trusted key and opens a PTY shell', async () => {
  const client = new FakeShellClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  const terminal = await transport.openTerminal(
    PROFILE,
    'disposable-terminal-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    { term: 'xterm-256color', cols: 120, rows: 32 },
  );

  assert.deepEqual(client.shellOptions, { term: 'xterm-256color', cols: 120, rows: 32 });
  terminal.write('printf test\n');
  terminal.resize({ cols: 140, rows: 40 });
  terminal.close();
  assert.deepEqual(client.stream.writes, ['printf test\n']);
  assert.deepEqual(client.stream.windows, [{ rows: 40, cols: 140, height: 0, width: 0 }]);
  assert.equal(client.stream.ended, true);
  assert.equal(client.ended || client.destroyed, true);
});

test('trusted host verifier resolves through asynchronous callback for ssh2 compatibility', async () => {
  const client = new FakeSsh2VerifierClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  const terminal = await transport.openTerminal(
    PROFILE,
    'disposable-terminal-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    { cols: 80, rows: 24 },
  );
  terminal.close();

  assert.equal(client.hostVerifierReturn, undefined);
  assert.equal(client.hostVerifierCallbackCallsAfterReturn, 0);
  assert.equal(client.hostVerifierCallbackCalls, 1);
});

test('authenticated terminal refuses a changed host key before shell creation', async () => {
  const client = new FakeShellClient(CHANGED_HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  await assert.rejects(
    transport.openTerminal(
      PROFILE,
      'disposable-terminal-password',
      { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
      { cols: 80, rows: 24 },
    ),
    (error) => error.code === 'HOST_KEY_MISMATCH',
  );

  assert.equal(client.shellOptions, null);
  assert.equal(client.ended || client.destroyed, true);
});

test('active terminal closes safely when its PTY stream emits an error', async () => {
  const client = new FakeShellClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });
  const terminal = await transport.openTerminal(
    PROFILE,
    'disposable-terminal-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    { cols: 80, rows: 24 },
  );
  let closed = false;
  terminal.onClose(() => {
    closed = true;
  });

  client.stream.emit('error', new Error('remote PTY stream failed'));

  assert.equal(closed, true);
  assert.equal(client.ended || client.destroyed, true);
});
