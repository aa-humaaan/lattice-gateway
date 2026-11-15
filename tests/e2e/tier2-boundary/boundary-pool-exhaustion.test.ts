/**
 * Tier 2 Boundary & Corner Cases: Multi-Account Pool Exhaustion & Edge Conditions
 * 
 * Verifies account pooling and failover behavior under extreme pool states:
 * - All accounts in pool marked cooldown / suspended simultaneously returns 429 with lowest Retry-After
 * - Zero active accounts configured in pool returns clean error without crashing
 * - Simultaneous concurrent requests exceeding available accounts (e.g. 20 requests on 2 accounts)
 * - Account cooldown expiration edge conditions (restoration upon expiration)
 * - Rapid account state toggling (enable/disable under load)
 * - Consecutive rate-limit exponential backoff calculation
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertDialectError,
  assertOpenAISuccess,
  assertRetryAfterHeader,
} from '../../harness/assertions';
import { GatewayError } from '../../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

export interface ExhaustionAccount extends StoredAccount {
  consecutiveRateLimits: number;
  activeConnections: number;
  totalRequests: number;
}

class ExhaustionPoolPlugin implements ProviderPlugin {
  readonly id = 'exhaustion-pool';
  readonly displayName = 'Exhaustion Test Provider';
  readonly defaultBaseUrl = 'https://pool.lattice.local';
  public accounts: ExhaustionAccount[] = [];
  public baseCooldownSeconds = 5;

  constructor(initialAccounts: ExhaustionAccount[] = []) {
    this.accounts = [...initialAccounts];
  }

  getActiveAccounts(): ExhaustionAccount[] {
    const now = Date.now();
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && acc.cooldownUntil <= now) {
        acc.status = 'active';
        acc.cooldownUntil = undefined;
      }
    }
    return this.accounts.filter((a) => a.status === 'active');
  }

  markCooldown(accountId: string, seconds?: number): void {
    const acc = this.accounts.find((a) => a.id === accountId);
    if (!acc) return;
    acc.consecutiveRateLimits++;
    const cooldownDuration = seconds ?? (this.baseCooldownSeconds * Math.pow(2, acc.consecutiveRateLimits - 1));
    acc.status = 'cooldown';
    acc.cooldownUntil = Date.now() + cooldownDuration * 1000;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'exhaustion-pool/model',
        name: 'Exhaustion Model',
        providerId: 'exhaustion-pool',
        ownedBy: 'exhaustion-pool',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const active = this.getActiveAccounts();

    if (active.length === 0) {
      const now = Date.now();
      const remainingTimes = this.accounts.map((a) =>
        a.cooldownUntil ? Math.max(1, Math.ceil((a.cooldownUntil - now) / 1000)) : 10
      );
      const lowestRetry = remainingTimes.length > 0 ? Math.min(...remainingTimes) : 10;

      throw new GatewayError(
        429,
        'rate_limit_error',
        `All accounts exhausted. Lowest retry in ${lowestRetry}s`,
        { retryAfter: lowestRetry }
      );
    }

    // Least connections selection
    let account = active[0];
    for (const a of active) {
      if (a.activeConnections < account.activeConnections) {
        account = a;
      }
    }

    account.activeConnections++;
    account.totalRequests++;

    try {
      // Simulate fast turn processing
      await new Promise((r) => setTimeout(r, 10));

      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [{ type: 'text', text: `Handled by account ${account.id}` }],
        stopReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    } finally {
      account.activeConnections = Math.max(0, account.activeConnections - 1);
    }
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    return (async function* () {
      yield { type: 'stream_start', id: res.id, model: res.model, created: res.created };
      yield { type: 'text_delta', delta: res.content[0]?.type === 'text' ? (res.content[0] as any).text : '' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 2 Boundary: Multi-Account Pool Exhaustion & Edge Conditions', () => {
  let server: any;
  let plugin: ExhaustionPoolPlugin;
  let client: TestClient;

  beforeAll(async () => {
    plugin = new ExhaustionPoolPlugin([
      {
        id: 'acc_1',
        providerId: 'exhaustion-pool',
        authType: 'api_key',
        credentials: { apiKey: 'key_1' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutiveRateLimits: 0,
        activeConnections: 0,
        totalRequests: 0,
      },
      {
        id: 'acc_2',
        providerId: 'exhaustion-pool',
        authType: 'api_key',
        credentials: { apiKey: 'key_2' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutiveRateLimits: 0,
        activeConnections: 0,
        totalRequests: 0,
      },
    ]);

    const app = createServer({ port: 0 }, [plugin]);
    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${server.port}`);
  });

  afterAll(async () => {
    if (server) {
      server.stop(true);
    }
  });

  // 1. All accounts in pool marked cooldown simultaneously returns 429 with lowest remaining Retry-After
  it('returns 429 with lowest remaining Retry-After when all pool accounts are in cooldown', async () => {
    // Put acc_1 on 15s cooldown and acc_2 on 5s cooldown
    plugin.markCooldown('acc_1', 15);
    plugin.markCooldown('acc_2', 5);

    const res = await client.openaiChat({
      model: 'exhaustion-pool/model',
      messages: [{ role: 'user', content: 'Test all cooldown' }],
    });

    expect(res.status).toBe(429);
    assertRetryAfterHeader(res.headers);
    const retryVal = parseInt(res.headers.get('retry-after')!, 10);
    // acc_2 has lowest remaining: ~5s
    expect(retryVal).toBeLessThanOrEqual(6);
    expect(retryVal).toBeGreaterThanOrEqual(1);

    const body = (await res.json()) as any;
    assertDialectError(body, 'openai');
    expect(body.error.type).toBe('rate_limit_error');
  });

  // 2. Zero active accounts configured in pool returns clean error without crashing
  it('returns clean rate limit error when pool has zero accounts without crashing', async () => {
    // Temporarily save accounts and empty the list
    const originalAccounts = [...plugin.accounts];
    plugin.accounts = [];

    const res = await client.openaiChat({
      model: 'exhaustion-pool/model',
      messages: [{ role: 'user', content: 'Test zero accounts' }],
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai');

    // Restore accounts
    plugin.accounts = originalAccounts;
  });

  // 3. Simultaneous concurrent requests exceeding available accounts
  it('handles 20 simultaneous concurrent requests across 2 accounts without dropped requests or race conditions', async () => {
    // Reset account statuses to active
    for (const acc of plugin.accounts) {
      acc.status = 'active';
      acc.cooldownUntil = undefined;
      acc.activeConnections = 0;
    }

    const concurrentCount = 20;
    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      client.openaiChat({
        model: 'exhaustion-pool/model',
        messages: [{ role: 'user', content: `Concurrent request #${i}` }],
      })
    );

    const responses = await Promise.all(promises);

    // Verify all 20 returned 200 OK
    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      assertOpenAISuccess(body);
      expect(body.choices[0].message.content).toContain('Handled by account');
    }

    // Verify both accounts handled traffic
    expect(plugin.accounts[0].totalRequests).toBeGreaterThan(0);
    expect(plugin.accounts[1].totalRequests).toBeGreaterThan(0);
    expect(plugin.accounts[0].totalRequests + plugin.accounts[1].totalRequests).toBe(concurrentCount);
  });

  // 4. Account cooldown expiration edge conditions
  it('restores account immediately once its cooldownUntil timestamp expires', async () => {
    // Set acc_1 to active, acc_2 to 100ms short cooldown
    plugin.accounts[0].status = 'cooldown';
    plugin.accounts[0].cooldownUntil = Date.now() + 10_000; // 10s

    plugin.accounts[1].status = 'cooldown';
    plugin.accounts[1].cooldownUntil = Date.now() + 80; // 80ms

    // Immediate request: both in cooldown -> 429
    const resImmediate = await client.openaiChat({
      model: 'exhaustion-pool/model',
      messages: [{ role: 'user', content: 'Before expiration' }],
    });
    expect(resImmediate.status).toBe(429);

    // Wait 120ms for acc_2 cooldown to expire
    await new Promise((r) => setTimeout(r, 120));

    // Request after expiration: acc_2 is restored to active!
    const resAfter = await client.openaiChat({
      model: 'exhaustion-pool/model',
      messages: [{ role: 'user', content: 'After expiration' }],
    });
    expect(resAfter.status).toBe(200);
    const bodyAfter = (await resAfter.json()) as any;
    assertOpenAISuccess(bodyAfter);
    expect(bodyAfter.choices[0].message.content).toContain('acc_2');
  });

  // 5. Rapid account state toggling (enable/disable under load)
  it('safely handles rapid account state toggling under concurrent traffic without exceptions', async () => {
    let toggleActive = true;
    const toggleInterval = setInterval(() => {
      if (!toggleActive) return;
      plugin.accounts[0].status = plugin.accounts[0].status === 'active' ? 'suspended' : 'active';
      plugin.accounts[1].status = plugin.accounts[1].status === 'active' ? 'suspended' : 'active';
    }, 15);

    try {
      const requests = Array.from({ length: 15 }, (_, i) =>
        client.openaiChat({
          model: 'exhaustion-pool/model',
          messages: [{ role: 'user', content: `Toggle test ${i}` }],
        })
      );

      const results = await Promise.all(requests);
      // Each result should either be 200 (if account active) or 429 (if both suspended momentarily), never 500 crash
      for (const res of results) {
        expect([200, 429]).toContain(res.status);
      }
    } finally {
      toggleActive = false;
      clearInterval(toggleInterval);
      plugin.accounts[0].status = 'active';
      plugin.accounts[1].status = 'active';
    }
  });

  // 6. Consecutive rate-limit exponential backoff calculation
  it('computes exponential backoff cooldown upon consecutive rate limits for the same account', async () => {
    const acc = plugin.accounts[0];
    acc.consecutiveRateLimits = 0;

    // First rate limit: baseCooldown = 5s
    plugin.markCooldown(acc.id);
    expect(acc.consecutiveRateLimits).toBe(1);
    let duration1 = Math.round((acc.cooldownUntil! - Date.now()) / 1000);
    expect(duration1).toBe(5);

    // Second consecutive rate limit: 5 * 2^1 = 10s
    plugin.markCooldown(acc.id);
    expect(acc.consecutiveRateLimits).toBe(2);
    let duration2 = Math.round((acc.cooldownUntil! - Date.now()) / 1000);
    expect(duration2).toBe(10);

    // Third consecutive rate limit: 5 * 2^2 = 20s
    plugin.markCooldown(acc.id);
    expect(acc.consecutiveRateLimits).toBe(3);
    let duration3 = Math.round((acc.cooldownUntil! - Date.now()) / 1000);
    expect(duration3).toBe(20);
  });
});
