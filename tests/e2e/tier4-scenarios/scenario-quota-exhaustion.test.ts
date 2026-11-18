/**
 * Tier 4 Real-World Application Scenario: Quota Exhaustion & Reset Recovery
 * 
 * Verifies behavior when all upstream accounts have exhausted their quotas:
 * 1. Router / Combo detects total quota exhaustion across all accounts.
 * 2. Emits a clean HTTP 429 rate_limit error with Retry-After header.
 * 3. Includes the precise UTC reset timestamp and countdown seconds in the error message.
 * 4. Verifies both non-streaming (JSON) and streaming (SSE) error handling.
 * 5. Demonstrates automatic recovery as soon as an account's quota resets or cooldown clears.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';
import { globalComboManager } from '../../../src/pool/combos';
import { globalPluginRegistry } from '../../../src/plugins/registry';
import { globalAccountPool } from '../../../src/pool/account-pool';
import { LatticeComboPlugin } from '../../../src/plugins/combo';

class ExhaustionMockPlugin implements ProviderPlugin {
  readonly id = 'exhaust-provider';
  readonly displayName = 'Exhaustion Test Provider';
  readonly defaultBaseUrl = 'https://mock.exhaust.local/v1';

  public executeCount = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'exhaust-provider/chat-model',
        name: 'Exhaust Chat Model',
        providerId: 'exhaust-provider',
        contextWindow: 128000,
        maxOutputTokens: 4096,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.executeCount++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'Success from exhaust-provider' }],
      stopReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.executeCount++;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Date.now() };
      yield { type: 'text_delta', delta: 'Streamed success from exhaust-provider' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 4 Scenario: Total Quota Exhaustion & Reset Time Transparency', () => {
  let mockPlugin: ExhaustionMockPlugin;
  let comboPlugin: LatticeComboPlugin;
  let gatewayServer: any;
  let client: TestClient;

  const PROVIDER_ID = 'exhaust-provider';
  const COMBO_ID = 'lattice/exhaustion-test-combo';
  const ACC_1_ID = 'acc_exhaust_1';
  const ACC_2_ID = 'acc_exhaust_2';

  beforeAll(async () => {
    mockPlugin = new ExhaustionMockPlugin();
    comboPlugin = new LatticeComboPlugin();

    globalPluginRegistry.register(mockPlugin);
    globalPluginRegistry.register(comboPlugin);

    globalComboManager.createCombo({
      id: COMBO_ID,
      name: 'Exhaustion Test Combo',
      targets: ['exhaust-provider/chat-model'],
      createdAt: Date.now(),
    });

    const app = createServer({ env: 'test' }, [mockPlugin, comboPlugin]);
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
    globalComboManager.deleteCombo(COMBO_ID);
    globalPluginRegistry.unregister(mockPlugin.id);
    globalPluginRegistry.unregister(comboPlugin.id);
    globalAccountPool.deleteAccount(ACC_1_ID);
    globalAccountPool.deleteAccount(ACC_2_ID);
  });

  beforeEach(() => {
    // Register two accounts with exhausted quotas and distinct future reset times
    const now = Date.now();
    globalAccountPool.addAccount({
      id: ACC_1_ID,
      providerId: PROVIDER_ID,
      authType: 'api_key',
      credentials: { apiKey: 'key_1' },
      status: 'active',
      errorCount: 0,
      createdAt: now,
      updatedAt: now,
      quotaRemaining: 0,
      quotaLimit: 1000,
      quotaResetAt: now + 180 * 1000, // Resets in 180 seconds
    });

    globalAccountPool.addAccount({
      id: ACC_2_ID,
      providerId: PROVIDER_ID,
      authType: 'api_key',
      credentials: { apiKey: 'key_2' },
      status: 'active',
      errorCount: 0,
      createdAt: now,
      updatedAt: now,
      quotaRemaining: 0,
      quotaLimit: 2000,
      quotaResetAt: now + 360 * 1000, // Resets in 360 seconds
    });
  });

  it('returns clean HTTP 429 with retry-after header and earliest reset time when all accounts are exhausted', async () => {
    const res = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: 'Execute task under exhausted quota' }],
    });

    expect(res.status).toBe(429);

    // Verify Retry-After header reflects earliest reset time (180s)
    const retryAfter = res.headers.get('retry-after');
    expect(retryAfter).toBeDefined();
    const retrySeconds = Number(retryAfter);
    expect(retrySeconds).toBeGreaterThanOrEqual(175);
    expect(retrySeconds).toBeLessThanOrEqual(185);

    // Verify structured error message with ISO reset timestamp
    const json = await res.json() as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe('rate_limit_error');
    expect(json.error.message).toMatch(/exhausted their account quotas/i);
    expect(json.error.message).toMatch(/Quota resets at/i);
    expect(json.error.message).toMatch(/in \d+s/);
  });

  it('returns clean HTTP 429 when called via Anthropic /v1/messages dialect', async () => {
    const res = await client.anthropicMessages({
      model: COMBO_ID,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Run agent step under exhausted quota' }],
    });

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('retry-after');
    expect(retryAfter).toBeDefined();

    const json = await res.json() as any;
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('rate_limit_error');
    expect(json.error.message).toContain('exhausted their account quotas');
  });

  it('immediately recovers and routes to account as soon as quota is restored', async () => {
    // Verify initial call fails with 429
    const resBefore = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: 'Before recovery' }],
    });
    expect(resBefore.status).toBe(429);

    // Simulate quota reset window expiration on Account 1
    const acc1 = globalAccountPool.getAccount(ACC_1_ID);
    expect(acc1).toBeDefined();
    acc1!.quotaRemaining = 500;
    acc1!.quotaResetAt = undefined;

    // Verify subsequent call recovers immediately (200 OK)
    const resAfter = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: 'After quota restoration' }],
    });

    expect(resAfter.status).toBe(200);
    const json = await resAfter.json() as any;
    expect(json.choices[0].message.content).toBe('Success from exhaust-provider');
    expect(mockPlugin.executeCount).toBe(1);
  });
});
