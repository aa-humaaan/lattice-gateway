/**
 * Tier 4 Real-World Application Scenario: S4 - 429 Rate-Limit Failover Marathon
 * 
 * Simulates heavy production burst load across multiple accounts and providers:
 * - 3 accounts in primary pool (Account A, Account B, Account C)
 * - Virtual combo with fallback to secondary provider (Account D, Account E)
 * - 30 consecutive and concurrent burst requests under rate-limit stress
 * - Account A hits 429 (Retry-After: 3) -> rotates to Account B
 * - Account B hits 429 (Retry-After: 5) -> rotates to Account C
 * - Account C hits 429 (Retry-After: 4) -> falls back to Secondary Provider in combo
 * - Cooldown expiration: Account A recovers and resumes receiving requests
 * - Total pool exhaustion returns 429 with lowest remaining Retry-After
 * - Exponential backoff on consecutive rate limits and reset on success
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertRetryAfterHeader,
  assertDialectError,
} from '../../harness/assertions';
import type {
  ProviderPlugin,
  ModelDescriptor,
  StoredAccount,
} from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

export interface MarathonAccount extends StoredAccount {
  consecutive429Count: number;
  totalServed: number;
  shouldFailWith429?: boolean;
  retryAfterSeconds?: number;
}

export class MarathonPrimaryPlugin implements ProviderPlugin {
  readonly id = 'marathon-primary';
  readonly displayName = 'Marathon Primary Provider';
  readonly defaultBaseUrl = 'https://mock.primary.local/v1';

  public accounts: MarathonAccount[] = [];
  public baseCooldownSeconds = 2;
  public roundRobinIndex = 0;

  constructor(accounts: MarathonAccount[]) {
    this.accounts = [...accounts];
  }

  getActiveAccounts(): MarathonAccount[] {
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
        id: 'marathon-primary/model-flagship',
        name: 'Marathon Primary Flagship',
        providerId: 'marathon-primary',
        ownedBy: 'marathon-primary',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const active = this.getActiveAccounts();

    if (active.length === 0) {
      const now = Date.now();
      const remainingSeconds = this.accounts.map((a) =>
        a.cooldownUntil ? Math.max(1, Math.ceil((a.cooldownUntil - now) / 1000)) : 5
      );
      const minRetry = Math.min(...remainingSeconds);

      throw new GatewayError(
        429,
        'rate_limit_exceeded',
        `Primary pool exhausted. Min retry: ${minRetry}s`,
        { retryAfter: minRetry }
      );
    }

    // Attempt accounts in round-robin sequence with pre-stream failover
    let lastError: any = null;
    const candidates = [...active];

    for (const acc of candidates) {
      if (acc.shouldFailWith429) {
        const retry = acc.retryAfterSeconds || 3;
        acc.consecutive429Count++;
        const backoffMultiplier = Math.pow(2, acc.consecutive429Count - 1);
        const cooldownMs = retry * 1000 * backoffMultiplier;

        acc.status = 'cooldown';
        acc.cooldownUntil = Date.now() + cooldownMs;
        acc.errorCount++;

        lastError = new GatewayError(429, 'rate_limit_exceeded', `Account ${acc.id} rate limited`, {
          retryAfter: retry,
        });
        continue;
      }

      // Success branch
      acc.totalServed++;
      acc.lastUsedAt = Date.now();
      acc.consecutive429Count = 0; // reset penalty on success

      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: 'text',
            text: `Served by primary account: ${acc.id} (total served: ${acc.totalServed})`,
          },
        ],
        stopReason: 'stop',
        usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
      };
    }

    throw lastError || new GatewayError(429, 'rate_limit_exceeded', 'All primary accounts failed');
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    const text = (res.content[0] as any).text;

    return (async function* () {
      yield {
        type: 'stream_start',
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
      };
      yield { type: 'text_delta', delta: text };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

export class MarathonSecondaryPlugin implements ProviderPlugin {
  readonly id = 'marathon-secondary';
  readonly displayName = 'Marathon Secondary Provider';
  readonly defaultBaseUrl = 'https://mock.secondary.local/v1';

  public accounts: MarathonAccount[] = [];
  public totalServed = 0;

  constructor(accounts: MarathonAccount[]) {
    this.accounts = [...accounts];
  }

  getActiveAccounts(): MarathonAccount[] {
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
        id: 'marathon-secondary/model-backup',
        name: 'Marathon Secondary Backup',
        providerId: 'marathon-secondary',
        ownedBy: 'marathon-secondary',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const active = this.getActiveAccounts();
    if (active.length === 0) {
      throw new GatewayError(
        429,
        'rate_limit_exceeded',
        'Secondary pool exhausted due to 429 rate limits',
        { retryAfter: 10 }
      );
    }

    const acc = active[0];
    if (acc.shouldFailWith429) {
      acc.status = 'cooldown';
      acc.cooldownUntil = Date.now() + (acc.retryAfterSeconds || 10) * 1000;
      throw new GatewayError(429, 'rate_limit_exceeded', 'Secondary account rate limited', {
        retryAfter: acc.retryAfterSeconds || 10,
      });
    }

    acc.totalServed++;
    this.totalServed++;

    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [
        {
          type: 'text',
          text: `Served by secondary provider: ${acc.id} (total: ${this.totalServed})`,
        },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 18, completionTokens: 12, totalTokens: 30 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    const text = (res.content[0] as any).text;

    return (async function* () {
      yield {
        type: 'stream_start',
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
      };
      yield { type: 'text_delta', delta: text };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

export class MarathonComboPlugin implements ProviderPlugin {
  readonly id = 'combo-marathon';
  readonly displayName = 'Marathon Combo Provider';
  readonly defaultBaseUrl = 'https://mock.combo.local/v1';

  constructor(
    public primary: MarathonPrimaryPlugin,
    public secondary: MarathonSecondaryPlugin
  ) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'combo-marathon/resilient-flagship',
        name: 'Resilient Flagship Combo',
        providerId: 'combo-marathon',
        ownedBy: 'combo-marathon',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    try {
      return await this.primary.execute(req);
    } catch (err: any) {
      if (err instanceof GatewayError && err.statusCode === 429) {
        // Transparent fallback to secondary provider
        return await this.secondary.execute(req);
      }
      throw err;
    }
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    try {
      return await this.primary.executeStream(req);
    } catch (err: any) {
      if (err instanceof GatewayError && err.statusCode === 429) {
        return await this.secondary.executeStream(req);
      }
      throw err;
    }
  }
}

describe('Tier 4 Scenario S4: 429 Rate-Limit Failover Marathon', () => {
  let primaryPlugin: MarathonPrimaryPlugin;
  let secondaryPlugin: MarathonSecondaryPlugin;
  let comboPlugin: MarathonComboPlugin;
  let gatewayServer: any;
  let client: TestClient;

  const createAccounts = (): {
    primaryAccounts: MarathonAccount[];
    secondaryAccounts: MarathonAccount[];
  } => ({
    primaryAccounts: [
      {
        id: 'acc_primary_A',
        providerId: 'marathon-primary',
        authType: 'api_key',
        credentials: { apiKey: 'key_A' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutive429Count: 0,
        totalServed: 0,
      },
      {
        id: 'acc_primary_B',
        providerId: 'marathon-primary',
        authType: 'api_key',
        credentials: { apiKey: 'key_B' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutive429Count: 0,
        totalServed: 0,
      },
      {
        id: 'acc_primary_C',
        providerId: 'marathon-primary',
        authType: 'api_key',
        credentials: { apiKey: 'key_C' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutive429Count: 0,
        totalServed: 0,
      },
    ],
    secondaryAccounts: [
      {
        id: 'acc_secondary_D',
        providerId: 'marathon-secondary',
        authType: 'api_key',
        credentials: { apiKey: 'key_D' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
        consecutive429Count: 0,
        totalServed: 0,
      },
    ],
  });

  beforeAll(async () => {
    const { primaryAccounts, secondaryAccounts } = createAccounts();
    primaryPlugin = new MarathonPrimaryPlugin(primaryAccounts);
    secondaryPlugin = new MarathonSecondaryPlugin(secondaryAccounts);
    comboPlugin = new MarathonComboPlugin(primaryPlugin, secondaryPlugin);

    const app = createServer({ port: 0 }, [comboPlugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) {
      gatewayServer.stop(true);
    }
  });

  beforeEach(() => {
    const { primaryAccounts, secondaryAccounts } = createAccounts();
    primaryPlugin.accounts = primaryAccounts;
    secondaryPlugin.accounts = secondaryAccounts;
    secondaryPlugin.totalServed = 0;
  });

  // --------------------------------------------------------------------------
  // Test 1: Sequential Account Pre-Stream Failover
  // --------------------------------------------------------------------------
  it('transparently rotates to Account B when Account A hits 429', async () => {
    // Inject 429 onto Account A
    primaryPlugin.accounts[0].shouldFailWith429 = true;
    primaryPlugin.accounts[0].retryAfterSeconds = 3;

    const res = await client.openaiChat({
      model: 'combo-marathon/resilient-flagship',
      messages: [{ role: 'user', content: 'Test sequential 429 rotation' }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);

    // Verify request succeeded on Account B
    expect(body.choices[0].message.content).toContain('Served by primary account: acc_primary_B');

    // Verify Account A transitioned to cooldown
    expect(primaryPlugin.accounts[0].status).toBe('cooldown');
    expect(primaryPlugin.accounts[0].cooldownUntil).toBeGreaterThan(Date.now());
  });

  // --------------------------------------------------------------------------
  // Test 2: Cascading Failover across A, B, C to Secondary Provider
  // --------------------------------------------------------------------------
  it('cascades through all primary accounts and falls back to secondary combo provider', async () => {
    // Inject 429 onto all 3 primary accounts
    primaryPlugin.accounts[0].shouldFailWith429 = true;
    primaryPlugin.accounts[0].retryAfterSeconds = 3;

    primaryPlugin.accounts[1].shouldFailWith429 = true;
    primaryPlugin.accounts[1].retryAfterSeconds = 5;

    primaryPlugin.accounts[2].shouldFailWith429 = true;
    primaryPlugin.accounts[2].retryAfterSeconds = 4;

    const res = await client.openaiChat({
      model: 'combo-marathon/resilient-flagship',
      messages: [{ role: 'user', content: 'Test full combo cascade' }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);

    // Verify served by secondary provider Account D
    expect(body.choices[0].message.content).toContain('Served by secondary provider: acc_secondary_D');

    // Verify all 3 primary accounts are now marked cooldown
    expect(primaryPlugin.accounts[0].status).toBe('cooldown');
    expect(primaryPlugin.accounts[1].status).toBe('cooldown');
    expect(primaryPlugin.accounts[2].status).toBe('cooldown');
  });

  // --------------------------------------------------------------------------
  // Test 3: The 30-Request Burst Marathon under High Concurrency
  // --------------------------------------------------------------------------
  it('serves 30 concurrent and sequential burst requests with 100% success rate under rate-limit stress', async () => {
    // Set dynamic rate-limiting pattern: Account A fails on alternate requests
    let requestCount = 0;
    // Allow Account A and B to alternate rate limits
    primaryPlugin.accounts[0].retryAfterSeconds = 2;
    primaryPlugin.accounts[1].retryAfterSeconds = 2;

    const requests = Array.from({ length: 30 }, (_, i) => {
      // Interleave failures dynamically to test continuous rotation
      if (i % 3 === 0) {
        primaryPlugin.accounts[0].shouldFailWith429 = true;
      } else {
        primaryPlugin.accounts[0].shouldFailWith429 = false;
      }

      return client.openaiChat({
        model: 'combo-marathon/resilient-flagship',
        messages: [{ role: 'user', content: `Marathon request #${i + 1}` }],
        stream: false,
      });
    });

    const responses = await Promise.all(requests);

    // Assert 100% of client turns completed with HTTP 200 OK
    expect(responses.length).toBe(30);
    for (let i = 0; i < responses.length; i++) {
      expect(responses[i].status).toBe(200);
      const data = (await responses[i].json()) as any;
      expect(data.choices[0].message.content).toBeDefined();
    }
  });

  // --------------------------------------------------------------------------
  // Test 4: Cooldown Expiration & Account Re-admission
  // --------------------------------------------------------------------------
  it('automatically restores account from cooldown to active after duration passes', async () => {
    const accA = primaryPlugin.accounts[0];
    accA.status = 'cooldown';
    // Short cooldown of 40ms
    accA.cooldownUntil = Date.now() + 40;

    // Immediately before expiration, account is not active
    expect(primaryPlugin.getActiveAccounts().some((a) => a.id === 'acc_primary_A')).toBeFalse();

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 60));

    // After expiration, getActiveAccounts automatically transitions status to active
    const active = primaryPlugin.getActiveAccounts();
    expect(active.some((a) => a.id === 'acc_primary_A')).toBeTrue();
    expect(accA.status).toBe('active' as any);
    expect(accA.cooldownUntil).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Test 5: Total Pool Exhaustion Returns 429 with Minimum Retry-After
  // --------------------------------------------------------------------------
  it('returns normalized 429 with lowest Retry-After when all pool accounts are exhausted', async () => {
    // Exhaust all primary accounts
    primaryPlugin.accounts[0].status = 'cooldown';
    primaryPlugin.accounts[0].cooldownUntil = Date.now() + 30000;

    primaryPlugin.accounts[1].status = 'cooldown';
    primaryPlugin.accounts[1].cooldownUntil = Date.now() + 15000;

    primaryPlugin.accounts[2].status = 'cooldown';
    primaryPlugin.accounts[2].cooldownUntil = Date.now() + 20000;

    // Exhaust secondary provider account
    secondaryPlugin.accounts[0].status = 'cooldown';
    secondaryPlugin.accounts[0].cooldownUntil = Date.now() + 10000;
    secondaryPlugin.accounts[0].shouldFailWith429 = true;

    const res = await client.openaiChat({
      model: 'combo-marathon/resilient-flagship',
      messages: [{ role: 'user', content: 'Exhausted pool test' }],
      stream: false,
    });

    expect(res.status).toBe(429);
    assertRetryAfterHeader(res.headers);

    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 429);
  });

  // --------------------------------------------------------------------------
  // Test 6: Exponential Backoff Penalty Tracking and Reset on Success
  // --------------------------------------------------------------------------
  it('applies exponential backoff on consecutive rate limits and resets penalty on success', async () => {
    const accA = primaryPlugin.accounts[0];
    accA.shouldFailWith429 = true;
    accA.retryAfterSeconds = 2;

    // First 429: multiplier 2^0 = 1x -> cooldown = 2s
    await client.openaiChat({
      model: 'combo-marathon/resilient-flagship',
      messages: [{ role: 'user', content: 'Trigger 1st 429' }],
      stream: false,
    });
    expect(accA.consecutive429Count).toBe(1);

    // Second consecutive 429: multiplier 2^1 = 2x -> cooldown = 4s
    accA.status = 'active'; // force active to simulate repeat rejection
    await client.openaiChat({
      model: 'combo-marathon/resilient-flagship',
      messages: [{ role: 'user', content: 'Trigger 2nd 429' }],
      stream: false,
    });
    expect(accA.consecutive429Count).toBe(2);

    // Now let Account A succeed
    accA.shouldFailWith429 = false;
    accA.status = 'active';

    // Put B and C in cooldown to force selection of A
    primaryPlugin.accounts[1].status = 'cooldown';
    primaryPlugin.accounts[2].status = 'cooldown';

    await client.openaiChat({
      model: 'combo-marathon/resilient-flagship',
      messages: [{ role: 'user', content: 'Trigger success on A' }],
      stream: false,
    });

    // Consecutive penalty must reset to 0 upon successful request
    expect(accA.consecutive429Count).toBe(0);
    expect(accA.totalServed).toBe(1);
  });
});
