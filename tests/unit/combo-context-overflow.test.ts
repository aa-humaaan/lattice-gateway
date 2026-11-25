import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalComboManager } from '../../src/pool/combos';
import type { ProviderPlugin, ModelDescriptor, HealthCheckResult } from '../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';
import { GatewayError } from '../../src/core/types/errors';
import { globalBreakerRegistry } from '../../src/core/breaker';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createModelPassportStore, createPassportSigner } from '../../src/core/model-passports';
import {
  estimateMessagesTokens,
  estimatePromptTokens,
} from '../../src/utils/token-estimator';

class StubPlugin implements ProviderPlugin {
  readonly defaultBaseUrl = 'http://stub';
  readonly displayName: string;

  constructor(
    readonly id: string,
    private models: ModelDescriptor[],
    private behavior: (req: CanonicalRequest) => Promise<CanonicalResponse> = async (req) =>
      Response0(req),
    private streamBehavior: (req: CanonicalRequest) => Promise<AsyncIterable<CanonicalStreamEvent>> = async (req) =>
      emptyStream(req)
  ) {
    this.displayName = `Stub ${id}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    return this.behavior(req);
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    return this.streamBehavior(req);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, checkedAt: Date.now() };
  }
}

function Response0(req: CanonicalRequest): CanonicalResponse {
  return {
    id: 'resp_1',
    model: req.model,
    created: Math.floor(Date.now() / 1000),
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

async function* emptyStreamImpl(req: CanonicalRequest): AsyncGenerator<CanonicalStreamEvent> {
  yield { type: 'stream_start', id: 'resp_1', model: req.model, created: Date.now() };
  yield { type: 'text_delta', delta: 'ok' };
  yield { type: 'stream_end', stopReason: 'stop' };
}

function emptyStream(req: CanonicalRequest): AsyncIterable<CanonicalStreamEvent> {
  return emptyStreamImpl(req);
}

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    id: 'req_lat_test',
    clientDialect: 'openai-chat',
    model: 'test/ctxfailover-combo',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    ...overrides,
  };
}

function bigPrompt(tokensApprox: number): string {
  return 'x'.repeat(tokensApprox * 4);
}

describe('Token Estimator', () => {
  it('estimates text message tokens at ~4 chars per token', () => {
    const messages = [{ role: 'user' as const, content: 'a'.repeat(400) }];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThanOrEqual(100);
    expect(tokens).toBeLessThanOrEqual(110);
  });

  it('accounts for tool_use and tool_result parts', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use' as const, id: 'call_1', name: 'read_file', input: { path: 'src/a.ts' } },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          { type: 'tool_result' as const, toolCallId: 'call_1', content: 'b'.repeat(400) },
        ],
      },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(100);
  });

  it('counts system prompt and tools', () => {
    const estimate = estimatePromptTokens({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'y'.repeat(400),
      tools: [
        {
          type: 'function',
          function: { name: 'read', description: 'reads files', parameters: { type: 'object' } },
        },
      ],
    });
    expect(estimate.systemTokens).toBeGreaterThanOrEqual(100);
    expect(estimate.toolsTokens).toBeGreaterThan(0);
    expect(estimate.total).toBeGreaterThan(estimate.messagesTokens);
  });
});

describe('Combo Context-Aware Failover', () => {
  const registered: string[] = [];

  beforeEach(() => {
    globalComboManager.createCombo({
      id: 'test/ctxfailover-combo',
      name: 'Test Combo',
      targets: ['ctx-stub-small/model', 'ctx-stub-big/model'],
      createdAt: Date.now(),
    });
  });

  afterEach(() => {
    globalComboManager.deleteCombo('test/ctxfailover-combo');
    globalComboManager.deleteCombo('test/ctxfailover-clamp');
    globalComboManager.deleteCombo('test/unavailable-combo');
    globalBreakerRegistry.reset();
    for (const id of registered) {
      globalPluginRegistry.unregister(id);
    }
    registered.length = 0;
  });

  function registerPlugin(plugin: ProviderPlugin) {
    globalPluginRegistry.register(plugin);
    registered.push(plugin.id);
  }

  it('skips a small-context target and routes to a large-context target when prompt exceeds small context', async () => {
    let smallCalled = false;
    const small = new StubPlugin(
      'ctx-stub-small',
      [{ id: 'ctx-stub-small/model', name: 'Small', contextWindow: 8000 }],
      async (req) => {
        smallCalled = true;
        return Response0(req);
      }
    );
    const big = new StubPlugin('ctx-stub-big', [{ id: 'ctx-stub-big/model', name: 'Big', contextWindow: 200000 }]);
    registerPlugin(small);
    registerPlugin(big);

    const plugin = new LatticeComboPlugin();
    const req = makeRequest({
      messages: [{ role: 'user', content: bigPrompt(20000) }],
    });

    const res = await plugin.execute(req);
    expect(smallCalled).toBe(false);
    expect(res.model).toBe('test/ctxfailover-combo');
  });

  it('prefers a valid passport context over a stale live descriptor', async () => {
    let staleCalled = false;
    const stale = new StubPlugin(
      'ctx-stub-small',
      [{ id: 'ctx-stub-small/model', name: 'Stale', contextWindow: 200000 }],
      async (req) => {
        staleCalled = true;
        return Response0(req);
      }
    );
    const big = new StubPlugin('ctx-stub-big', [
      { id: 'ctx-stub-big/model', name: 'Big', contextWindow: 200000 },
    ]);
    registerPlugin(stale);
    registerPlugin(big);
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-combo-'));
    try {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe({ id: 'ctx-stub-small/model', name: 'Measured Small', contextWindow: 8000 }, 'ctx-stub-small', 10);
      const combo = new LatticeComboPlugin(store);
      await combo.execute(makeRequest({
        messages: [{ role: 'user', content: bigPrompt(20000) }],
      }));
      expect(staleCalled).toBeFalse();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a tampered passport and falls through to the live descriptor', async () => {
    let liveCalled = false;
    const live = new StubPlugin(
      'ctx-stub-small',
      [{ id: 'ctx-stub-small/model', name: 'Live', contextWindow: 200000 }],
      async (req) => {
        liveCalled = true;
        return Response0(req);
      }
    );
    const big = new StubPlugin('ctx-stub-big', [
      { id: 'ctx-stub-big/model', name: 'Big', contextWindow: 200000 },
    ]);
    registerPlugin(live);
    registerPlugin(big);
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-combo-'));
    try {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      const passport = store.observe(
        { id: 'ctx-stub-small/model', name: 'Tampered', contextWindow: 8000 },
        'ctx-stub-small',
        10
      );
      passport.claims.contextWindow!.value = 1;
      const combo = new LatticeComboPlugin(store);
      await combo.execute(makeRequest({
        messages: [{ role: 'user', content: bigPrompt(20000) }],
      }));
      expect(liveCalled).toBeTrue();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls through when a valid passport has no context claim', async () => {
    let liveCalled = false;
    const live = new StubPlugin(
      'ctx-stub-small',
      [{ id: 'ctx-stub-small/model', name: 'Live', contextWindow: 200000 }],
      async (req) => {
        liveCalled = true;
        return Response0(req);
      }
    );
    const big = new StubPlugin('ctx-stub-big', [
      { id: 'ctx-stub-big/model', name: 'Big', contextWindow: 200000 },
    ]);
    registerPlugin(live);
    registerPlugin(big);
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-combo-'));
    try {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe({ id: 'ctx-stub-small/model', name: 'No Context' }, 'ctx-stub-small', 10);
      const combo = new LatticeComboPlugin(store);
      await combo.execute(makeRequest({
        messages: [{ role: 'user', content: bigPrompt(20000) }],
      }));
      expect(liveCalled).toBeTrue();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns context_length_exceeded when all targets are too small', async () => {
    const small1 = new StubPlugin('ctx-stub-small', [
      { id: 'ctx-stub-small/model', name: 'Small1', contextWindow: 8000 },
    ]);
    const small2 = new StubPlugin('ctx-stub-big', [
      { id: 'ctx-stub-big/model', name: 'Small2', contextWindow: 8000 },
    ]);
    registerPlugin(small1);
    registerPlugin(small2);

    const plugin = new LatticeComboPlugin();
    const req = makeRequest({
      messages: [{ role: 'user', content: bigPrompt(50000) }],
    });

    const err = await plugin.execute(req).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('context_length_exceeded');
    expect(err.message).toMatch(/context window/i);
  });

  it('returns 503 all_targets_unavailable when every target is circuit-broken (non-stream)', async () => {
    const downA = new StubPlugin('unavail-a', [{ id: 'unavail-a/model', name: 'A' }]);
    const downB = new StubPlugin('unavail-b', [{ id: 'unavail-b/model', name: 'B' }]);
    registerPlugin(downA);
    registerPlugin(downB);
    for (const id of ['unavail-a', 'unavail-b']) {
      globalBreakerRegistry.configure(id, {
        failureThreshold: 1,
        backoffBaseMs: 60_000,
        backoffCeilingMs: 60_000,
        jitterRatio: 0,
      });
      globalBreakerRegistry.get(id).recordFailure(new GatewayError(503, 'service_unavailable', 'down'));
    }
    globalComboManager.createCombo({
      id: 'test/unavailable-combo',
      name: 'Unavailable Combo',
      targets: ['unavail-a/model', 'unavail-b/model'],
      createdAt: Date.now(),
    });

    const err = await new LatticeComboPlugin().execute(
      makeRequest({ model: 'test/unavailable-combo' })
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('all_targets_unavailable');
    expect(err.message).toMatch(/all targets.*unavailable/i);
  });

  it('returns 503 all_targets_unavailable when every target is unresolvable', async () => {
    globalComboManager.createCombo({
      id: 'test/unavailable-combo',
      name: 'Unresolvable Combo',
      targets: ['ghost-a/model', 'ghost-b/model'],
      createdAt: Date.now(),
    });

    const err = await new LatticeComboPlugin().execute(
      makeRequest({ model: 'test/unavailable-combo' })
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('all_targets_unavailable');
    expect(err.message).toMatch(/all targets.*unavailable/i);
  });

  it('returns 503 all_targets_unavailable when every stream target is circuit-broken', async () => {
    const downA = new StubPlugin('unavail-stream-a', [{ id: 'unavail-stream-a/model', name: 'A' }]);
    const downB = new StubPlugin('unavail-stream-b', [{ id: 'unavail-stream-b/model', name: 'B' }]);
    registerPlugin(downA);
    registerPlugin(downB);
    for (const id of ['unavail-stream-a', 'unavail-stream-b']) {
      globalBreakerRegistry.configure(id, {
        failureThreshold: 1,
        backoffBaseMs: 60_000,
        backoffCeilingMs: 60_000,
        jitterRatio: 0,
      });
      globalBreakerRegistry.get(id).recordFailure(new GatewayError(503, 'service_unavailable', 'down'));
    }
    globalComboManager.createCombo({
      id: 'test/unavailable-combo',
      name: 'Unavailable Stream Combo',
      targets: ['unavail-stream-a/model', 'unavail-stream-b/model'],
      createdAt: Date.now(),
    });

    const err = await new LatticeComboPlugin()
      .executeStream(makeRequest({ model: 'test/unavailable-combo', stream: true }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('all_targets_unavailable');
    expect(err.message).toMatch(/all targets.*unavailable/i);
  });

  it('clamps maxTokens to the available output budget for the selected target', async () => {
    let observedMaxTokens: number | undefined;
    const pluginA = new StubPlugin(
      'ctx-stub-kilo',
      [{ id: 'ctx-stub-small/model', name: 'Small', contextWindow: 8000 }],
      async (req) => {
        observedMaxTokens = req.maxTokens;
        return Response0(req);
      }
    );
    registerPlugin(pluginA);

    globalComboManager.createCombo({
      id: 'test/ctxfailover-clamp',
      name: 'Clamp Combo',
      targets: ['ctx-stub-kilo/ctx-stub-small/model'],
      createdAt: Date.now(),
    });

    try {
      const plugin = new LatticeComboPlugin();
      const req = makeRequest({
        model: 'test/ctxfailover-clamp',
        messages: [{ role: 'user', content: bigPrompt(1000) }],
        maxTokens: 8192,
      });

      await plugin.execute(req);
      expect(observedMaxTokens).toBeDefined();
      expect(observedMaxTokens!).toBeLessThan(8192);
      expect(observedMaxTokens!).toBeGreaterThan(0);
    } finally {
      globalComboManager.deleteCombo('test/ctxfailover-clamp');
    }
  });

  it('classifies upstream context-overflow errors and continues to next target', async () => {
    let bigCalled = false;
    const small = new StubPlugin(
      'ctx-stub-ovf-small',
      [{ id: 'ctx-stub-ovf-small/model', name: 'Small', contextWindow: 200000 }],
      async () => {
        throw new GatewayError(
          400,
          'context_length_exceeded',
          "This model's maximum context length is 8192 tokens"
        );
      }
    );
    const big = new StubPlugin('ctx-stub-ovf-big', [{ id: 'ctx-stub-ovf-big/model', name: 'Big', contextWindow: 200000 }], async (req) => {
      bigCalled = true;
      return Response0(req);
    });
    registerPlugin(small);
    registerPlugin(big);

    globalComboManager.createCombo({
      id: 'test/ctxfailover-ovf',
      name: 'Overflow Test',
      targets: ['ctx-stub-ovf-small/model', 'ctx-stub-ovf-big/model'],
      createdAt: Date.now(),
    });

    try {
      const plugin = new LatticeComboPlugin();
      const req = makeRequest({
        model: 'test/ctxfailover-ovf',
      });
      const res = await plugin.execute(req);
      expect(bigCalled).toBe(true);
      expect(res.model).toBe('test/ctxfailover-ovf');
    } finally {
      globalComboManager.deleteCombo('test/ctxfailover-ovf');
    }
  });

  it('caps target attempts for both non-stream and stream execution', async () => {
    const calls: string[] = [];
    const provider = new StubPlugin(
      'cap-provider',
      Array.from({ length: 6 }, (_, index) => ({
        id: `cap-provider/model-${index}`, name: `M${index}`, contextWindow: 100000,
      })),
      async (req) => {
        calls.push(req.model);
        throw new Error('all targets down');
      },
      async (req) => {
        calls.push(req.model);
        throw new Error('all targets down');
      }
    );
    registerPlugin(provider);
    globalComboManager.createCombo({
      id: 'test/cap',
      name: 'Cap',
      createdAt: Date.now(),
      targets: Array.from({ length: 6 }, (_, index) => `cap-provider/model-${index}`),
    });
    try {
      const combo = new LatticeComboPlugin();
      await expect(combo.execute(makeRequest({ model: 'test/cap' }))).rejects.toThrow();
      expect(calls.length).toBe(4);
      calls.length = 0;
      await expect((async () => {
        const stream = await combo.executeStream(makeRequest({ model: 'test/cap', stream: true }));
        for await (const _event of stream) { /* consume */ }
      })()).rejects.toThrow();
      expect(calls.length).toBe(4);
    } finally {
      globalComboManager.deleteCombo('test/cap');
    }
  });

  it('skips small targets and streams from a large target', async () => {
    let smallStreamed = false;
    const small = new StubPlugin(
      'ctx-stub-kilo',
      [{ id: 'ctx-stub-small/model', name: 'Small', contextWindow: 8000 }],
      async (req) => Response0(req),
      async (req) => {
        smallStreamed = true;
        return emptyStream(req);
      }
    );
    const big = new StubPlugin('ctx-stub-big', [{ id: 'ctx-stub-big/model', name: 'Big', contextWindow: 200000 }]);
    registerPlugin(small);
    registerPlugin(big);

    const plugin = new LatticeComboPlugin();
    const req = makeRequest({
      stream: true,
      messages: [{ role: 'user', content: bigPrompt(20000) }],
    });

    const stream = await plugin.executeStream(req);
    const events: CanonicalStreamEvent[] = [];
    for await (const e of stream) events.push(e);

    expect(smallStreamed).toBe(false);
    const start = events.find((e) => e.type === 'stream_start');
    expect(start && start.type === 'stream_start' && start.model).toBe('test/ctxfailover-combo');
  });
});
