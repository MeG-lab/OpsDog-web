import { randomUUID } from 'node:crypto';
import { normalizeTerminalDimensions } from './terminalTokenStore.js';

const buildTerminalError = (code, message, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const createSshTerminalService = (
  database,
  secretStore,
  transport,
  hostKeyService,
  tokenStore,
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
      throw buildTerminalError('REMOTE_PROFILE_INVALID', 'SSH connection profile was not found.', 400);
    }
    if (row.protocol !== 'ssh' || row.auth_method !== 'password' || !row.vault_account) {
      throw buildTerminalError('SSH_TERMINAL_UNSUPPORTED', 'SSH password terminal sessions are unavailable.', 400);
    }
    if (!row.enabled) {
      throw buildTerminalError('SSH_CONNECTION_DISABLED', 'SSH connection profile is disabled.', 409);
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

  const audit = (profile, sessionId, eventType, outcome, summary, detail = {}) => {
    database.run(
      `
        INSERT INTO audit_events
          (id, event_type, device_id, connection_profile_id, session_id,
           risk_level, outcome, summary, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'read-only', ?, ?, ?, ?)
      `,
      createId(),
      eventType,
      profile.deviceId,
      profile.id,
      sessionId,
      outcome,
      summary,
      JSON.stringify(detail),
      now(),
    );
  };

  const requireActiveSession = (sessionId) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) {
      throw buildTerminalError('TERMINAL_SESSION_CLOSED', 'SSH terminal session is no longer active.', 410);
    }
    return entry;
  };

  const finishSession = (sessionId, reason) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return false;
    activeSessions.delete(sessionId);
    const endedAt = now();
    database.transaction(() => {
      database.run(
        `
          UPDATE remote_sessions
          SET state = 'closed', ended_at = ?, ended_reason = ?
          WHERE id = ? AND state = 'active'
        `,
        endedAt,
        reason,
        sessionId,
      );
      audit(
        entry.profile,
        sessionId,
        'terminal.session.closed',
        'succeeded',
        'SSH terminal session closed.',
        { reason },
      );
    });
    return true;
  };

  const verifyTrustedHost = async (profile) => {
    const observedKey = await transport.probeHostKey(profile);
    return hostKeyService.evaluateObservedKey(profile, observedKey);
  };

  const issueTerminalToken = async (profileId, dimensions = {}) => {
    const profile = requireProfile(profileId);
    const hostKey = await verifyTrustedHost(profile);
    if (hostKey.code !== 'HOST_KEY_TRUSTED') return hostKey;
    return {
      status: 'ready',
      ...tokenStore.issue({ profileId: profile.id, ...dimensions }),
      hostKey,
    };
  };

  const openTerminal = async (token) => {
    const request = tokenStore.consume(token);
    const profile = requireProfile(request.profileId);
    const hostKey = await verifyTrustedHost(profile);
    if (hostKey.code !== 'HOST_KEY_TRUSTED') {
      throw buildTerminalError(hostKey.code, 'SSH host key is not trusted for this terminal.', 409);
    }

    const sessionId = createId();
    const startedAt = now();
    database.run(
      `
        INSERT INTO remote_sessions
          (id, connection_profile_id, device_id, session_kind, protocol, actor_type,
           state, host_key_id, transcript_policy, remote_address, started_at)
        VALUES (?, ?, ?, 'terminal', 'ssh', 'human', 'opening', ?, 'metadata_only', ?, ?)
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
        throw buildTerminalError('SSH_CREDENTIAL_UNAVAILABLE', 'SSH password is unavailable.', 503);
      }
      const dimensions = normalizeTerminalDimensions(request);
      const terminal = await transport.openTerminal(profile, password, hostKey, {
        term: 'xterm-256color',
        ...dimensions,
      });
      const authenticatedAt = now();
      database.transaction(() => {
        database.run(
          "UPDATE remote_sessions SET state = 'active', authenticated_at = ? WHERE id = ? AND state = 'opening'",
          authenticatedAt,
          sessionId,
        );
        audit(
          profile,
          sessionId,
          'terminal.session.opened',
          'succeeded',
          'SSH terminal session opened.',
          { authentication: 'password' },
        );
      });
      activeSessions.set(sessionId, { profile, terminal });
      terminal.onClose(() => {
        finishSession(sessionId, 'remote_closed');
      });
      return {
        sessionId,
        onData(listener) {
          return terminal.onData(listener);
        },
        onClose(listener) {
          return terminal.onClose(listener);
        },
      };
    } catch (error) {
      const errorCode = error?.code || 'SSH_TERMINAL_OPEN_FAILED';
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
          'terminal.session.failed',
          'failed',
          'SSH terminal session failed to open.',
          { errorCode },
        );
      });
      throw error;
    }
  };

  const write = (sessionId, data) => {
    requireActiveSession(sessionId).terminal.write(data);
  };

  const resize = (sessionId, dimensions) => {
    requireActiveSession(sessionId).terminal.resize(normalizeTerminalDimensions(dimensions));
  };

  const close = (sessionId, reason = 'operator_closed') => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return;
    finishSession(sessionId, reason);
    entry.terminal.close();
  };

  const closeAll = (reason = 'server_stopped') => {
    for (const sessionId of [...activeSessions.keys()]) {
      close(sessionId, reason);
    }
  };

  return {
    issueTerminalToken,
    openTerminal,
    write,
    resize,
    close,
    closeAll,
  };
};
