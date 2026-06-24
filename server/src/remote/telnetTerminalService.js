import { randomUUID } from 'node:crypto';
import { normalizeTerminalDimensions } from './terminalTokenStore.js';

const buildTerminalError = (code, message, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const createTelnetTerminalService = (
  database,
  secretStore,
  transport,
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
      throw buildTerminalError('REMOTE_PROFILE_INVALID', 'TELNET connection profile was not found.', 400);
    }
    if (row.protocol !== 'telnet' || (row.auth_method !== 'password' && row.auth_method !== 'none')) {
      throw buildTerminalError('TELNET_UNSUPPORTED', 'TELNET terminal sessions are unavailable.', 400);
    }
    if (!row.enabled) {
      throw buildTerminalError('TELNET_CONNECTION_DISABLED', 'TELNET connection profile is disabled.', 409);
    }
    return {
      id: row.id,
      deviceId: row.device_id,
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.auth_method,
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
      throw buildTerminalError('TERMINAL_SESSION_CLOSED', 'TELNET terminal session is no longer active.', 410);
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
        'telnet.session.closed',
        'succeeded',
        'TELNET terminal session closed.',
        { reason },
      );
    });
    return true;
  };

  const issueTerminalToken = async (profileId, dimensions = {}) => {
    const profile = requireProfile(profileId);
    return {
      status: 'ready',
      ...tokenStore.issue({ profileId: profile.id, ...dimensions }),
      protocol: 'telnet',
      plaintext: true,
    };
  };

  const openTerminal = async (token) => {
    const request = tokenStore.consume(token);
    const profile = requireProfile(request.profileId);
    const sessionId = createId();
    const startedAt = now();
    database.run(
      `
        INSERT INTO remote_sessions
          (id, connection_profile_id, device_id, session_kind, protocol, actor_type,
           state, host_key_id, transcript_policy, remote_address, started_at)
        VALUES (?, ?, ?, 'terminal', 'telnet', 'human', 'opening', NULL, 'metadata_only', ?, ?)
      `,
      sessionId,
      profile.id,
      profile.deviceId,
      `${profile.host}:${profile.port}`,
      startedAt,
    );

    try {
      let credentials = null;
      if (profile.authMethod === 'password') {
        if (!profile.vaultAccount) {
          throw buildTerminalError('TELNET_CREDENTIAL_UNAVAILABLE', 'TELNET password is unavailable.', 503);
        }
        const password = await secretStore.getSecret(profile.vaultAccount);
        if (!password) {
          throw buildTerminalError('TELNET_CREDENTIAL_UNAVAILABLE', 'TELNET password is unavailable.', 503);
        }
        credentials = { password };
      }
      const dimensions = normalizeTerminalDimensions(request);
      const terminal = await transport.openTerminal(profile, credentials, dimensions);
      const authenticatedAt = now();
      database.transaction(() => {
        database.run(
          "UPDATE remote_sessions SET state = 'active', authenticated_at = ? WHERE id = ? AND state = 'opening'",
          credentials ? authenticatedAt : null,
          sessionId,
        );
        audit(
          profile,
          sessionId,
          'telnet.session.opened',
          'succeeded',
          'TELNET terminal session opened.',
          { authentication: credentials ? 'password' : 'interactive', plaintext: true, ...dimensions },
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
      const errorCode = error?.code || 'TELNET_TERMINAL_OPEN_FAILED';
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
          'telnet.session.failed',
          'failed',
          'TELNET terminal session failed to open.',
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
