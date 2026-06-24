import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Client } from 'ssh2';

const MIN_AUTH_READY_TIMEOUT_MS = 15000;

const buildSshError = (code, message, statusCode = 502) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const closeClient = (client) => {
  try {
    client.end();
  } catch {
    // The connection may already be closed after a handshake rejection.
  }
  try {
    client.destroy();
  } catch {
    // Ignore redundant disposal errors.
  }
};

const deferHostVerification = (verify, accepted) => {
  if (typeof verify === 'function') {
    queueMicrotask(() => verify(accepted));
  }
};

export const readHostKeyType = (key) => {
  if (!Buffer.isBuffer(key) || key.length < 5) {
    throw buildSshError('SSH_HOST_KEY_INVALID', 'SSH server supplied an invalid host key.');
  }
  const algorithmLength = key.readUInt32BE(0);
  if (algorithmLength < 1 || algorithmLength > key.length - 4) {
    throw buildSshError('SSH_HOST_KEY_INVALID', 'SSH server supplied an invalid host key.');
  }
  return key.subarray(4, 4 + algorithmLength).toString('ascii');
};

export const fingerprintHostKey = (key) => (
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
);

const toObservedHostKey = (profile, key) => ({
  host: profile.host,
  port: profile.port,
  keyType: readHostKeyType(key),
  fingerprintSha256: fingerprintHostKey(key),
  publicKeyBase64: key.toString('base64'),
});

const resolveReadyTimeout = (profile) => {
  const configured = Number(profile.connectTimeoutMs);
  if (!Number.isFinite(configured) || configured <= 0) return MIN_AUTH_READY_TIMEOUT_MS;
  return Math.max(configured, MIN_AUTH_READY_TIMEOUT_MS);
};

const connectionOptions = (profile) => ({
  host: profile.host,
  port: profile.port,
  readyTimeout: resolveReadyTimeout(profile),
  keepaliveInterval: profile.keepaliveIntervalMs,
});

const openSftpAdapter = async (createClient, profile, password, trustedKey, createAdapter) => {
  const client = createClient();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      closeClient(client);
      reject(error);
    };

    client.once('error', () => {
      fail(buildSshError('SSH_CONNECTION_FAILED', 'SSH SFTP connection failed.'));
    });
    client.once('close', () => {
      fail(buildSshError('SSH_CONNECTION_FAILED', 'SSH SFTP connection failed.'));
    });
    client.once('ready', () => {
      client.sftp((error, sftp) => {
        if (error || !sftp) {
          fail(buildSshError('SFTP_UNAVAILABLE', 'SFTP subsystem is not available.'));
          return;
        }

        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            sftp.end?.();
          } catch {
            // Some ssh2 SFTP handles may already be closed.
          } finally {
            closeClient(client);
          }
        };

        settled = true;
        resolve(createAdapter(sftp, close));
      });
    });
    client.connect({
      ...connectionOptions(profile),
      username: profile.username,
      password,
      hostVerifier: (key, verify) => {
        const matches = fingerprintHostKey(key) === trustedKey.fingerprintSha256;
        if (!matches) {
          fail(buildSshError('HOST_KEY_MISMATCH', 'SSH host key has changed.', 409));
        }
        deferHostVerification(verify, matches);
      },
    });
  });
};

const callSftp = (operation, code, message) => (
  new Promise((resolve, reject) => {
    operation((error, result) => {
      if (error) reject(buildSshError(code, message));
      else resolve(result);
    });
  })
);

