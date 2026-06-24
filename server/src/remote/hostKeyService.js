import { randomUUID } from 'node:crypto';

const buildHostKeyError = (code, message, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const toHostKeyResponse = (row) => ({
  id: row.id,
  host: row.host,
  port: row.port,
  keyType: row.key_type,
  fingerprintSha256: row.fingerprint_sha256,
  trustStatus: row.trust_status,
  firstSeenAt: row.first_seen_at,
  trustedAt: row.trusted_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at,
});

const trustedResult = (row) => ({
  code: 'HOST_KEY_TRUSTED',
  ...toHostKeyResponse(row),
});

const requireProfile = (profile) => {
  const normalized = {
    id: String(profile?.id || '').trim(),
    deviceId: String(profile?.deviceId || '').trim(),
    host: String(profile?.host || '').trim(),
    port: Number(profile?.port),
  };
  if (!normalized.id || !normalized.deviceId || !normalized.host
      || !Number.isInteger(normalized.port)) {
    throw buildHostKeyError('HOST_KEY_REQUEST_INVALID', 'SSH connection profile is invalid.', 400);
  }
  return normalized;
};

const requireObservedKey = (profile, observedKey) => {
  const normalized = {
    host: String(observedKey?.host || '').trim(),
    port: Number(observedKey?.port),
    keyType: String(observedKey?.keyType || '').trim(),
    fingerprintSha256: String(observedKey?.fingerprintSha256 || '').trim(),
    publicKeyBase64: String(observedKey?.publicKeyBase64 || '').trim(),
  };
  if (normalized.host !== profile.host || normalized.port !== profile.port
      || !normalized.keyType || !normalized.fingerprintSha256 || !normalized.publicKeyBase64) {
    throw buildHostKeyError('HOST_KEY_REQUEST_INVALID', 'Observed SSH host key is invalid.', 400);
  }
  return normalized;
};

export const createHostKeyService = (database, challengeStore, {
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
} = {}) => {
  const findTrusted = (profile) => database.get(
    `
      SELECT *
      FROM ssh_host_keys
      WHERE host = ? AND port = ? AND trust_status = 'trusted'
      ORDER BY trusted_at ASC, id ASC
      LIMIT 1
    `,
    profile.host,
    profile.port,
  );

  const evaluateObservedKey = (inputProfile, inputObservedKey) => {
    const profile = requireProfile(inputProfile);
    const observedKey = requireObservedKey(profile, inputObservedKey);
    const trusted = findTrusted(profile);

    if (!trusted) {
      return {
        code: 'HOST_KEY_CONFIRMATION_REQUIRED',
        trustStatus: 'pending',
        host: observedKey.host,
        port: observedKey.port,
        keyType: observedKey.keyType,
        fingerprintSha256: observedKey.fingerprintSha256,
        challengeToken: challengeStore.issue({ profileId: profile.id, observedKey }),
      };
    }

    if (trusted.key_type !== observedKey.keyType
        || trusted.fingerprint_sha256 !== observedKey.fingerprintSha256) {
      return {
        code: 'HOST_KEY_MISMATCH',
        trustStatus: 'mismatch',
        host: observedKey.host,
        port: observedKey.port,
        keyType: observedKey.keyType,
        fingerprintSha256: observedKey.fingerprintSha256,
        previousFingerprintSha256: trusted.fingerprint_sha256,
      };
    }

    const seenAt = now();
    database.run('UPDATE ssh_host_keys SET last_seen_at = ? WHERE id = ?', seenAt, trusted.id);
    return trustedResult({ ...trusted, last_seen_at: seenAt });
  };

  const approveFirstSeen = (inputProfile, challengeToken) => {
    const profile = requireProfile(inputProfile);
    const observedKey = requireObservedKey(
      profile,
      challengeStore.consume(challengeToken, profile.id),
    );
    const alreadyTrusted = findTrusted(profile);
    if (alreadyTrusted) {
      if (alreadyTrusted.key_type === observedKey.keyType
          && alreadyTrusted.fingerprint_sha256 === observedKey.fingerprintSha256) {
        return trustedResult(alreadyTrusted);
      }
      throw buildHostKeyError('HOST_KEY_MISMATCH', 'SSH host key has changed.', 409);
    }

    const at = now();
    const hostKeyId = createId();
    database.transaction(() => {
      database.run(
        `
          INSERT INTO ssh_host_keys
            (id, host, port, key_type, fingerprint_sha256, public_key_base64,
             trust_status, first_seen_at, trusted_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, 'trusted', ?, ?, ?)
        `,
        hostKeyId,
        observedKey.host,
        observedKey.port,
        observedKey.keyType,
        observedKey.fingerprintSha256,
        observedKey.publicKeyBase64,
        at,
        at,
        at,
      );
      database.run(
        `
          INSERT INTO audit_events
            (id, event_type, device_id, connection_profile_id, risk_level,
             outcome, summary, detail_json, created_at)
          VALUES (?, 'host_key.approved', ?, ?, 'state-change', 'succeeded', ?, ?, ?)
        `,
        createId(),
        profile.deviceId,
        profile.id,
        `SSH host key approved for ${profile.host}:${profile.port}.`,
        JSON.stringify({
          host: observedKey.host,
          port: observedKey.port,
          keyType: observedKey.keyType,
          fingerprintSha256: observedKey.fingerprintSha256,
        }),
        at,
      );
    });

    return trustedResult(database.get('SELECT * FROM ssh_host_keys WHERE id = ?', hostKeyId));
  };

  const listHostKeys = (profileId) => {
    const profile = database.get(
      'SELECT host, port FROM connection_profiles WHERE id = ? AND deleted_at IS NULL',
      String(profileId || '').trim(),
    );
    if (!profile) {
      throw buildHostKeyError('HOST_KEY_REQUEST_INVALID', 'SSH connection profile was not found.', 400);
    }
    return database.all(
      `
        SELECT *
        FROM ssh_host_keys
        WHERE host = ? AND port = ?
        ORDER BY first_seen_at ASC, id ASC
      `,
      profile.host,
      profile.port,
    ).map(toHostKeyResponse);
  };

  return {
    evaluateObservedKey,
    approveFirstSeen,
    listHostKeys,
  };
};
