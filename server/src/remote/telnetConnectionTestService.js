import { randomUUID } from 'node:crypto';

const buildServiceError = (code, message, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const createTelnetConnectionTestService = (
  database,
  secretStore,
  transport,
  {
    now = () => new Date().toISOString(),
    createId = () => randomUUID(),
  } = {},
) => {
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
      throw buildServiceError('REMOTE_PROFILE_INVALID', 'TELNET connection profile was not found.', 400);
    }
    if (row.protocol !== 'telnet' || (row.auth_method !== 'password' && row.auth_method !== 'none')) {
      throw buildServiceError('TELNET_UNSUPPORTED', 'TELNET connection testing is unavailable.', 400);
    }
    if (!row.enabled) {
      throw buildServiceError('TELNET_CONNECTION_DISABLED', 'TELNET connection profile is disabled.', 409);
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

  const recordConnectionTest = (profile, outcome, detail = {}) => {
    const at = now();
    database.run(
      `
        INSERT INTO audit_events
          (id, event_type, device_id, connection_profile_id, risk_level,
           outcome, summary, detail_json, created_at)
        VALUES (?, 'telnet.connection.tested', ?, ?, 'read-only', ?, ?, ?, ?)
      `,
      createId(),
      profile.deviceId,
      profile.id,
      outcome,
      `TELNET connection test ${outcome} for ${profile.host}:${profile.port}.`,
      JSON.stringify({
        host: profile.host,
        port: profile.port,
        ...detail,
      }),
      at,
    );
  };

  const testConnection = async (profileId) => {
    const profile = requireProfile(profileId);
    try {
      let credentials = null;
      if (profile.authMethod === 'password') {
        if (!profile.vaultAccount) {
          throw buildServiceError('TELNET_CREDENTIAL_UNAVAILABLE', 'TELNET password is unavailable.', 503);
        }
        const password = await secretStore.getSecret(profile.vaultAccount);
        if (!password) {
          throw buildServiceError('TELNET_CREDENTIAL_UNAVAILABLE', 'TELNET password is unavailable.', 503);
        }
        credentials = { password };
      }
      const result = await transport.testConnection(profile, credentials);
      recordConnectionTest(profile, 'succeeded', {
        authenticated: Boolean(result.authenticated),
      });
      return {
        status: 'connected',
        protocol: 'telnet',
        profileId: profile.id,
        host: profile.host,
        port: profile.port,
        authenticated: Boolean(result.authenticated),
        sftpAvailable: false,
        checkedAt: now(),
      };
    } catch (error) {
      recordConnectionTest(profile, 'failed', {
        errorCode: error?.code || 'TELNET_CONNECTION_FAILED',
      });
      throw error;
    }
  };

  return {
    testConnection,
  };
};
