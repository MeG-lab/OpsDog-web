import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';

const buildSftpError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const normalizeRemotePath = (value = '.') => {
  const raw = String(value || '.').trim() || '.';
  if (raw.includes('\0')) {
    throw buildSftpError('SFTP_PATH_INVALID', 'SFTP path is invalid.');
  }
  return path.posix.normalize(raw);
};

const normalizeRequiredRemotePath = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw || raw.includes('\0')) {
    throw buildSftpError('SFTP_PATH_INVALID', 'SFTP path is invalid.');
  }
  return path.posix.normalize(raw);
};

const joinRemotePath = (basePath, name) => {
  const normalizedName = String(name || '').replaceAll('\0', '');
  if (!normalizedName) return normalizeRemotePath(basePath);
  if (basePath === '/' || basePath === '.') return path.posix.join(basePath, normalizedName);
  return path.posix.join(basePath, normalizedName);
};

const toIsoTime = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
};

const toEntryKind = (attrs = {}) => {
  if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) return 'directory';
  if (typeof attrs.isFile === 'function' && attrs.isFile()) return 'file';
  return 'other';
};

const toDirectoryEntry = (basePath, entry) => {
  const attrs = entry?.attrs || {};
  const name = String(entry?.filename || '');
  return {
    name,
    path: joinRemotePath(basePath, name),
    kind: toEntryKind(attrs),
    size: Number.isFinite(Number(attrs.size)) ? Number(attrs.size) : null,
    modifiedAt: toIsoTime(attrs.mtime),
    mode: Number.isFinite(Number(attrs.mode)) ? Number(attrs.mode) : null,
  };
};

const toStatEntry = (remotePath, attrs = {}) => ({
  name: path.posix.basename(remotePath) || remotePath,
  path: remotePath,
  kind: toEntryKind(attrs),
  size: Number.isFinite(Number(attrs.size)) ? Number(attrs.size) : null,
  modifiedAt: toIsoTime(attrs.mtime),
  mode: Number.isFinite(Number(attrs.mode)) ? Number(attrs.mode) : null,
});

const safeDisplayFileName = (fileName, remotePath) => {
  const sanitized = String(fileName || '').replaceAll('\0', '');
  return path.posix.basename(sanitized) || path.posix.basename(remotePath) || 'upload';
};

const asSafeSftpError = (error, fallbackCode, message, statusCode = 400) => {
  const code = String(error?.code || '');
  if (code.startsWith('SFTP_') || code.startsWith('SSH_') || code.startsWith('HOST_KEY_')) {
    return error;
  }
  return buildSftpError(fallbackCode, message, statusCode);
};

