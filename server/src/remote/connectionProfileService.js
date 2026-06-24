import { createHash, randomUUID } from 'node:crypto';

const buildValidationError = (message) => {
  const error = new Error(message);
  error.code = 'REMOTE_PROFILE_INVALID';
  error.statusCode = 400;
  return error;
};

const buildConflictError = (message) => {
  const error = new Error(message);
  error.code = 'REMOTE_PROFILE_CONFLICT';
  error.statusCode = 409;
  return error;
};

const normalizeProtocol = (value) => {
  const protocol = String(value || 'ssh').toLowerCase();
  if (protocol !== 'ssh' && protocol !== 'telnet') {
    throw buildValidationError('远程协议必须是 SSH 或 TELNET。');
  }
  return protocol;
};

const protocolLabel = (protocol) => protocol === 'telnet' ? 'TELNET' : 'SSH';

const resolveCreateAuthMethod = (payload, protocol) => {
  const explicit = payload.authMethod === undefined ? '' : String(payload.authMethod || '').toLowerCase();
  if (protocol === 'ssh') {
    if (explicit && explicit !== 'password') {
      throw buildValidationError('当前阶段仅支持 SSH 密码认证配置。');
    }
    return 'password';
  }
  if (explicit) {
    if (explicit !== 'password' && explicit !== 'none') {
      throw buildValidationError('当前阶段仅支持 TELNET 密码认证或交互式登录配置。');
    }
    return explicit;
  }
  return String(payload.password || '') ? 'password' : 'none';
};

const resolvePort = (value, protocol = 'ssh') => {
  const port = Number(value ?? (protocol === 'telnet' ? 23 : 22));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw buildValidationError(`${protocolLabel(protocol)} 端口必须在 1 到 65535 之间。`);
  }
  return port;
};

const requireText = (value, label) => {
  const text = String(value || '').trim();
  if (!text) throw buildValidationError(`${label}不能为空。`);
  return text;
};

const secretFingerprint = (secret) => createHash('sha256').update(secret, 'utf8').digest('hex');

