import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
import { AccountPoolManager, globalAccountPool } from '../../src/pool/account-pool';
import type { ProviderPlugin, StoredAccount } from '../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../src/core/types/canonical';

function activeAccount(id: string, providerId = 'pool-test'): StoredAccount {
  return {
    id,
    providerId,
    authType: 'api_key',
    status: 'active',
    credentials: { apiKey: `key-${id}` },
    createdAt: 1,
    updatedAt: 1,
    errorCount: 0,
  };
}

function newPool(count = 5): AccountPoolManager {
  const pool = new AccountPoolManager();
  for (let i = 0; i < count; i++) pool.addAccount(activeAccount(`acc-${i}`));
  return pool;
}

afterEach(() => {
  for (const provider of ['pool-test', 'usage-test']) {
    for (const account of globalAccountPool.listAccounts(provider)) {
      globalAccountPool.deleteAccount(account.id);
    }
  }
});

describe('P1-2 distribution characterization', () => {
  test('200 parallel requests: old first-active rule vs shared allocator', async () => {
    const pool = newPool();
    const oldCounts: Record<string, number> = {};
    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const account = pool.getAccountsForExecution('pool-test')[0];
        await Promise.resolve();
        oldCounts[account.id] = (oldCounts[account.id] || 0) + 1;
      })
    );
    console.log('P1-2 old first-active distribution:', oldCounts);
    expect(oldCounts['acc-0']).toBe(200);

    const newCounts: Record<string, number> = {};
    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const reservation = pool.acquireAccount(pool.listAccounts('pool-test'))!;
        await new Promise((resolve) => setTimeout(resolve, 1));
        newCounts[reservation.account.id] = (newCounts[reservation.account.id] || 0) + 1;
        reservation.release();
      })
    );
    console.log('P1-2 shared allocator distribution:', newCounts);
    expect(Object.keys(newCounts).length).toBe(5);
  });
});

describe('P1-2 reservations', () => {
  test('200 parallel reservations balance across the pool and leave no in-flight count', async () => {
    const pool = newPool();
    expect(typeof (pool as any).acquireAccount, 'acquireAccount must exist on the pool').toBe('function');

    const counts: Record<string, number> = {};
    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const reservation = (pool as any).acquireAccount(pool.listAccounts('pool-test'));
        expect(reservation).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, 1));
        counts[reservation.account.id] = (counts[reservation.account.id] || 0) + 1;
        reservation.release();
      })
    );

    console.log('P1-2 reserved distribution:', counts);
    expect(Object.keys(counts).length).toBe(5);
    const values = Object.values(counts);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2);
    for (const account of pool.listAccounts('pool-test')) {
      expect((pool as any).getInFlightCount(account.id)).toBe(0);
    }
  });

  test('client abort releases the reservation', async () => {
    const pool = newPool();
    expect(typeof (pool as any).acquireAccount).toBe('function');
    const controller = new AbortController();
    const reservation = (pool as any).acquireAccount(pool.listAccounts('pool-test'), { signal: controller.signal });
    expect(reservation).toBeTruthy();
    expect((pool as any).getInFlightCount(reservation.account.id)).toBe(1);

    controller.abort();
    expect((pool as any).getInFlightCount(reservation.account.id)).toBe(0);
    // Idempotent: a caller's finally must not double-release.
    reservation.release();
    expect((pool as any).getInFlightCount(reservation.account.id)).toBe(0);
  });

  test('usage is recorded against the executing account, not lastUsedAt', () => {
    const pool = newPool();
    const chosen = pool.listAccounts('pool-test')[2];
    chosen.lastUsedAt = 1;
    const stale = pool.listAccounts('pool-test')[0];
    stale.lastUsedAt = Date.now();

    pool.recordTokenUsage(chosen.id, 10, 5);

    expect(chosen.requestsUsed).toBe(1);
    expect(chosen.tokensUsed).toBe(15);
    expect(stale.requestsUsed).toBeUndefined();
  });

  test('gateway usage follows the account id set by the executing plugin', async () => {
    const stale = activeAccount('usage-stale', 'usage-test');
    stale.lastUsedAt = Date.now();
    const executed = activeAccount('usage-executed', 'usage-test');
    executed.lastUsedAt = 1;
    globalAccountPool.addAccount(stale);
    globalAccountPool.addAccount(executed);

    const plugin: ProviderPlugin = {
      id: 'usage-test',
      displayName: 'usage test',
      defaultBaseUrl: 'http://stub',
      cachedModels: [{ id: 'usage-test/model', name: 'usage test' }],
      listModels: async () => [{ id: 'usage-test/model', name: 'usage test' }],
      execute: async (req: CanonicalRequest): Promise<CanonicalResponse> => {
        req.accountId = executed.id;
        return {
          id: req.id,
          model: req.model,
          created: 1,
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        };
      },
      executeStream: async (): Promise<AsyncIterable<CanonicalStreamEvent>> =>
        (async function* () {
          yield { type: 'stream_end', stopReason: 'stop' };
        })(),
    };

    const app = createServer({}, [plugin]);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'usage-test/model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(globalAccountPool.getAccount(executed.id)?.requestsUsed).toBe(1);
    expect(globalAccountPool.getAccount(executed.id)?.tokensUsed).toBe(10);
    expect(globalAccountPool.getAccount(stale.id)?.requestsUsed).toBeUndefined();

    globalAccountPool.deleteAccount(stale.id);
    globalAccountPool.deleteAccount(executed.id);
  });
});
