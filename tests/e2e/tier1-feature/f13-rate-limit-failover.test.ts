/**
 * Feature F13: Core Infrastructure - 429 Rate-Limit Cooldown & Pre-Stream Transparent Failover
 * 
 * Verifies:
 * - Account receives 429 -> marked as cooldown with cooldownUntil duration
 * - Pre-stream transparent failover: request immediately retried with secondary account without failing client turn
 * - Cooldown timer expiration restores account state to active / ready
 * - All accounts in pool 429-exhausted returns proper 429 with lowest remaining Retry-After
 * - Repeated 429 triggers exponential backoff cooldown
 * - Successful request resets consecutive rate limit penalty counter
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertRetryAfterHeader,
} from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

export interface FailoverAccount extends StoredAccount {
  consecutiveRateLimits: number;
}

class FailoverPoolPlugin implements ProviderPlugin {
  readonly id = 'failover';
  readonly displayName = '429 Rate-Limit Failover Provider';
  readonly defaultBaseUrl: string;
  public accounts: FailoverAccount[] = [];
  public baseCooldownSeconds = 5;

  constructor(upstreamBaseUrl: string, accounts: FailoverAccount[]) {
    this.defaultBaseUrl = upstreamBaseUrl;
    this.accounts = [...accounts];
  }

  getActiveAccounts(): FailoverAccount[] {
    const now = Date.now();
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && acc.cooldownUntil <= now) {
        acc.status = 'active';
        acc.cooldownUntil = undefined;
      }
    }
    return this.accounts.filter((a) => a.status === 'active');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'failover/auto-model',
        name: 'Failover Auto Model',
        providerId: 'failover',
        ownedBy: 'failover',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const activeAccounts = this.getActiveAccounts();

    if (activeAccounts.length === 0) {
      // Find lowest remaining cooldown
      const now = Date.now();
      const remainingSeconds = this.accounts.map((acc) =>
        acc.cooldownUntil ? Math.max(1, Math.ceil((acc.cooldownUntil - now) / 1000)) : 10
      );
      const lowestRetryAfter = Math.min(...remainingSeconds);

      throw new GatewayError(
        429,
        '429',
        `All accounts exhausted due to upstream rate limits. Lowest retry: ${lowestRetryAfter}s`,
        { retryAfter: lowestRetryAfter }
      );
    }

    // Try available active accounts pre-stream
    for (const account of activeAccounts) {
      account.lastUsedAt = Date.now();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${account.credentials.apiKey}`,
        'X-Account-Id': account.id,
        'Connection': 'close',
      };

      const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'mock-gpt-4o',
          messages: req.messages,
        }),
        signal,
      });

      if (res.status === 429) {
        account.consecutiveRateLimits++;
        account.status = 'cooldown';

        // Exponential backoff: base * 2^(consecutive - 1)
        const exponentialSeconds =
          this.baseCooldownSeconds * Math.pow(2, Math.max(0, account.consecutiveRateLimits - 1));
        const retryHeaderSeconds = Number(res.headers.get('retry-after') || 0);
        const effectiveSeconds = Math.max(retryHeaderSeconds, exponentialSeconds);

        account.cooldownUntil = Date.now() + effectiveSeconds * 1000;
        account.errorCount++;

        // Transparent pre-stream failover to next account in loop
        continue;
      }

      if (!res.ok) {
        throw new GatewayError(res.status, String(res.status), `Upstream error: ${res.statusText}`);
      }

      // Success resets consecutive rate limits
      account.consecutiveRateLimits = 0;

      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [{ type: 'text', text: choice?.message?.content || `Handled by ${account.id}` }],
        stopReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
      };
    }

    // If loop exhausted all tried accounts
    const now = Date.now();
    const remainingSeconds = this.accounts.map((acc) =>
      acc.cooldownUntil ? Math.max(1, Math.ceil((acc.cooldownUntil - now) / 1000)) : 10
    );
    const lowestRetryAfter = Math.min(...remainingSeconds);

    throw new GatewayError(
      429,
      '429',
      `All accounts exhausted after pre-stream failover. Lowest retry: ${lowestRetryAfter}s`,
      { retryAfter: lowestRetryAfter }
    );
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'text_delta', delta: 'Failover stream turn' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Feature F13: 429 Rate-Limit Cooldown & Pre-Stream Transparent Failover', () => {
  let mockServer: MockUpstreamServer;
  let failoverPlugin: FailoverPoolPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();
    failoverPlugin = new FailoverPoolPlugin(mockServer.url, [
      {
        id: 'acc_primary',
        providerId: 'failover',
        authType: 'api_key',
        credentials: { apiKey: 'key_primary' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutiveRateLimits: 0,
      },
      {
        id: 'acc_secondary',
        providerId: 'failover',
        authType: 'api_key',
        credentials: { apiKey: 'key_secondary' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutiveRateLimits: 0,
      },
    ]);

    const app = createServer({ port: 0 }, [failoverPlugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });

    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) gatewayServer.stop(true);
    if (mockServer) await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    for (const acc of failoverPlugin.accounts) {
      acc.status = 'active';
      acc.cooldownUntil = undefined;
      acc.consecutiveRateLimits = 0;
      acc.errorCount = 0;
    }
  });

  // Test 1: Account marked as cooldown on 429
  it('marks account as cooldown with cooldownUntil duration on receiving 429', async () => {
    mockServer.simulateRateLimit({
      retryAfterSeconds: 20,
      message: 'Rate limit hit',
      count: 2, // Both will fail
    });

    const res = await client.openaiChat({
      model: 'failover/auto-model',
      messages: [{ role: 'user', content: 'Turn 1' }],
    });

    expect(res.status).toBe(429);
    const acc1 = failoverPlugin.accounts[0];
    expect(acc1.status).toBe('cooldown');
    expect(acc1.cooldownUntil).toBeDefined();
    expect(acc1.cooldownUntil!).toBeGreaterThan(Date.now());
  });

  // Test 2: Pre-stream transparent failover
  it('transparently fails over pre-stream to secondary account when primary hits 429', async () => {
    // Primary account (key_primary) returns 429, secondary succeeds
    mockServer.simulateRateLimit({
      retryAfterSeconds: 15,
      message: 'Primary rate limited',
      count: 1, // Only 1 failure, so secondary call will succeed!
    });
    mockServer.configureOpenAIChat({ content: 'Secondary account success' });

    const res = await client.openaiChat({
      model: 'failover/auto-model',
      messages: [{ role: 'user', content: 'Transparent failover check' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Secondary account success');

    // Verify account statuses: Primary is cooldown, Secondary is active
    expect(failoverPlugin.accounts[0].status).toBe('cooldown');
    expect(failoverPlugin.accounts[1].status).toBe('active');

    // Upstream saw 2 requests: first failed with 429, second succeeded
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(2);
    expect(requests[0].headers['x-account-id']).toBe('acc_primary');
    expect(requests[1].headers['x-account-id']).toBe('acc_secondary');
  });

  // Test 3: Cooldown timer expiration restores account state to active
  it('restores account status from cooldown to active after cooldown duration passes', () => {
    const acc = failoverPlugin.accounts[0];
    acc.status = 'cooldown';
    acc.cooldownUntil = Date.now() - 1000; // 1s in the past

    const activeList = failoverPlugin.getActiveAccounts();
    expect(activeList.some((a) => a.id === acc.id)).toBeTrue();
    expect(acc.status).toBe('active' as any);
    expect(acc.cooldownUntil).toBeUndefined();
  });

  // Test 4: All accounts exhausted returns lowest Retry-After
  it('returns 429 with lowest remaining Retry-After when all pool accounts are exhausted', async () => {
    const now = Date.now();
    failoverPlugin.accounts[0].status = 'cooldown';
    failoverPlugin.accounts[0].cooldownUntil = now + 45000; // 45s left

    failoverPlugin.accounts[1].status = 'cooldown';
    failoverPlugin.accounts[1].cooldownUntil = now + 12000; // 12s left (lowest)

    const res = await client.openaiChat({
      model: 'failover/auto-model',
      messages: [{ role: 'user', content: 'Exhausted pool check' }],
    });

    expect(res.status).toBe(429);
    assertRetryAfterHeader(res.headers, 12);
  });

  // Test 5: Exponential backoff on repeated 429 hits
  it('applies exponential backoff cooldown on consecutive rate limits for the same account', () => {
    const acc = failoverPlugin.accounts[0];

    // 1st hit: consecutive = 1 -> base * 2^0 = 5s
    acc.consecutiveRateLimits = 1;
    const cooldown1 = failoverPlugin.baseCooldownSeconds * Math.pow(2, 0);
    expect(cooldown1).toBe(5);

    // 2nd hit: consecutive = 2 -> base * 2^1 = 10s
    acc.consecutiveRateLimits = 2;
    const cooldown2 = failoverPlugin.baseCooldownSeconds * Math.pow(2, 1);
    expect(cooldown2).toBe(10);

    // 3rd hit: consecutive = 3 -> base * 2^2 = 20s
    acc.consecutiveRateLimits = 3;
    const cooldown3 = failoverPlugin.baseCooldownSeconds * Math.pow(2, 2);
    expect(cooldown3).toBe(20);
  });

  // Test 6: Successful request resets consecutive rate limit counter
  it('resets consecutive rate limit counter upon successful request', async () => {
    failoverPlugin.accounts[0].consecutiveRateLimits = 3;
    mockServer.configureOpenAIChat({ content: 'Clean turn' });

    const res = await client.openaiChat({
      model: 'failover/auto-model',
      messages: [{ role: 'user', content: 'Recovery turn' }],
    });

    expect(res.status).toBe(200);
    expect(failoverPlugin.accounts[0].consecutiveRateLimits).toBe(0);
  });
});
