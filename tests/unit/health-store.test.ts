import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHealthStore, type HealthStatus } from '../../src/pool/health-store';
import { AccountPoolManager } from '../../src/pool/account-pool';
import type { StoredAccount } from '../../src/core/types/plugin';

function withDir(run: (dir: string, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-health-'));
  try { run(dir, join(dir, 'health.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function account(id: string): StoredAccount {
  return {
    id, providerId: 'kilo', authType: 'api_key', status: 'active',
    credentials: { apiKey: 'secret-should-never-persist' },
    createdAt: 1, updatedAt: 1, errorCount: 0,
  };
}

describe('persisted account health', () => {
  test('round-trips status and deadlines keyed by account name', () => {
    withDir((_dir, file) => {
      const store = createHealthStore(file);
      store.set('kilo/acc_1', { status: 'cooling', cooldownUntil: 12345, failures: 2 });
      expect(store.get('kilo/acc_1')).toEqual({ status: 'cooling', cooldownUntil: 12345, failures: 2 });
      expect(createHealthStore(file).get('kilo/acc_1')?.status).toBe('cooling');
    });
  });

  test('supports the HalfOpen probe state', () => {
    withDir((_dir, file) => {
      const store = createHealthStore(file);
      store.set('kilo/acc_1', { status: 'halfOpen', failures: 1 });
      expect(store.get('kilo/acc_1')?.status).toBe('halfOpen');
    });
  });

  test('never writes secrets into the health file', () => {
    withDir((_dir, file) => {
      const store = createHealthStore(file);
      store.set('kilo/acc_1', { status: 'cooling', cooldownUntil: 1, failures: 1, secret: 'SHOULD_NOT_APPEAR' } as any);
      expect(readFileSync(file, 'utf8')).not.toContain('SHOULD_NOT_APPEAR');
    });
  });

  test('corrupt file recovers to empty without deleting the original content', () => {
    withDir((_dir, file) => {
      writeFileSync(file, '{broken');
      const store = createHealthStore(file);
      expect(store.get('kilo/acc_1')).toBeUndefined();
      expect(readFileSync(file, 'utf8')).toBe('{broken');
    });
  });

  test('debounced flush writes pending changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-health-debounce-'));
    const file = join(dir, 'health.json');
    try {
      const store = createHealthStore(file, 5);
      store.set('kilo/acc_1', { status: 'cooling', cooldownUntil: 9, failures: 1 });
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(createHealthStore(file).get('kilo/acc_1')?.status).toBe('cooling');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('validates status values', () => {
    withDir((_dir, file) => {
      const store = createHealthStore(file);
      expect(() => store.set('a/b', { status: 'bogus' as HealthStatus, failures: 0 })).toThrow(/status/);
    });
  });

  test('a restart restores a cooling account and its deadline', () => {
    withDir((_dir, file) => {
      const store = createHealthStore(file);
      const first = new AccountPoolManager(store);
      first.addAccount(account('kilo/acc_persist'));
      first.reportRateLimit('kilo/acc_persist', 300);
      const deadline = first.getAccount('kilo/acc_persist')!.cooldownUntil!;

      const second = new AccountPoolManager(createHealthStore(file));
      second.addAccount(account('kilo/acc_persist'));
      const restored = second.getAccount('kilo/acc_persist')!;
      expect(restored.status).toBe('cooldown');
      expect(restored.cooldownUntil).toBe(deadline);
      expect(second.getActiveAccounts('kilo')).toHaveLength(0);
      expect(JSON.stringify(restored.credentials)).toContain('secret-should-never-persist');
      expect(readFileSync(file, 'utf8')).not.toContain('secret-should-never-persist');
    });
  });

  test('expired cooldown promotes to HalfOpen in the health store', () => {
    withDir((_dir, file) => {
      const store = createHealthStore(file);
      const pool = new AccountPoolManager(store);
      pool.addAccount(account('kilo/acc_half'));
      pool.reportRateLimit('kilo/acc_half', -1);
      expect(pool.getActiveAccounts('kilo')).toHaveLength(1);
      expect(store.get('kilo/acc_half')?.status).toBe('halfOpen');
    });
  });
});
