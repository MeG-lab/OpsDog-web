import { randomUUID } from 'node:crypto';

const buildServiceError = (code, message, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const createSshConnectionTestService = (
  database,
  secretStore,
  transport,
  hostKeyService,
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
      throw buildServiceError('REMOTE_PROFILE_INVALID', 'SSH connection profile was not found.', 400);
    }
    if (row.protocol !== 'ssh' || row.auth_method !== 'password' || !row.vault_account) {
      throw buildServiceError('SSH_CONNECTION_UNSUPPORTED', 'SSH password connection testing is unavailable.', 400);
    }
    if (!row.enabled) {
      throw buildServiceError('SSH_CONNECTION_DISABLED', 'SSH connection profile is disabled.', 409);
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

  const recordConnectionTest = (profile, outcome, hostKey, detail = {}) => {
    const at = now();
    database.run(
      `
        INSERT INTO audit_events
          (id, event_type, device_id, connection_profile_id, risk_level,
           outcome, summary, detail_json, created_at)
        VALUES (?, ?, ?, ?, 'read-only', ?, ?, ?, ?)
      `,
      createId(),
      `ssh.connection_test.${outcome}`,
      profile.deviceId,
      profile.id,
      outcome,
      `SSH connection test ${outcome} for ${profile.host}:${profile.port}.`,
      JSON.stringify({
        host: profile.host,
        port: profile.port,
        fingerprintSha256: hostKey.fingerprintSha256,
        ...detail,
      }),
      at,
    );
  };

  const probeHostKey = async (profileId) => {
    const profile = requireProfile(profileId);
    const observedKey = await transport.probeHostKey(profile);
    return hostKeyService.evaluateObservedKey(profile, observedKey);
  };

  const trustHostKey = (profileId, payload = {}) => {
    const profile = requireProfile(profileId);
    return hostKeyService.approveFirstSeen(profile, payload.challengeToken);
  };

  const listHostKeys = (profileId) => {
    requireProfile(profileId);
    return hostKeyService.listHostKeys(profileId);
  };

  const testConnection = async (profileId) => {
    const profile = requireProfile(profileId);
    const observedKey = await transport.probeHostKey(profile);
    const hostKey = hostKeyService.evaluateObservedKey(profile, observedKey);
    if (hostKey.code !== 'HOST_KEY_TRUSTED') return hostKey;

    try {
      const password = await secretStore.getSecret(profile.vaultAccount);
      if (!password) {
        throw buildServiceError('SSH_CREDENTIAL_UNAVAILABLE', 'SSH password is unavailable.', 503);
      }
      const capability = await transport.testPasswordConnection(profile, password, hostKey);
      recordConnectionTest(profile, 'succeeded', hostKey, {
        authentication: 'password',
        sftpAvailable: capability.sftpAvailable,
      });
      return {
        status: 'succeeded',
        authentication: 'password',
        sftpAvailable: capability.sftpAvailable,
        hostKey,
      };
    } catch (error) {
      recordConnectionTest(profile, 'failed', hostKey, {
        errorCode: error?.code || 'SSH_CONNECTION_FAILED',
      });
      throw error;
    }
  };

  return {
    probeHostKey,
    trustHostKey,
    listHostKeys,
    testConnection,
  };
};
