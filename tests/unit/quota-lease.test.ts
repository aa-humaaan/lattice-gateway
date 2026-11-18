import { describe, expect, test } from 'bun:test';
import { AccountPoolManager } from '../../src/pool/account-pool';
import type { StoredAccount } from '../../src/core/types/plugin';

function account(id: string): StoredAccount {
  return {
    id, providerId: 'kilo', authType: 'api_key', status: 'active',
    credentials: { apiKey: `key_${id}` }, createdAt: 1, updatedAt: 1, errorCount: 0,
  };
}

describe('in-flight quota leases', () => {
  test('two concurrent requests do not pick the same sole account', () => {
    const pool = new AccountPoolManager();
    pool.addAccount(account('kilo/only'));
    const first = pool.acquireLease('kilo', ['kilo/only'], 60_000);
    expect(first?.accountId).toBe('kilo/only');
    expect(pool.acquireLease('kilo', ['kilo/only'], 60_000)).toBeUndefined();
    pool.releaseLease(first!.leaseId);
    expect(pool.acquireLease('kilo', ['kilo/only'], 60_000)?.accountId).toBe('kilo/only');
  });

  test('leases expire automatically', () => {
    const pool = new AccountPoolManager();
    pool.addAccount(account('kilo/only'));
    const lease = pool.acquireLease('kilo', ['kilo/only'], -1);
    expect(pool.acquireLease('kilo', ['kilo/only'], 60_000)?.accountId).toBe('kilo/only');
    expect(lease?.accountId).toBe('kilo/only');
  });

  test('usage is charged to the selected account id', () => {
    const pool = new AccountPoolManager();
    pool.addAccount(account('kilo/a'));
    pool.recordUsageForAccount('kilo/a', 10, 5);
    expect(pool.getAccount('kilo/a')?.tokensUsed).toBe(15);
  });
});
