import { afterEach, describe, expect, test } from 'bun:test';
import { GatewayError } from '../../src/core/types/errors';
import { AccountPoolManager } from '../../src/pool/account-pool';
import {
  BreakerRegistry,
  globalBreakerRegistry,
  isProviderHealthFailure,
} from '../../src/core/breaker';
import { createServer } from '../../src/core/server';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalComboManager } from '../../src/pool/combos';
import type { ProviderPlugin, ModelDescriptor, HealthCheckResult } from '../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../src/core/types/canonical';
import type { StoredAccount } from '../../src/core/types/plugin';

function account(id: string, providerId: string): StoredAccount {
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

const COMBO_ID = 'test/breaker-combo';

class StubPlugin implements ProviderPlugin {
  calls = 0;
  readonly displayName: string;
  readonly defaultBaseUrl = 'http://stub';
  cachedModels: ModelDescriptor[];
  constructor(readonly id: string, readonly modelId: string, readonly failWith?: GatewayError) {
    this.displayName = `Stub ${id}`;
    this.cachedModels = [{ id: modelId, name: modelId }];
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return this.cachedModels;
  }
  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return {
      id: req.id,
      model: req.model,
      created: 1,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.calls++;
    return (async function* () {
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, checkedAt: Date.now() };
  }
}

afterEach(() => {
  globalBreakerRegistry.reset();
  globalComboManager.deleteCombo(COMBO_ID);
  for (const plugin of globalPluginRegistry.getAll()) globalPluginRegistry.unregister(plugin.id);
});

describe('P1-3 provider breaker', () => {
  test('a 5xx storm trips the breaker at the configured threshold', () => {
    const registry = new BreakerRegistry({ failureThreshold: 3, now: () => 0 });
    const breaker = registry.get('provider-a');

    breaker.recordFailure(new GatewayError(500, 'internal_error', 'boom'));
    breaker.recordFailure(new GatewayError(503, 'service_unavailable', 'boom'));
    expect(breaker.state).toBe('closed');
    breaker.recordFailure(new GatewayError(502, 'bad_gateway', 'boom'));

    expect(breaker.state).toBe('open');
    expect(breaker.allow()).toBe(false);
  });

  test('backoff is exponential, jittered and never exceeds the ceiling', () => {
    const registry = new BreakerRegistry({
      failureThreshold: 1,
      backoffBaseMs: 1000,
      backoffCeilingMs: 4000,
      jitterRatio: 0,
      now: () => 0,
    });
    const breaker = registry.get('provider-a');
    const delays: number[] = [];
    for (let failure = 1; failure <= 8; failure++) {
      breaker.recordFailure(new GatewayError(500, 'internal_error', 'boom'));
      delays.push(breaker.retryDelayMs());
    }
    expect(delays).toEqual([1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]);

    const jittered = new BreakerRegistry({
      failureThreshold: 1,
      backoffBaseMs: 1000,
      backoffCeilingMs: 4000,
      jitterRatio: 0.5,
      now: () => 0,
    }).get('provider-b');
    jittered.recordFailure(new GatewayError(500, 'internal_error', 'boom'));
    expect(jittered.retryDelayMs()).toBeLessThanOrEqual(4000);
    expect(jittered.retryDelayMs()).toBeGreaterThanOrEqual(1000);
  });

  test('a timed-out open breaker allows exactly one half-open probe that can recover it', () => {
    let now = 0;
    const registry = new BreakerRegistry({
      failureThreshold: 1,
      backoffBaseMs: 1000,
      backoffCeilingMs: 1000,
      jitterRatio: 0,
      now: () => now,
    });
    const breaker = registry.get('provider-a');
    breaker.recordFailure(new GatewayError(500, 'internal_error', 'boom'));
    expect(breaker.allow()).toBe(false);

    now = 1000;
    expect(breaker.allow()).toBe(true);
    breaker.beginAttempt();
    expect(breaker.state).toBe('half-open');
    expect(breaker.allow()).toBe(false);

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.allow()).toBe(true);
  });

  test('a 4xx on a half-open probe does not wedge the breaker', () => {
    let now = 0;
    const breaker = new BreakerRegistry({
      failureThreshold: 1,
      backoffBaseMs: 1000,
      backoffCeilingMs: 1000,
      jitterRatio: 0,
      now: () => now,
    }).get('provider-a');
    breaker.recordFailure(new GatewayError(503, 'service_unavailable', 'down'));
    now = 1000;
    expect(breaker.allow()).toBe(true);
    breaker.beginAttempt();
    expect(breaker.state).toBe('half-open');

    expect(breaker.recordFailure(new GatewayError(404, 'model_not_found', 'bad model'))).toBe(false);
    expect(breaker.failures).toBe(1);
    expect(breaker.allow()).toBe(true);
  });

  test('client 4xx and caller aborts never trip the breaker', () => {
    const breaker = new BreakerRegistry({ failureThreshold: 1, now: () => 0 }).get('provider-a');
    for (let i = 0; i < 10; i++) {
      breaker.recordFailure(new GatewayError(400, 'invalid_request_error', 'bad input'));
      breaker.recordFailure(new GatewayError(429, 'rate_limit', 'slow down'));
      breaker.recordFailure(new DOMException('The operation was aborted', 'AbortError'));
    }
    expect(breaker.state).toBe('closed');
    expect(breaker.failures).toBe(0);
    expect(isProviderHealthFailure(new GatewayError(404, 'model_not_found', 'nope'))).toBe(false);
  });

  test('timeouts and network errors are counted as provider-health failures', () => {
    expect(isProviderHealthFailure(new GatewayError(504, 'gateway_timeout', 'late'))).toBe(true);
    expect(isProviderHealthFailure(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isProviderHealthFailure(Object.assign(new Error('too slow'), { name: 'TimeoutError' }))).toBe(true);
  });

  test('a 5xx whose message contains "aborted" is still a provider-health failure', () => {
    const err = new GatewayError(500, 'internal_error', 'aborted upstream');
    expect(isProviderHealthFailure(err)).toBe(true);

    const breaker = new BreakerRegistry({ failureThreshold: 1, now: () => 0 }).get('provider-a');
    expect(breaker.recordFailure(err)).toBe(true);
    expect(breaker.state).toBe('open');
  });

  test('a provider error with statusCode 500 is classified by status, not message', () => {
    const err = Object.assign(new Error('aborted upstream'), { statusCode: 500 });
    expect(isProviderHealthFailure(err)).toBe(true);
  });

  test('a real caller abort is excluded by error type, not message text', () => {
    expect(isProviderHealthFailure(Object.assign(new Error('aborted by caller'), { name: 'AbortError' }))).toBe(false);
    expect(isProviderHealthFailure(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(false);
  });

  test('the allocator skips accounts whose provider breaker is open', () => {
    const registry = new BreakerRegistry({ failureThreshold: 1, now: () => 0 });
    const pool = new AccountPoolManager(undefined, registry);
    const down = account('a-down', 'provider-down');
    const up = account('a-up', 'provider-up');
    pool.addAccount(down);
    pool.addAccount(up);
    registry.get('provider-down').recordFailure(new GatewayError(503, 'service_unavailable', 'down'));

    const reservation = pool.acquireAccount([down, up]);
    expect(reservation?.account.providerId).toBe('provider-up');
    reservation?.release();
  });

  test('a 5xx storm through the gateway trips the provider breaker', async () => {
    const failing = new StubPlugin('breaker-5xx', 'breaker-5xx/model', new GatewayError(503, 'service_unavailable', 'down'));
    globalBreakerRegistry.configure('breaker-5xx', { failureThreshold: 2 });
    const app = createServer({}, [failing]);

    for (let i = 0; i < 2; i++) {
      await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'breaker-5xx/model', messages: [{ role: 'user', content: 'hi' }] }),
      });
    }
    expect(globalBreakerRegistry.get('breaker-5xx').state).toBe('open');
    expect(globalBreakerRegistry.get('breaker-5xx').allow()).toBe(false);
  });

  test('client 4xx through the gateway never trips the breaker', async () => {
    const failing = new StubPlugin('breaker-4xx', 'breaker-4xx/model', new GatewayError(400, 'invalid_request_error', 'bad input'));
    globalBreakerRegistry.configure('breaker-4xx', { failureThreshold: 1 });
    const app = createServer({}, [failing]);

    for (let i = 0; i < 3; i++) {
      await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'breaker-4xx/model', messages: [{ role: 'user', content: 'hi' }] }),
      });
    }
    expect(globalBreakerRegistry.get('breaker-4xx').state).toBe('closed');
    expect(globalBreakerRegistry.get('breaker-4xx').failures).toBe(0);
  });

  test('combo failover skips a target whose provider breaker is open', async () => {
    const down = new StubPlugin('breaker-target-down', 'breaker-target-down/model');
    const up = new StubPlugin('breaker-target-up', 'breaker-target-up/model');
    globalPluginRegistry.register(down);
    globalPluginRegistry.register(up);
    globalComboManager.createCombo({
      id: COMBO_ID,
      name: 'Breaker combo',
      targets: ['breaker-target-down/model', 'breaker-target-up/model'],
      createdAt: Date.now(),
    });
    globalBreakerRegistry.configure('breaker-target-down', { failureThreshold: 1 });
    globalBreakerRegistry.get('breaker-target-down').recordFailure(new GatewayError(503, 'service_unavailable', 'down'));

    const res = await new LatticeComboPlugin().execute({
      id: 'req_breaker',
      clientDialect: 'openai-chat',
      model: COMBO_ID,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(res.model).toBe(COMBO_ID);
    expect(down.calls).toBe(0);
    expect(up.calls).toBe(1);
  });

  test('an open breaker leaves a sole circuit-broken provider with no allocatable account', () => {
    const registry = new BreakerRegistry({ failureThreshold: 1, now: () => 0 });
    const pool = new AccountPoolManager(undefined, registry);
    const down = account('a-down-only', 'provider-down-only');
    pool.addAccount(down);

    registry.get('provider-down-only').recordFailure(new GatewayError(503, 'service_unavailable', 'down'));
    expect(registry.get('provider-down-only').allow()).toBe(false);
    expect(pool.acquireAccount([down])).toBeUndefined();
  });
});
