import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import type { StoredAccount } from './types/plugin';
import { globalAccountPool } from '../pool/account-pool';
import type { SecretStore } from './secret-store';
import { IMPORTED_ACCOUNT_PREFIX } from './credential-resolver';

export type ImportSource = 'jsonAccounts' | 'sqlite9router';

interface RawRecord {
  provider: string;
  email?: string;
  authType?: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
}

interface PendingImport {
  digest: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  records: RawRecord[];
}

export interface ImportPreview {
  token: string;
  source: ImportSource;
  count: number;
  providers: string[];
  digest: string;
  expiresAt: number;
}

export interface ImportResult {
  count: number;
  accountIds: string[];
}

function digestOf(records: RawRecord[]): string {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function readJsonAccounts(path: string): RawRecord[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { accounts?: RawRecord[] };
  if (!Array.isArray(parsed.accounts)) throw new Error('Import file must contain an accounts array');
  return parsed.accounts.filter((record) => record && typeof record === 'object');
}

function readSqlite9router(path: string): RawRecord[] {
  // Kept as a named adapter for a caller that supplies an already-materialized
  // export. Raw SQLite parsing is intentionally not performed here: importing
  // requires an explicit operator-supplied JSON export, never a live DB path.
  return readJsonAccounts(path);
}

const READERS: Record<ImportSource, (path: string) => RawRecord[]> = {
  jsonAccounts: readJsonAccounts,
  sqlite9router: readSqlite9router,
};

export function createImportManager(secretStore: SecretStore, ttlMs = 60_000) {
  const pending = new Map<string, PendingImport>();

  return {
    preview(source: ImportSource, path: string): ImportPreview {
      if (!source || !(source in READERS)) throw new Error(`Unsupported import source: ${source}`);
      if (!path || typeof path !== 'string') throw new Error('An explicit import path is required');
      if (!existsSync(path)) throw new Error(`Import path does not exist: ${path}`);
      const records = READERS[source](path);
      const digest = digestOf(records);
      const token = randomBytes(24).toString('hex');
      const createdAt = Date.now();
      const entry: PendingImport = {
        digest,
        token,
        createdAt,
        expiresAt: createdAt + ttlMs,
        records,
      };
      pending.set(token, entry);
      return {
        token,
        source,
        count: records.length,
        providers: Array.from(new Set(records.map((record) => record.provider))).sort(),
        digest,
        expiresAt: entry.expiresAt,
      };
    },

    confirm(token: string): ImportResult {
      const entry = pending.get(token);
      if (!entry || digestOf(entry.records) !== entry.digest) throw new Error('Invalid confirmation token');
      if (Date.now() >= entry.expiresAt) {
        pending.delete(token);
        throw new Error('Confirmation token expired');
      }
      pending.delete(token);
      const accountIds: string[] = [];
      for (const record of entry.records) {
        const accountId = `${IMPORTED_ACCOUNT_PREFIX}${randomBytes(6).toString('hex')}`;
        const secretFields: Array<[string, string | undefined]> = [
          ['accessToken', record.accessToken],
          ['refreshToken', record.refreshToken],
          ['apiKey', record.apiKey],
        ];
        for (const [key, value] of secretFields) {
          if (value) {
            secretStore.set(accountId, key, value);
          }
        }
        const account: StoredAccount = {
          id: accountId,
          providerId: record.provider,
          authType: (record.authType as StoredAccount['authType']) || 'oauth',
          status: 'active',
          credentials: {},
          errorCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        globalAccountPool.addAccount(account);
        accountIds.push(accountId);
      }
      return { count: accountIds.length, accountIds };
    },
  };
}

export const globalImportManager = createImportManager(
  (await import('./secret-store')).globalSecretStore
);