export const createSftpService = (
  database,
  secretStore,
  transport,
  hostKeyService,
  {
    now = () => new Date().toISOString(),
    createId = () => randomUUID(),
  } = {},
) => {
  const activeSessions = new Map();

  const requireProfile = (profileId) => {
    const row = database.get(
      `
        SELECT p.*, credential.vault_account
        FROM connection_profiles p
        LEFT JOIN credential_refs credential
          ON credential.id = p.password_credential_ref_id
         AND credential.deleted_at IS NULL
        WHERE p.id = ? AND p.deleted_at IS NULL
      `,
      String(profileId || '').trim(),
    );
    if (!row) {
      throw buildSftpError('REMOTE_PROFILE_INVALID', 'SSH connection profile was not found.');
    }
    if (row.protocol !== 'ssh' || row.auth_method !== 'password' || !row.vault_account) {
      throw buildSftpError('SFTP_UNSUPPORTED', 'SFTP password sessions are unavailable.');
    }
    if (!row.enabled) {
      throw buildSftpError('SSH_CONNECTION_DISABLED', 'SSH connection profile is disabled.', 409);
    }
    if (!row.sftp_enabled) {
      throw buildSftpError('SFTP_DISABLED', 'SFTP is disabled for this profile.', 409);
    }
    return {
      id: row.id,
      deviceId: row.device_id,
      host: row.host,
      port: row.port,
      username: row.username,
      connectTimeoutMs: row.connect_timeout_ms,
      keepaliveIntervalMs: row.keepalive_interval_ms,
      vaultAccount: row.vault_account,
    };
  };

  const audit = (profile, sessionId, eventType, outcome, summary, detail = {}, riskLevel = 'read-only') => {
    database.run(
      `
        INSERT INTO audit_events
          (id, event_type, device_id, connection_profile_id, session_id,
           risk_level, outcome, summary, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      createId(),
      eventType,
      profile.deviceId,
      profile.id,
      sessionId,
      riskLevel,
      outcome,
      summary,
      JSON.stringify(detail),
      now(),
    );
  };

  const verifyTrustedHost = async (profile) => {
    const observedKey = await transport.probeHostKey(profile);
    return hostKeyService.evaluateObservedKey(profile, observedKey);
  };

  const requireActiveSession = (sessionId) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) {
      throw buildSftpError('SFTP_SESSION_CLOSED', 'SFTP session is no longer active.', 410);
    }
    return entry;
  };

  const finishSession = (sessionId, reason) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return false;
    activeSessions.delete(sessionId);
    entry.sftp.close();
    entry.mutations?.close?.();
    database.transaction(() => {
      database.run(
        `
          UPDATE remote_sessions
          SET state = 'closed', ended_at = ?, ended_reason = ?
          WHERE id = ? AND state = 'active'
        `,
        now(),
        reason,
        sessionId,
      );
      audit(
        entry.profile,
        sessionId,
        'sftp.session.closed',
        'succeeded',
        'SFTP session closed.',
        { reason },
      );
    });
    return true;
  };

  const recordOperation = async (
    entry,
    operationType,
    remotePath,
    handler,
    {
      destinationPath = null,
      confirmationRequired = false,
      confirmationReceived = false,
      riskLevel = 'read-only',
    } = {},
  ) => {
    const operationId = createId();
    database.run(
      `
        INSERT INTO sftp_operations
          (id, session_id, device_id, operation_type, remote_path, destination_path,
           confirmation_required, confirmation_received, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
      `,
      operationId,
      entry.sessionId,
      entry.profile.deviceId,
      operationType,
      remotePath,
      destinationPath,
      confirmationRequired ? 1 : 0,
      confirmationReceived ? 1 : 0,
      now(),
    );
    try {
      const result = await handler();
      database.transaction(() => {
        database.run(
          "UPDATE sftp_operations SET status = 'succeeded', ended_at = ? WHERE id = ?",
          now(),
          operationId,
        );
        audit(
          entry.profile,
          entry.sessionId,
          `sftp.${operationType}`,
          'succeeded',
          `SFTP ${operationType} succeeded.`,
          { remotePath, ...(destinationPath ? { destinationPath } : {}) },
          riskLevel,
        );
      });
      return result;
    } catch (error) {
      const errorCode = error?.code || `SFTP_${operationType.toUpperCase()}_FAILED`;
      database.transaction(() => {
        database.run(
          "UPDATE sftp_operations SET status = 'failed', error_message = ?, ended_at = ? WHERE id = ?",
          errorCode,
          now(),
          operationId,
        );
        audit(
          entry.profile,
          entry.sessionId,
          `sftp.${operationType}`,
          'failed',
          `SFTP ${operationType} failed.`,
          { remotePath, ...(destinationPath ? { destinationPath } : {}), errorCode },
          riskLevel,
        );
      });
      throw error;
    }
  };

  const openSession = async (profileId) => {
    const profile = requireProfile(profileId);
    const hostKey = await verifyTrustedHost(profile);
    if (hostKey.code !== 'HOST_KEY_TRUSTED') return hostKey;

    const sessionId = createId();
    const startedAt = now();
    database.run(
      `
        INSERT INTO remote_sessions
          (id, connection_profile_id, device_id, session_kind, protocol, actor_type,
           state, host_key_id, transcript_policy, remote_address, started_at)
        VALUES (?, ?, ?, 'sftp', 'ssh', 'human', 'opening', ?, 'metadata_only', ?, ?)
      `,
      sessionId,
      profile.id,
      profile.deviceId,
      hostKey.id,
      `${profile.host}:${profile.port}`,
      startedAt,
    );

    try {
      const password = await secretStore.getSecret(profile.vaultAccount);
      if (!password) {
        throw buildSftpError('SSH_CREDENTIAL_UNAVAILABLE', 'SSH password is unavailable.', 503);
      }
      let sftp = null;
      let mutations = null;
      try {
        sftp = await transport.openSftp(profile, password, hostKey);
        mutations = await transport.openSftpMutations(profile, password, hostKey);
      } catch (error) {
        sftp?.close?.();
        mutations?.close?.();
        throw error;
      }
      const openedAt = now();
      database.transaction(() => {
        database.run(
          "UPDATE remote_sessions SET state = 'active', authenticated_at = ? WHERE id = ? AND state = 'opening'",
          openedAt,
          sessionId,
        );
        audit(
          profile,
          sessionId,
          'sftp.session.opened',
          'succeeded',
          'SFTP session opened.',
          { authentication: 'password' },
        );
      });
      activeSessions.set(sessionId, { sessionId, profile, sftp, mutations });
      return {
        status: 'ready',
        session: {
          id: sessionId,
          profileId: profile.id,
          openedAt,
        },
      };
    } catch (error) {
      const errorCode = error?.code || 'SFTP_OPEN_FAILED';
      database.transaction(() => {
        database.run(
          `
            UPDATE remote_sessions
            SET state = 'failed', ended_at = ?, ended_reason = 'open_failed', error_code = ?
            WHERE id = ? AND state = 'opening'
          `,
          now(),
          errorCode,
          sessionId,
        );
        audit(
          profile,
          sessionId,
          'sftp.session.failed',
          'failed',
          'SFTP session failed to open.',
          { errorCode },
        );
      });
      throw error;
    }
  };

  const list = async (sessionId, inputPath = '.') => {
    const entry = requireActiveSession(sessionId);
    const remotePath = normalizeRemotePath(inputPath);
    return await recordOperation(entry, 'list', remotePath, async () => ({
      path: remotePath,
      entries: (await entry.sftp.list(remotePath)).map((item) => toDirectoryEntry(remotePath, item)),
    }));
  };

  const stat = async (sessionId, inputPath = '.') => {
    const entry = requireActiveSession(sessionId);
    const remotePath = normalizeRemotePath(inputPath);
    return await recordOperation(entry, 'stat', remotePath, async () => ({
      path: remotePath,
      entry: toStatEntry(remotePath, await entry.sftp.stat(remotePath)),
    }));
  };

  const download = async (sessionId, inputPath) => {
    const entry = requireActiveSession(sessionId);
    const remotePath = normalizeRemotePath(inputPath);
    const transferId = createId();
    const displayFileName = path.posix.basename(remotePath) || 'download';
    const stream = entry.sftp.createReadStream(remotePath);
    let transferredBytes = 0;
    let finished = false;

    const finishTransfer = (status, errorCode = null) => {
      if (finished) return;
      finished = true;
      database.transaction(() => {
        database.run(
          `
            UPDATE sftp_transfers
            SET status = ?, transferred_bytes = ?, error_message = ?, ended_at = ?
            WHERE id = ?
          `,
          status,
          transferredBytes,
          errorCode,
          now(),
          transferId,
        );
        audit(
          entry.profile,
          entry.sessionId,
          'sftp.download',
          status === 'succeeded' ? 'succeeded' : 'failed',
          `SFTP download ${status}.`,
          { remotePath, transferId, transferredBytes, ...(errorCode ? { errorCode } : {}) },
        );
      });
    };

    database.run(
      `
        INSERT INTO sftp_transfers
          (id, session_id, device_id, direction, remote_path, display_file_name,
           status, started_at)
        VALUES (?, ?, ?, 'download', ?, ?, 'started', ?)
      `,
      transferId,
      entry.sessionId,
      entry.profile.deviceId,
      remotePath,
      displayFileName,
      now(),
    );

    stream.on('data', (chunk) => {
      transferredBytes += Buffer.byteLength(chunk);
    });
    stream.once('end', () => finishTransfer('succeeded'));
    stream.once('error', (error) => finishTransfer('failed', error?.code || 'SFTP_DOWNLOAD_FAILED'));
    stream.once('close', () => finishTransfer('cancelled'));

    return {
      transferId,
      remotePath,
      displayFileName,
      stream,
    };
  };

  const upload = async (sessionId, {
    remotePath: inputPath,
    fileName,
    stream,
    sizeBytes,
    confirmOverwrite = false,
  } = {}) => {
    const entry = requireActiveSession(sessionId);
    const remotePath = normalizeRequiredRemotePath(inputPath);
    if (!stream || typeof stream.pipe !== 'function') {
      throw buildSftpError('SFTP_UPLOAD_STREAM_INVALID', 'SFTP upload stream is invalid.');
    }

    if (!confirmOverwrite) {
      try {
        await entry.sftp.stat(remotePath);
        throw buildSftpError(
          'SFTP_OVERWRITE_CONFIRMATION_REQUIRED',
          'SFTP upload overwrite requires confirmation.',
          409,
        );
      } catch (error) {
        if (error?.code === 'SFTP_OVERWRITE_CONFIRMATION_REQUIRED') throw error;
      }
    }

    const transferId = createId();
    const displayFileName = safeDisplayFileName(fileName, remotePath);
    const expectedSize = Number(sizeBytes);
    let transferredBytes = 0;

    database.run(
      `
        INSERT INTO sftp_transfers
          (id, session_id, device_id, direction, remote_path, display_file_name,
           size_bytes, overwrite_confirmed, status, started_at)
        VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, 'started', ?)
      `,
      transferId,
      entry.sessionId,
      entry.profile.deviceId,
      remotePath,
      displayFileName,
      Number.isFinite(expectedSize) && expectedSize >= 0 ? expectedSize : null,
      confirmOverwrite ? 1 : 0,
      now(),
    );

    const countingStream = new Transform({
      transform(chunk, _encoding, callback) {
        transferredBytes += Buffer.byteLength(chunk);
        callback(null, chunk);
      },
    });

    try {
      await entry.mutations.uploadStream(
        remotePath,
        stream.pipe(countingStream),
        { overwrite: Boolean(confirmOverwrite) },
      );
      database.transaction(() => {
        database.run(
          `
            UPDATE sftp_transfers
            SET status = 'succeeded', transferred_bytes = ?, ended_at = ?
            WHERE id = ?
          `,
          transferredBytes,
          now(),
          transferId,
        );
        audit(
          entry.profile,
          entry.sessionId,
          'sftp.upload',
          'succeeded',
          'SFTP upload succeeded.',
          { remotePath, transferId, transferredBytes, overwriteConfirmed: Boolean(confirmOverwrite) },
          'state-change',
        );
      });
      return { transferId, remotePath, displayFileName, transferredBytes, status: 'succeeded' };
    } catch (error) {
      const safeError = asSafeSftpError(error, 'SFTP_UPLOAD_FAILED', 'SFTP upload failed.');
      database.transaction(() => {
        database.run(
          `
            UPDATE sftp_transfers
            SET status = 'failed', transferred_bytes = ?, error_message = ?, ended_at = ?
            WHERE id = ?
          `,
          transferredBytes,
          safeError.code,
          now(),
          transferId,
        );
        audit(
          entry.profile,
          entry.sessionId,
          'sftp.upload',
          'failed',
          'SFTP upload failed.',
          { remotePath, transferId, transferredBytes, errorCode: safeError.code },
          'state-change',
        );
      });
      throw safeError;
    }
  };

  const mkdir = async (sessionId, inputPath) => {
    const entry = requireActiveSession(sessionId);
    const remotePath = normalizeRequiredRemotePath(inputPath);
    return await recordOperation(
      entry,
      'mkdir',
      remotePath,
      async () => {
        try {
          await entry.mutations.mkdir(remotePath);
          return { path: remotePath, status: 'succeeded' };
        } catch (error) {
          throw asSafeSftpError(error, 'SFTP_MKDIR_FAILED', 'SFTP mkdir failed.');
        }
      },
      { confirmationRequired: true, confirmationReceived: true, riskLevel: 'state-change' },
    );
  };

  const rename = async (sessionId, inputFromPath, inputToPath) => {
    const entry = requireActiveSession(sessionId);
    const fromPath = normalizeRequiredRemotePath(inputFromPath);
    const toPath = normalizeRequiredRemotePath(inputToPath);
    return await recordOperation(
      entry,
      'rename',
      fromPath,
      async () => {
        try {
          await entry.mutations.rename(fromPath, toPath);
          return { fromPath, toPath, status: 'succeeded' };
        } catch (error) {
          throw asSafeSftpError(error, 'SFTP_RENAME_FAILED', 'SFTP rename failed.');
        }
      },
      {
        destinationPath: toPath,
        confirmationRequired: true,
        confirmationReceived: true,
        riskLevel: 'state-change',
      },
    );
  };

  const deleteFile = async (sessionId, inputPath) => {
    const entry = requireActiveSession(sessionId);
    const remotePath = normalizeRequiredRemotePath(inputPath);
    return await recordOperation(
      entry,
      'delete',
      remotePath,
      async () => {
        try {
          const attrs = await entry.sftp.stat(remotePath);
          if (toEntryKind(attrs) === 'directory') {
            throw buildSftpError(
              'SFTP_DELETE_DIRECTORY_UNSUPPORTED',
              'SFTP directory deletion is not supported.',
              409,
            );
          }
          await entry.mutations.deleteFile(remotePath);
          return { path: remotePath, status: 'succeeded' };
        } catch (error) {
          throw asSafeSftpError(error, 'SFTP_DELETE_FAILED', 'SFTP delete failed.');
        }
      },
      { confirmationRequired: true, confirmationReceived: true, riskLevel: 'destructive' },
    );
  };

  return {
    openSession,
    list,
    stat,
    download,
    upload,
    mkdir,
    rename,
    deleteFile,
    closeSession: finishSession,
    closeAll(reason = 'server_stopped') {
      for (const sessionId of [...activeSessions.keys()]) finishSession(sessionId, reason);
    },
  };
};
