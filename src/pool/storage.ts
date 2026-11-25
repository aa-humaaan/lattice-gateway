import {
  chmodSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, closeSync,
  readFileSync, renameSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import { globalSecretStore, type SecretStore } from '../core/secret-store';
import { moveSecretsToStore, OVERLAY_KEYS } from '../core/credential-resolver';
import { globalAccountPool, type RuntimeSnapshot } from './account-pool';
import { globalComboManager } from './combos';
import { globalProxyPool } from './proxy-pool';

export const STORE_SCHEMA_VERSION = 2;

export interface PersistentData {
  schemaVersion: number;
  accounts: any[];
  combos: any[];
  proxies: any[];
  runtime?: RuntimeSnapshot;
  updatedAt: number;
}

export type StoreMigration = (data: any, fromVersion: number) => any;

const migrations = new Map<number, StoreMigration>();

/** Register a migration that upgrades `fromVersion` to `fromVersion + 1`. */
export function registerStoreMigration(fromVersion: number, migration: StoreMigration): void {
  migrations.set(fromVersion, migration);
}

// v1 stores carried a non-standard legacy quota field on accounts.
registerStoreMigration(1, (data) => {
  for (const acc of data.accounts ?? []) {
    if (acc.legacyQuota !== undefined && acc.quotaRemaining === undefined) {
      acc.quotaRemaining = acc.legacyQuota;
      delete acc.legacyQuota;
    }
  }
  return data;
});

export class LatticeStorage {
  private dataDir: string;
  private filePath: string;
  private secretStore: SecretStore;

  constructor(dataDir = process.env.DATA_DIR || 'data', secretStore: SecretStore = globalSecretStore) {
    this.dataDir = dataDir;
    this.secretStore = secretStore;
    this.filePath = join(dataDir, 'lattice-store.json');
    this.ensureDir();
    globalAccountPool.setPersistenceHook(() => this.save());
    this.load();
  }

  private ensureDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private quarantine(reason: string): never {
    const destination = `${this.filePath}.corrupt-${this.stamp()}`;
    copyFileSync(this.filePath, destination);
    try { chmodSync(destination, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
    logger.error(`[Storage] CORRUPT STORE at ${this.filePath}: ${reason}. Quarantined to ${destination}. Refusing to start with an empty state.`);
    throw new Error(`corrupt store ${this.filePath}: ${reason}; quarantined to ${destination}`);
  }

  private backup(): void {
    const destination = `${this.filePath}.backup-${this.stamp()}`;
    copyFileSync(this.filePath, destination);
    try { chmodSync(destination, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
    logger.warn(`[Storage] Backing up pre-migration store to ${destination}`);
  }

  /** Move any credential material still carried in accounts into the secret store. */
  private migratePlaintextSecrets(data: PersistentData): boolean {
    let changed = false;
    for (const acc of data.accounts ?? []) {
      const credentials = acc?.credentials;
      if (!credentials || typeof credentials !== 'object') continue;
      const carriesSecret = OVERLAY_KEYS.some((key) => {
        const value = credentials[key];
        return value !== undefined && value !== null && value !== '';
      });
      if (!carriesSecret) continue;
      acc.credentials = moveSecretsToStore(this.secretStore, acc.id, credentials);
      changed = true;
    }
    return changed;
  }

  /** Write to a temp file in the same directory, fsync, then atomically rename. */
  private writeAtomic(data: PersistentData): void {
    this.ensureDir();
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(temp, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
    renameSync(temp, this.filePath);
    try { chmodSync(this.filePath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = readFileSync(this.filePath, 'utf-8').replace(/^\ufeff/, '');
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (err: any) {
      this.quarantine(`invalid JSON (${err?.message || err})`);
    }
    if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.combos) || !Array.isArray(data.proxies)) {
      this.quarantine('unrecognised store shape');
    }

    const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 1;
    if (version > STORE_SCHEMA_VERSION) {
      this.quarantine(`schemaVersion ${version} is newer than supported ${STORE_SCHEMA_VERSION}`);
    }
    let needsWrite = false;
    if (version < STORE_SCHEMA_VERSION) {
      this.backup();
      let upgraded = data;
      for (let v = version; v < STORE_SCHEMA_VERSION; v++) {
        const migration = migrations.get(v);
        if (!migration) this.quarantine(`no migration from schemaVersion ${v}`);
        upgraded = migration(upgraded, v);
      }
      upgraded.schemaVersion = STORE_SCHEMA_VERSION;
      data = upgraded;
      needsWrite = true;
    }
    if (this.migratePlaintextSecrets(data)) needsWrite = true;
    if (needsWrite) this.writeAtomic(data as PersistentData);

    for (const acc of data.accounts) globalAccountPool.addAccount(acc);
    for (const c of data.combos) globalComboManager.createCombo(c);
    for (const p of data.proxies) globalProxyPool.addProxy(p.url, p.type);
    globalAccountPool.restoreRuntimeState(data.runtime);
    logger.info(`[Storage] Loaded state from ${this.filePath} (schemaVersion ${data.schemaVersion})`);
  }

  save(): void {
    try {
      const payload: PersistentData = {
        schemaVersion: STORE_SCHEMA_VERSION,
        accounts: globalAccountPool.listAccounts(),
        combos: globalComboManager.listCombos(),
        proxies: globalProxyPool.listProxies(),
        runtime: globalAccountPool.snapshotRuntimeState(),
        updatedAt: Date.now(),
      };
      this.writeAtomic(payload);
    } catch (err) {
      logger.error(`[Storage] Failed to save state to ${this.filePath}:`, err);
    }
  }
}

export const globalStorage = new LatticeStorage();
