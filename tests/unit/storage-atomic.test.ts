import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LatticeStorage, STORE_SCHEMA_VERSION } from '../../src/pool/storage';
import { globalAccountPool } from '../../src/pool/account-pool';

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-atomic-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const account = (id: string) => ({
  id, providerId: 'kilo', authType: 'api_key', status: 'active',
  credentials: {}, createdAt: 1, updatedAt: 1, errorCount: 0,
});

describe('P0-1: durable store', () => {
  it('a crash mid-write (leftover temp) leaves the previous file valid and loaded', () => {
    withDir((dir) => {
      const file = join(dir, 'lattice-store.json');
      const id = 'acc_atomic_previous';
      writeFileSync(file, JSON.stringify({
        schemaVersion: STORE_SCHEMA_VERSION, accounts: [account(id)],
        combos: [], proxies: [], updatedAt: 1,
      }));
      writeFileSync(`${file}.tmp`, '{"accounts":[{"id":"acc_half_written"');

      const storage = new LatticeStorage(dir);
      try {
        expect(globalAccountPool.getAccount(id)?.providerId).toBe('kilo');
        expect(globalAccountPool.getAccount('acc_half_written')).toBeUndefined();
        expect(JSON.parse(readFileSync(file, 'utf8')).accounts[0].id).toBe(id);

        storage.save();
        expect(existsSync(`${file}.tmp`)).toBeFalse();
        expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(STORE_SCHEMA_VERSION);
      } finally {
        globalAccountPool.deleteAccount(id);
      }
    });
  });

  it('a corrupt store is quarantined, reported and never replaced silently', () => {
    withDir((dir) => {
      const file = join(dir, 'lattice-store.json');
      const corrupt = '{ this is not json';
      writeFileSync(file, corrupt);

      let thrown = '';
      try { new LatticeStorage(dir); } catch (err) { thrown = String(err); }
      expect(thrown).toContain('corrupt');

      expect(readFileSync(file, 'utf8')).toBe(corrupt);
      const quarantined = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
      expect(quarantined.length).toBe(1);
      expect(readFileSync(join(dir, quarantined[0]), 'utf8')).toBe(corrupt);
    });
  });

  it('a restart restores quota and cooldown snapshots', () => {
    withDir((dir) => {
      const file = join(dir, 'lattice-store.json');
      const id = 'acc_runtime_restore';
      const acc = account(id);
      writeFileSync(file, JSON.stringify({
        schemaVersion: STORE_SCHEMA_VERSION,
        accounts: [{
          ...acc,
          status: 'cooldown',
          cooldownUntil: 9999999999999,
          cooldownReason: 'Rate limit 429',
          quotaRemaining: 0,
          quotaLimit: 500,
          quotaResetAt: 9999999999999,
        }],
        combos: [], proxies: [], updatedAt: 1,
      }));

      new LatticeStorage(dir);
      try {
        const restored = globalAccountPool.getAccount(id)!;
        expect(restored.status).toBe('cooldown');
        expect(restored.cooldownUntil).toBe(9999999999999);
        expect(restored.quotaRemaining).toBe(0);
        expect(restored.quotaLimit).toBe(500);
      } finally {
        globalAccountPool.deleteAccount(id);
      }
    });
  });

  it('migrates an older store and keeps a backup of the original', () => {
    withDir((dir) => {
      const file = join(dir, 'lattice-store.json');
      const id = 'acc_migrated';
      const original = JSON.stringify({
        schemaVersion: 1,
        accounts: [{ ...account(id), legacyQuota: 42 }],
        combos: [], proxies: [], updatedAt: 1,
      });
      writeFileSync(file, original);

      const storage = new LatticeStorage(dir);
      try {
        expect(globalAccountPool.getAccount(id)?.quotaRemaining).toBe(42);
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        expect(saved.schemaVersion).toBe(STORE_SCHEMA_VERSION);
        const backups = readdirSync(dir).filter((f) => f.includes('.backup-'));
        expect(backups.length).toBe(1);
        expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe(original);
      } finally {
        globalAccountPool.deleteAccount(id);
      }
    });
  });
});
