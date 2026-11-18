import type { StoredAccount } from './types/plugin';
import { globalSecretStore, type SecretStore } from './secret-store';

/** Only imported accounts keep their secrets exclusively in the secret store. */
export const IMPORTED_ACCOUNT_PREFIX = 'acc_import_';

const OVERLAY_KEYS = [
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
      if (!account || !account.id.startsWith(IMPORTED_ACCOUNT_PREFIX)) return base;
      for (const key of OVERLAY_KEYS) {
        const value = store.get(account.id, key);
        if (value !== undefined) overlay[key] = value;
      }
      return { ...base, ...overlay } as StoredAccount['credentials'];
    },
  };
}

export const globalCredentialResolver = createCredentialResolver(globalSecretStore);
