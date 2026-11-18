import type { StoredAccount } from './types/plugin';
import { globalSecretStore, type SecretStore } from './secret-store';

/** Only imported accounts keep their secrets exclusively in the secret store. */
export const IMPORTED_ACCOUNT_PREFIX = 'acc_import_';

export const OVERLAY_KEYS = [
  'accessToken',
  'refreshToken',
  'apiKey',
  'cookies',
  'organizationId',
  'accountId',
  'baseUrl',
] as const;

export interface CredentialResolver {
  credentialsFor(account: StoredAccount | undefined): StoredAccount['credentials'];
  storeCredential(accountId: string, key: string, value: string): void;
}

export function createCredentialResolver(store: SecretStore): CredentialResolver {
  return {
    storeCredential(accountId, key, value) { store.set(accountId, key, value); },
    credentialsFor(account) {
      const base = account?.credentials ?? {};
      const overlay: Record<string, unknown> = {};
      if (!account) return base;
      const secretBacked =
        account.id.startsWith(IMPORTED_ACCOUNT_PREFIX) ||
        base.customData?.secretBacked === true;
      if (!secretBacked) return base;
      // Imported and manually added accounts resolve secrets at use time, so
      // credential material never has to live in lattice-store.json.
      for (const key of OVERLAY_KEYS) {
        const value = store.get(account.id, key);
        if (value !== undefined) overlay[key] = value;
      }
      return { ...base, ...overlay } as StoredAccount['credentials'];
    },
  };
}

export const globalCredentialResolver = createCredentialResolver(globalSecretStore);

/** Strips credential material from an account record before it is persisted. */
export function moveSecretsToStore(
  store: SecretStore,
  accountId: string,
  credentials: StoredAccount['credentials']
): StoredAccount['credentials'] {
  const result: Record<string, unknown> = { ...credentials };
  for (const key of OVERLAY_KEYS) {
    const value = result[key];
    if (value === undefined || value === null || value === '') continue;
    store.set(accountId, key, typeof value === 'string' ? value : JSON.stringify(value));
    delete result[key];
  }
  result.customData = { ...(result.customData ?? {}), secretBacked: true };
  return result as StoredAccount['credentials'];
}
