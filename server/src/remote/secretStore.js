const DEFAULT_SERVICE = 'opsdog.remote';

export class SecretStoreUnavailableError extends Error {
  constructor(message = 'System credential vault is unavailable.') {
    super(message);
    this.name = 'SecretStoreUnavailableError';
    this.code = 'SECRET_STORE_UNAVAILABLE';
    this.statusCode = 503;
  }
}

export const createUnavailableSecretStore = ({
  provider = 'unavailable',
  service = DEFAULT_SERVICE,
} = {}) => {
  const unavailable = async () => {
    throw new SecretStoreUnavailableError();
  };

  return {
    provider,
    service,
    setSecret: unavailable,
    getSecret: unavailable,
    deleteSecret: unavailable,
  };
};

export const createKeyringSecretStore = async ({
  provider = 'keyring',
  service = DEFAULT_SERVICE,
  loadKeyring = () => import('@napi-rs/keyring'),
} = {}) => {
  try {
    const { Entry } = await loadKeyring();
    const entryFor = (account) => new Entry(service, account);
    const runOperation = async (operation) => {
      try {
        return await operation();
      } catch {
        throw new SecretStoreUnavailableError();
      }
    };

    return {
      provider,
      service,
      setSecret: (account, secret) => runOperation(() => entryFor(account).setPassword(secret)),
      getSecret: (account) => runOperation(() => entryFor(account).getPassword()),
      deleteSecret: (account) => runOperation(() => entryFor(account).deletePassword()),
    };
  } catch {
    return createUnavailableSecretStore({ provider, service });
  }
};

export const SECRET_STORE_SERVICE = DEFAULT_SERVICE;