const toProfileResponse = (row) => ({
  id: row.id,
  deviceId: row.device_id,
  name: row.name,
  protocol: row.protocol,
  host: row.host,
  port: row.port,
  username: row.username,
  authMethod: row.auth_method,
  privateKeyPath: row.private_key_path || null,
  strictHostKeyChecking: Boolean(row.strict_host_key_checking),
  sftpEnabled: Boolean(row.sftp_enabled),
  encoding: row.encoding,
  connectTimeoutMs: row.connect_timeout_ms,
  keepaliveIntervalMs: row.keepalive_interval_ms,
  isDefault: Boolean(row.is_default),
  enabled: Boolean(row.enabled),
  hasPasswordCredential: Boolean(row.has_password_credential),
  hasPassphraseCredential: Boolean(row.has_passphrase_credential),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const PROFILE_SELECT = `
  SELECT p.*,
         CASE WHEN password_ref.id IS NULL OR password_ref.deleted_at IS NOT NULL THEN 0 ELSE 1 END
           AS has_password_credential,
         CASE WHEN passphrase_ref.id IS NULL OR passphrase_ref.deleted_at IS NOT NULL THEN 0 ELSE 1 END
           AS has_passphrase_credential
  FROM connection_profiles p
  LEFT JOIN credential_refs password_ref ON password_ref.id = p.password_credential_ref_id
  LEFT JOIN credential_refs passphrase_ref ON passphrase_ref.id = p.passphrase_credential_ref_id
`;

export const createConnectionProfileService = (database, secretStore, {
  now = () => new Date().toISOString(),
  createId = () => randomUUID(),
} = {}) => {
  const findDevice = (deviceId) => database.get(
    'SELECT id FROM devices WHERE id = ? AND deleted_at IS NULL',
    String(deviceId || '').trim(),
  );

  const listProfiles = async (deviceId) => database.all(
    `
      ${PROFILE_SELECT}
      WHERE p.device_id = ? AND p.deleted_at IS NULL
      ORDER BY p.is_default DESC, p.created_at ASC, p.id ASC
    `,
    String(deviceId || '').trim(),
  ).map(toProfileResponse);

  const getProfile = (profileId) => {
    const row = database.get(
      `
        ${PROFILE_SELECT}
        WHERE p.id = ? AND p.deleted_at IS NULL
      `,
      profileId,
    );
    return row ? toProfileResponse(row) : null;
  };

  const getProfileRow = (profileId) => database.get(
    `
      ${PROFILE_SELECT}
      WHERE p.id = ? AND p.deleted_at IS NULL
    `,
    profileId,
  );

  const requireProfileRow = (profileId) => {
    const row = getProfileRow(profileId);
    if (!row) throw buildValidationError(`连接配置未找到：${profileId}`);
    return row;
  };

  const clearOtherDefaults = (deviceId, profileId, at) => database.run(
    `
      UPDATE connection_profiles
      SET is_default = 0, updated_at = ?
      WHERE device_id = ? AND id <> ? AND is_default = 1 AND deleted_at IS NULL
    `,
    at,
    deviceId,
    profileId,
  );

  const createProfile = async (deviceId, payload = {}) => {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!findDevice(normalizedDeviceId)) {
      throw buildValidationError(`设备未找到：${normalizedDeviceId}`);
    }
    const protocol = normalizeProtocol(payload.protocol);
    const label = protocolLabel(protocol);

    const authMethod = resolveCreateAuthMethod(payload, protocol);
    const password = String(payload.password || '');
    if (authMethod === 'password' && !password) throw buildValidationError(`${label} 密码不能为空。`);

    const createdAt = now();
    const profileId = createId();
    const credentialId = authMethod === 'password' ? createId() : null;
    const vaultAccount = `profile:${profileId}:password`;
    const name = requireText(payload.name, '连接配置名称');
    const host = requireText(payload.host, `${label} Host`);
    const username = protocol === 'ssh'
      ? requireText(payload.username, `${label} 用户名`)
      : String(payload.username || '').trim();
    const port = resolvePort(payload.port, protocol);
    const isDefault = payload.isDefault ? 1 : 0;
    const strictHostKeyChecking = protocol === 'ssh' ? 1 : 0;
    const sftpEnabled = protocol === 'ssh' && payload.sftpEnabled !== false ? 1 : 0;

    if (credentialId) {
      await secretStore.setSecret(vaultAccount, password);
    }
    try {
      database.transaction(() => {
        if (isDefault) clearOtherDefaults(normalizedDeviceId, profileId, createdAt);
        if (credentialId) {
          database.run(
            `
              INSERT INTO credential_refs
                (id, credential_type, vault_provider, vault_service, vault_account, label,
                 secret_fingerprint, created_at, updated_at)
              VALUES (?, 'password', ?, ?, ?, ?, ?, ?, ?)
            `,
            credentialId,
            String(secretStore.provider || 'system-vault'),
            String(secretStore.service || 'opsdog.remote'),
            vaultAccount,
            `${name} password`,
            secretFingerprint(password),
            createdAt,
            createdAt,
          );
        }
        database.run(
          `
            INSERT INTO connection_profiles
              (id, device_id, name, protocol, host, port, username, auth_method,
               password_credential_ref_id, strict_host_key_checking, sftp_enabled,
               encoding, connect_timeout_ms, keepalive_interval_ms, is_default,
               enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'utf-8', ?, ?, ?, 1, ?, ?)
          `,
          profileId,
          normalizedDeviceId,
          name,
          protocol,
          host,
          port,
          username,
          authMethod,
          credentialId,
          strictHostKeyChecking,
          sftpEnabled,
          Number(payload.connectTimeoutMs || 10000),
          Number(payload.keepaliveIntervalMs ?? 15000),
          isDefault,
          createdAt,
          createdAt,
        );
        if (credentialId) {
          database.run(
            `
              INSERT INTO audit_events
                (id, event_type, device_id, connection_profile_id, risk_level,
                 outcome, summary, detail_json, created_at)
              VALUES (?, 'credential.created', ?, ?, 'state-change', 'succeeded', ?, ?, ?)
            `,
            createId(),
            normalizedDeviceId,
            profileId,
            `Credential saved for ${label} profile ${name}.`,
            JSON.stringify({ credentialRefId: credentialId, label: `${name} password` }),
            createdAt,
          );
        } else {
          database.run(
            `
              INSERT INTO audit_events
                (id, event_type, device_id, connection_profile_id, risk_level,
                 outcome, summary, detail_json, created_at)
              VALUES (?, 'connection_profile.created', ?, ?, 'state-change', 'succeeded', ?, ?, ?)
            `,
            createId(),
            normalizedDeviceId,
            profileId,
            `${label} profile created for interactive login: ${name}.`,
            JSON.stringify({ profileId, authentication: 'interactive' }),
            createdAt,
          );
        }
      });
    } catch (error) {
      if (credentialId) {
        await secretStore.deleteSecret(vaultAccount).catch(() => {});
      }
      throw error;
    }

    return getProfile(profileId);
  };

  const updateProfile = async (profileId, payload = {}) => {
    const existing = requireProfileRow(String(profileId || '').trim());
    const protocol = payload.protocol === undefined ? existing.protocol : normalizeProtocol(payload.protocol);
    const label = protocolLabel(protocol);
    if (payload.authMethod !== undefined) {
      const authMethod = String(payload.authMethod || '').toLowerCase();
      const allowed = protocol === 'telnet' ? ['password', 'none'] : ['password'];
      if (!allowed.includes(authMethod)) {
        throw buildValidationError(`当前阶段仅支持 ${label} ${protocol === 'telnet' ? '密码认证或交互式登录' : '密码认证'}配置。`);
      }
    }

    const at = now();
    const name = payload.name === undefined ? existing.name : requireText(payload.name, '连接配置名称');
    const host = payload.host === undefined ? existing.host : requireText(payload.host, `${label} Host`);
    const username = payload.username === undefined
      ? existing.username
      : protocol === 'ssh'
        ? requireText(payload.username, `${label} 用户名`)
        : String(payload.username || '').trim();
    const port = payload.port === undefined ? existing.port : resolvePort(payload.port, protocol);
    const strictHostKeyChecking = protocol === 'ssh' ? 1 : 0;
    const sftpEnabled = protocol === 'ssh'
      ? payload.sftpEnabled === undefined
        ? existing.sftp_enabled
        : payload.sftpEnabled ? 1 : 0
      : 0;
    const connectTimeoutMs = payload.connectTimeoutMs === undefined
      ? existing.connect_timeout_ms
      : Number(payload.connectTimeoutMs);
    const keepaliveIntervalMs = payload.keepaliveIntervalMs === undefined
      ? existing.keepalive_interval_ms
      : Number(payload.keepaliveIntervalMs);
    const isDefault = payload.isDefault === undefined
      ? existing.is_default
      : payload.isDefault ? 1 : 0;
    const enabled = payload.enabled === undefined
      ? existing.enabled
      : payload.enabled ? 1 : 0;
    const replacementPassword = payload.password === undefined ? null : String(payload.password);
    if (replacementPassword !== null && !replacementPassword) {
      throw buildValidationError(`${label} 密码不能为空。`);
    }

    const credential = replacementPassword === null ? null : database.get(
      'SELECT * FROM credential_refs WHERE id = ? AND deleted_at IS NULL',
      existing.password_credential_ref_id,
    );
    if (replacementPassword !== null && !credential) {
      throw buildValidationError('SSH 密码凭据引用不存在。');
    }

    let previousSecret = null;
    if (credential) {
      previousSecret = await secretStore.getSecret(credential.vault_account);
      await secretStore.setSecret(credential.vault_account, replacementPassword);
    }

    try {
      database.transaction(() => {
        if (isDefault) clearOtherDefaults(existing.device_id, existing.id, at);
        database.run(
          `
            UPDATE connection_profiles
            SET name = ?, protocol = ?, host = ?, port = ?, username = ?,
                strict_host_key_checking = ?, sftp_enabled = ?,
                connect_timeout_ms = ?, keepalive_interval_ms = ?, is_default = ?,
                enabled = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
          `,
          name,
          protocol,
          host,
          port,
          username,
          strictHostKeyChecking,
          sftpEnabled,
          connectTimeoutMs,
          keepaliveIntervalMs,
          isDefault,
          enabled,
          at,
          existing.id,
        );

        if (credential) {
          database.run(
            'UPDATE credential_refs SET secret_fingerprint = ?, updated_at = ? WHERE id = ?',
            secretFingerprint(replacementPassword),
            at,
            credential.id,
          );
          database.run(
            `
              INSERT INTO audit_events
                (id, event_type, device_id, connection_profile_id, risk_level,
                 outcome, summary, detail_json, created_at)
              VALUES (?, 'credential.updated', ?, ?, 'state-change', 'succeeded', ?, ?, ?)
            `,
            createId(),
            existing.device_id,
            existing.id,
            `Credential updated for ${label} profile ${name}.`,
            JSON.stringify({ credentialRefId: credential.id, label: credential.label }),
            at,
          );
        } else {
          database.run(
            `
              INSERT INTO audit_events
                (id, event_type, device_id, connection_profile_id, risk_level,
                 outcome, summary, detail_json, created_at)
              VALUES (?, 'connection_profile.updated', ?, ?, 'state-change', 'succeeded', ?, ?, ?)
            `,
            createId(),
            existing.device_id,
            existing.id,
            `${label} profile updated: ${name}.`,
            JSON.stringify({ profileId: existing.id }),
            at,
          );
        }
      });
    } catch (error) {
      if (credential) {
        if (previousSecret === null) {
          await secretStore.deleteSecret(credential.vault_account).catch(() => {});
        } else {
          await secretStore.setSecret(credential.vault_account, previousSecret).catch(() => {});
        }
      }
      throw error;
    }

    return getProfile(existing.id);
  };

  const deleteProfile = async (profileId, { deleteCredential = true } = {}) => {
    const existing = requireProfileRow(String(profileId || '').trim());
    const activeSession = database.get(
      `
        SELECT id
        FROM remote_sessions
        WHERE connection_profile_id = ?
          AND state IN ('opening', 'active', 'closing')
        LIMIT 1
      `,
      existing.id,
    );
    if (activeSession) {
      throw buildConflictError('连接配置存在活跃会话，暂不能删除。');
    }

    const at = now();
    const credential = deleteCredential && existing.password_credential_ref_id
      ? database.get(
          'SELECT * FROM credential_refs WHERE id = ? AND deleted_at IS NULL',
          existing.password_credential_ref_id,
        )
      : null;
    let previousSecret = null;
    if (credential) {
      previousSecret = await secretStore.getSecret(credential.vault_account);
      await secretStore.deleteSecret(credential.vault_account);
    }

    try {
      database.transaction(() => {
        database.run(
          'UPDATE connection_profiles SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?',
          at,
          at,
          existing.id,
        );
        if (credential) {
          database.run(
            'UPDATE credential_refs SET deleted_at = ?, updated_at = ? WHERE id = ?',
            at,
            at,
            credential.id,
          );
        }
        database.run(
          `
            INSERT INTO audit_events
              (id, event_type, device_id, connection_profile_id, risk_level,
               outcome, summary, detail_json, created_at)
            VALUES (?, ?, ?, ?, 'state-change', 'succeeded', ?, ?, ?)
          `,
          createId(),
          credential ? 'credential.deleted' : 'connection_profile.deleted',
          existing.device_id,
          existing.id,
          `${protocolLabel(existing.protocol)} profile deleted: ${existing.name}.`,
          JSON.stringify({
            profileId: existing.id,
            ...(credential ? { credentialRefId: credential.id, label: credential.label } : {}),
          }),
          at,
        );
      });
    } catch (error) {
      if (credential && previousSecret !== null) {
        await secretStore.setSecret(credential.vault_account, previousSecret).catch(() => {});
      }
      throw error;
    }

    return { ok: true, profileId: existing.id };
  };

  return {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    deleteProfile,
  };
};
