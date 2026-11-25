import { afterEach, describe, expect, test } from 'bun:test';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalComboManager } from '../../src/pool/combos';
import { globalAccountPool } from '../../src/pool/account-pool';
import { globalBreakerRegistry } from '../../src/core/breaker';
import { createServer } from '../../src/core/server';
import { GatewayError } from '../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor, HealthCheckResult, StoredAccount } from '../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';

const COMBO_ID = 'test/probe-release-combo';
const registeredPlugins: string[] = [];
const addedAccounts: string[] = [];

function okResponse(req: CanonicalRequest): CanonicalResponse {
  return {
    id: req.id,
    model: req.model,
    created: 1,
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

async function* contentStream(req: CanonicalRequest): AsyncGenerator<CanonicalStreamEvent> {
  yield { type: 'stream_start', id: 'resp_1', model: req.model, created: 1 };
  yield { type: 'text_delta', delta: 'ok' };
  yield { type: 'stream_end', stopReason: 'stop' };
}

async function* emptyStream(): AsyncGenerator<CanonicalStreamEvent> {
  // Connected, then died before any content.
}

class TargetPlugin implements ProviderPlugin {
  executeCalls = 0;
  streamCalls = 0;
  readonly displayName: string;
  readonly defaultBaseUrl = 'http://stub';

  constructor(
    readonly id: string,
    private readonly contextWindow: number,
    private streamFactory: (req: CanonicalRequest) => AsyncIterable<CanonicalStreamEvent> = contentStream
  ) {
    this.displayName = `Stub ${id}`;
  }

  useStream(factory: (req: CanonicalRequest) => AsyncIterable<CanonicalStreamEvent>): void {
    this.streamFactory = factory;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: `${this.id}/model`, name: this.id, contextWindow: this.contextWindow }];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.executeCalls++;
    return okResponse(req);
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.streamCalls++;
    return this.streamFactory(req);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, checkedAt: Date.now() };
  }
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    id: 'req_probe_release',
    clientDialect: 'openai-chat',
    model: COMBO_ID,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    ...overrides,
  };
}

function register(plugin: TargetPlugin): void {
  globalPluginRegistry.register(plugin);
  registeredPlugins.push(plugin.id);
}

function combo(targets: string[]): void {
  globalComboManager.createCombo({ id: COMBO_ID, name: COMBO_ID, targets, createdAt: Date.now() });
}

/** Open breaker whose backoff has expired: allow() is true until a probe begins. */
function expiredBreaker(providerId: string) {
  let now = 0;
  const breaker = globalBreakerRegistry.configure(providerId, {
    failureThreshold: 1,
    backoffBaseMs: 1000,
    backoffCeilingMs: 1000,
    jitterRatio: 0,
    now: () => now,
  });
  breaker.recordFailure(new GatewayError(503, 'service_unavailable', 'down'));
  now = 1000;
  return breaker;
}

async function consume(stream: AsyncIterable<CanonicalStreamEvent>): Promise<void> {
  for await (const _event of stream) { /* drain */ }
}

afterEach(() => {
  globalBreakerRegistry.reset();
  globalComboManager.deleteCombo(COMBO_ID);
  for (const id of registeredPlugins) globalPluginRegistry.unregister(id);
  registeredPlugins.length = 0;
  for (const id of addedAccounts) globalAccountPool.deleteAccount(id);
  addedAccounts.length = 0;
});

describe('combo probe release on every attempt exit', () => {
  test('context-window skip releases the half-open probe so the target is tried again', async () => {
    const target = new TargetPlugin('probe-ctx', 1000);
    register(target);
    combo([`${target.id}/model`]);
    const breaker = expiredBreaker(target.id);
    const plugin = new LatticeComboPlugin();

    await expect(plugin.execute(request({
      messages: [{ role: 'user', content: 'x'.repeat(40000) }],
    }))).rejects.toThrow(/context window/i);

    expect(breaker.allow()).toBe(true);
    await plugin.execute(request());
    expect(target.executeCalls).toBe(1);
  });

  test('exhausted-quota skip releases the half-open probe so the target is tried again', async () => {
    const target = new TargetPlugin('probe-quota', 100000);
    register(target);
    combo([`${target.id}/model`]);
    const breaker = expiredBreaker(target.id);
    const account: StoredAccount = {
      id: 'probe-quota-account',
      providerId: target.id,
      authType: 'api_key',
      status: 'active',
      credentials: { apiKey: 'key' },
      createdAt: 1,
      updatedAt: 1,
      errorCount: 0,
      quotaRemaining: 0,
    };
    globalAccountPool.addAccount(account);
    addedAccounts.push(account.id);
    const plugin = new LatticeComboPlugin();

    await expect(plugin.execute(request())).rejects.toThrow(/quota/i);
    expect(breaker.allow()).toBe(true);

    globalAccountPool.deleteAccount(account.id);
    addedAccounts.length = 0;
    await plugin.execute(request());
    expect(target.executeCalls).toBe(1);
  });

  test('empty-stream skip releases the half-open probe so the target is streamed again', async () => {
    const target = new TargetPlugin('probe-empty', 100000, emptyStream);
    register(target);
    combo([`${target.id}/model`]);
    const breaker = expiredBreaker(target.id);
    const plugin = new LatticeComboPlugin();

    await expect((async () => {
      await consume(await plugin.executeStream(request({ stream: true })));
    })()).rejects.toThrow(/empty stream/i);
    expect(breaker.allow()).toBe(true);

    target.useStream(contentStream);
    await consume(await plugin.executeStream(request({ stream: true })));
    expect(target.streamCalls).toBe(2);
  });

  test('probeInFlight is never left true after a skip, success or failure exit', async () => {
    const target = new TargetPlugin('probe-flag', 1000);
    register(target);
    combo([`${target.id}/model`]);
    const breaker = expiredBreaker(target.id);
    const plugin = new LatticeComboPlugin();

    await expect(plugin.execute(request({
      messages: [{ role: 'user', content: 'x'.repeat(40000) }],
    }))).rejects.toThrow(/context window/i);
    expect(breaker.isProbeInFlight).toBe(false);

    await plugin.execute(request());
    expect(breaker.isProbeInFlight).toBe(false);

    target.useStream(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new GatewayError(503, 'service_unavailable', 'down')),
        };
      },
    }));
    await expect((async () => {
      await consume(await plugin.executeStream(request({ stream: true })));
    })()).rejects.toThrow(/down/i);
    expect(breaker.isProbeInFlight).toBe(false);
  });

  test('admin breaker reset clears a wedged probe', async () => {
    const breaker = expiredBreaker('probe-admin-reset');
    breaker.beginAttempt();
    expect(breaker.allow()).toBe(false);
    expect(breaker.isProbeInFlight).toBe(true);

    const app = createServer({});
    const res = await app.request('/api/breakers/probe-admin-reset/reset', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(breaker.allow()).toBe(true);
    expect(breaker.state).toBe('closed');
    expect(breaker.isProbeInFlight).toBe(false);
  });
});