export const createSshTransport = ({
  createClient = () => new Client(),
} = {}) => ({
  probeHostKey: async (profile) => {
    const client = createClient();
    try {
      return await new Promise((resolve, reject) => {
        let observed = false;
        let settled = false;
        const settle = (handler, value) => {
          if (settled) return;
          settled = true;
          handler(value);
        };

        client.once('error', () => {
          if (!observed) {
            settle(reject, buildSshError('SSH_PROBE_FAILED', 'Unable to obtain the SSH host key.'));
          }
        });
        client.once('close', () => {
          if (!observed) {
            settle(reject, buildSshError('SSH_PROBE_FAILED', 'Unable to obtain the SSH host key.'));
          }
        });
        client.connect({
          ...connectionOptions(profile),
          username: 'opsdog-host-key-probe',
          hostVerifier: (key, verify) => {
            try {
              observed = true;
              settle(resolve, toObservedHostKey(profile, key));
            } catch {
              settle(reject, buildSshError('SSH_HOST_KEY_INVALID', 'SSH server supplied an invalid host key.'));
            }
            deferHostVerification(verify, false);
          },
        });
      });
    } finally {
      closeClient(client);
    }
  },

  testPasswordConnection: async (profile, password, trustedKey) => {
    const client = createClient();
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (handler, value) => {
          if (settled) return;
          settled = true;
          handler(value);
        };

        client.once('error', () => {
          settle(reject, buildSshError('SSH_CONNECTION_FAILED', 'SSH connection test failed.'));
        });
        client.once('close', () => {
          settle(reject, buildSshError('SSH_CONNECTION_FAILED', 'SSH connection test failed.'));
        });
        client.once('ready', () => {
          client.sftp((error) => {
            settle(resolve, { sftpAvailable: !error });
          });
        });
        client.connect({
          ...connectionOptions(profile),
          username: profile.username,
          password,
          hostVerifier: (key, verify) => {
            const matches = fingerprintHostKey(key) === trustedKey.fingerprintSha256;
            if (!matches) {
              settle(reject, buildSshError('HOST_KEY_MISMATCH', 'SSH host key has changed.', 409));
            }
            deferHostVerification(verify, matches);
          },
        });
      });
    } finally {
      closeClient(client);
    }
  },

  openSftp: async (profile, password, trustedKey) => {
    return await openSftpAdapter(createClient, profile, password, trustedKey, (sftp, close) => ({
      list(remotePath) {
        return callSftp(
          (callback) => sftp.readdir(remotePath, callback),
          'SFTP_LIST_FAILED',
          'Unable to list the remote directory.',
        );
      },
      stat(remotePath) {
        return callSftp(
          (callback) => sftp.stat(remotePath, callback),
          'SFTP_STAT_FAILED',
          'Unable to stat the remote entry.',
        );
      },
      createReadStream(remotePath) {
        return sftp.createReadStream(remotePath);
      },
      close,
    }));
  },

  openSftpMutations: async (profile, password, trustedKey) => {
    return await openSftpAdapter(createClient, profile, password, trustedKey, (sftp, close) => ({
      async uploadStream(remotePath, readableStream, { overwrite = true } = {}) {
        try {
          const writeOptions = overwrite ? undefined : { flags: 'wx' };
          const writeStream = writeOptions
            ? sftp.createWriteStream(remotePath, writeOptions)
            : sftp.createWriteStream(remotePath);
          await pipeline(readableStream, writeStream);
        } catch {
          throw buildSshError('SFTP_UPLOAD_FAILED', 'Unable to upload the remote file.');
        }
      },
      mkdir(remotePath) {
        return callSftp(
          (callback) => sftp.mkdir(remotePath, callback),
          'SFTP_MKDIR_FAILED',
          'Unable to create the remote directory.',
        );
      },
      rename(fromPath, toPath) {
        return callSftp(
          (callback) => sftp.rename(fromPath, toPath, callback),
          'SFTP_RENAME_FAILED',
          'Unable to rename the remote entry.',
        );
      },
      deleteFile(remotePath) {
        return callSftp(
          (callback) => sftp.unlink(remotePath, callback),
          'SFTP_DELETE_FAILED',
          'Unable to delete the remote file.',
        );
      },
      close,
    }));
  },

  openTerminal: async (profile, password, trustedKey, {
    term = 'xterm-256color',
    cols = 80,
    rows = 24,
  } = {}) => {
    const client = createClient();
    return await new Promise((resolve, reject) => {
      let settled = false;
      let notifyTerminalClosed = null;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        closeClient(client);
        reject(error);
      };

      client.once('error', () => {
        if (settled && notifyTerminalClosed) {
          notifyTerminalClosed();
          return;
        }
        fail(buildSshError('SSH_TERMINAL_CONNECTION_FAILED', 'SSH terminal connection failed.'));
      });
      client.once('close', () => {
        if (settled && notifyTerminalClosed) {
          notifyTerminalClosed();
          return;
        }
        fail(buildSshError('SSH_TERMINAL_CONNECTION_FAILED', 'SSH terminal connection failed.'));
      });
      client.once('ready', () => {
        client.shell({ term, cols, rows }, (error, stream) => {
          if (error) {
            fail(buildSshError('SSH_TERMINAL_OPEN_FAILED', 'Unable to open an SSH terminal.'));
            return;
          }

          let closed = false;
          const closeListeners = new Set();
          const notifyClosed = () => {
            if (closed) return;
            closed = true;
            closeClient(client);
            for (const listener of closeListeners) listener();
          };
          notifyTerminalClosed = notifyClosed;
          settled = true;
          stream.once('error', notifyClosed);
          stream.once('close', notifyClosed);
          client.once('close', notifyClosed);

          resolve({
            onData(listener) {
              stream.on('data', listener);
              return () => stream.off('data', listener);
            },
            onClose(listener) {
              closeListeners.add(listener);
              if (closed) queueMicrotask(listener);
              return () => closeListeners.delete(listener);
            },
            write(data) {
              if (!closed) stream.write(data);
            },
            resize(dimensions) {
              if (!closed) stream.setWindow(dimensions.rows, dimensions.cols, 0, 0);
            },
            close() {
              if (closed) return;
              try {
                stream.end();
              } finally {
                closeClient(client);
                notifyClosed();
              }
            },
          });
        });
      });
      client.connect({
        ...connectionOptions(profile),
        username: profile.username,
        password,
        hostVerifier: (key, verify) => {
          const matches = fingerprintHostKey(key) === trustedKey.fingerprintSha256;
          if (!matches) {
            fail(buildSshError('HOST_KEY_MISMATCH', 'SSH host key has changed.', 409));
          }
          deferHostVerification(verify, matches);
        },
      });
    });
  },
});
