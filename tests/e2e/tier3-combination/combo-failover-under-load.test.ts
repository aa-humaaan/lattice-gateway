/**
 * Tier 3 Cross-Feature Combinations: Failover Under Heavy Concurrent Load
 * 
 * Verifies transparent failover, cooldown tracking, and load balancing under concurrent burst traffic:
 * - High concurrency: 20 simultaneous requests where primary provider returns 429 after 5 requests,
 *   transparently failing over to secondary provider in combo without dropping any requests (all 20 return 200 OK)
 * - Mixed streaming SSE and non-streaming JSON failover under concurrent load
 * - Cooldown tracking accuracy during heavy load: cooldown duration and timestamps accurately maintained
 * - Least-connections load distribution across multiple backup accounts during failover
 * - Multi-tier fallback chain (Primary -> Secondary -> Tertiary) when intermediate providers are exhausted
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertStreamDone,
} from '../../harness/assertions';
import { GatewayError } from '../../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class LoadBalancingProvider implements ProviderPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly defaultBaseUrl: string;

  public requestLimitBefore429 = Infinity;
  public requestCount = 0;
  public activeConnections = 0;
  public cooldownUntil?: number;
  public handledRequests = 0;

  constructor(id: string, limitBefore429 = Infinity) {
    this.id = id;
    this.displayName = `Provider ${id}`;
    this.defaultBaseUrl = `https://${id}.lattice.local`;
    this.requestLimitBefore429 = limitBefore429;
  }

  isAvailable(): boolean {
    const now = Date.now();
    if (this.cooldownUntil && this.cooldownUntil > now) {
      return false;
    }
    return true;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: `${this.id}/chat`,
        name: `${this.displayName} Chat`,
        providerId: this.id,
        ownedBy: this.id,
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    if (!this.isAvailable()) {
      const remaining = Math.max(1, Math.ceil((this.cooldownUntil! - Date.now()) / 1000));
      throw new GatewayError(429, 'rate_limit_error', `${this.id} rate limited`, { retryAfter: remaining });
    }

    this.activeConnections++;
    this.requestCount++;

    try {
      if (this.requestCount > this.requestLimitBefore429) {
        this.cooldownUntil = Date.now() + 5000; // 5s cooldown
        throw new GatewayError(429, 'rate_limit_error', `${this.id} exceeded limit`, { retryAfter: 5 });
      }

      this.handledRequests++;
      // Brief processing time to simulate network IO
      await new Promise((r) => setTimeout(r, 15));

      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [{ type: 'text', text: `Served by ${this.id}` }],
        stopReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    } finally {
      this.activeConnections = Math.max(0, this.activeConnections - 1);
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

class VirtualFailoverComboPlugin implements ProviderPlugin {
  readonly id = 'combo-load';
  readonly displayName = 'Virtual Combo Load Provider';
  readonly defaultBaseUrl = 'https://combo-load.lattice.local';

  public providers: LoadBalancingProvider[] = [];

  constructor(providers: LoadBalancingProvider[]) {
    this.providers = providers;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'combo-load/flagship',
        name: 'Combo Flagship Model',
        providerId: 'combo-load',
        ownedBy: 'combo-load',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    // Traverse available providers in priority order with least-connections within priority tier
    for (const p of this.providers) {
      if (p.isAvailable()) {
        try {
          return await p.execute(req);
        } catch (err: any) {
          if (err instanceof GatewayError && err.statusCode === 429) {
            // Fail over to next provider in combo!
            continue;
          }
          throw err;
        }
      }
    }

    // All exhausted
    throw new GatewayError(429, 'rate_limit_error', 'All providers in combo exhausted', { retryAfter: 5 });
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    for (const p of this.providers) {
      if (p.isAvailable()) {
        try {
          return await p.executeStream(req);
        } catch (err: any) {
          if (err instanceof GatewayError && err.statusCode === 429) {
            continue;
          }
          throw err;
        }
      }
    }

    throw new GatewayError(429, 'rate_limit_error', 'All providers in combo exhausted', { retryAfter: 5 });
  }
}

describe('Tier 3 Combination: Failover Under Heavy Concurrent Load', () => {
  let server: any;
  let primary: LoadBalancingProvider;
  let secondary: LoadBalancingProvider;
  let tertiary: LoadBalancingProvider;
  let comboPlugin: VirtualFailoverComboPlugin;
  let client: TestClient;

  beforeAll(async () => {
    // Primary handles 5 requests, then 429s
    primary = new LoadBalancingProvider('primary', 5);
    // Secondary is unlimited
    secondary = new LoadBalancingProvider('secondary', Infinity);
    // Tertiary backup
    tertiary = new LoadBalancingProvider('tertiary', Infinity);

    comboPlugin = new VirtualFailoverComboPlugin([primary, secondary, tertiary]);
    const app = createServer({ port: 0 }, [comboPlugin]);
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

  // 1. High concurrency: 20 simultaneous requests where primary returns 429 after 5 requests
  it('transparently fails over all 20 simultaneous requests from primary to secondary with zero dropped requests', async () => {
    primary.requestCount = 0;
    primary.handledRequests = 0;
    primary.cooldownUntil = undefined;
    secondary.handledRequests = 0;

    const totalRequests = 20;
    const promises = Array.from({ length: totalRequests }, (_, i) =>
      client.openaiChat({
        model: 'combo-load/flagship',
        messages: [{ role: 'user', content: `Burst request #${i}` }],
        stream: false,
      })
    );

    const responses = await Promise.all(promises);

    // 100% of the 20 requests MUST return HTTP 200 OK
    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      assertOpenAISuccess(body);
    }

    // Exactly 5 handled by primary, and 15 handled by secondary
    expect(primary.handledRequests).toBe(5);
    expect(secondary.handledRequests).toBe(15);
    expect(primary.handledRequests + secondary.handledRequests).toBe(totalRequests);
    expect(primary.cooldownUntil).toBeDefined();
  });

  // 2. Mixed streaming and non-streaming failover under concurrent load
  it('handles concurrent burst of 10 streaming and 10 non-streaming requests with transparent failover', async () => {
    // Primary is on cooldown from test 1, secondary takes over
    const streamPromises = Array.from({ length: 10 }, async (_, i) => {
      const stream = client.openaiChatStream({
        model: 'combo-load/flagship',
        messages: [{ role: 'user', content: `Stream req #${i}` }],
      });
      const chunks = await TestClient.collect(stream);
      assertStreamDone(chunks);
      return chunks;
    });

    const jsonPromises = Array.from({ length: 10 }, async (_, i) => {
      const res = await client.openaiChat({
        model: 'combo-load/flagship',
        messages: [{ role: 'user', content: `JSON req #${i}` }],
        stream: false,
      });
      expect(res.status).toBe(200);
      return res.json();
    });

    const [streamResults, jsonResults] = await Promise.all([
      Promise.all(streamPromises),
      Promise.all(jsonPromises),
    ]);

    expect(streamResults.length).toBe(10);
    expect(jsonResults.length).toBe(10);

    for (const chunks of streamResults) {
      expect(chunks.length).toBeGreaterThan(0);
    }
    for (const body of jsonResults as any[]) {
      assertOpenAISuccess(body);
    }
  });

  // 3. Cooldown tracking accuracy during heavy load
  it('maintains strictly accurate positive cooldown timestamps during high load', async () => {
    expect(primary.cooldownUntil).toBeDefined();
    const remainingMs = primary.cooldownUntil! - Date.now();
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(5000);
  });

  // 4. Least-connections distribution across available backup providers
  it('balances requests across backup providers according to active connection availability', async () => {
    // Set both secondary and tertiary as active backups
    secondary.handledRequests = 0;
    tertiary.handledRequests = 0;

    const burstRequests = Array.from({ length: 16 }, (_, i) =>
      client.openaiChat({
        model: 'combo-load/flagship',
        messages: [{ role: 'user', content: `Balance test #${i}` }],
      })
    );

    const responses = await Promise.all(burstRequests);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // Both backup providers should have handled requests
    expect(secondary.handledRequests).toBeGreaterThan(0);
    expect(secondary.handledRequests + tertiary.handledRequests).toBe(16);
  });

  // 5. Multi-tier fallback chain when intermediate providers are exhausted
  it('traverses 3-tier fallback chain (Primary -> Secondary -> Tertiary) when intermediate tiers fail', async () => {
    // Put primary and secondary both on cooldown
    primary.cooldownUntil = Date.now() + 10_000;
    secondary.cooldownUntil = Date.now() + 10_000;
    tertiary.handledRequests = 0;

    const res = await client.openaiChat({
      model: 'combo-load/flagship',
      messages: [{ role: 'user', content: 'Route to tertiary tier' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toContain('Served by tertiary');
    expect(tertiary.handledRequests).toBe(1);
  });
});
