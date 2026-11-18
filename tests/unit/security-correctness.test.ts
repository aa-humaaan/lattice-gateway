import { describe, expect, test } from 'bun:test';
import { parseRetryAfterSeconds } from '../../src/utils/retry-after';
import { withRequestDeadline } from '../../src/utils/request-deadline';
import { createServer } from '../../src/core/server';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { requestLedger } from '../../src/admin/admin-router';
import type { ProviderPlugin, ModelDescriptor } from '../../src/core/types/plugin';

describe('Retry-After parsing', () => {
  test('parses delta-seconds', () => {
    expect(parseRetryAfterSeconds('30')).toBe(30);
  });

  test('parses an HTTP date into a positive delay', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfterSeconds(future)).toBeGreaterThan(0);
    expect(parseRetryAfterSeconds(future)).toBeLessThanOrEqual(60);
  });

  test('uses the fallback for missing or malformed values', () => {
    expect(parseRetryAfterSeconds(null, 15)).toBe(15);
    expect(parseRetryAfterSeconds('not-a-date', 15)).toBe(15);
    expect(parseRetryAfterSeconds('-5', 15)).toBe(15);
  });
});

describe('request deadlines', () => {
  test('rejects a hung non-streaming operation', async () => {
    const hung = new Promise<string>(() => {});
    await expect(withRequestDeadline(hung, 20, 'test')).rejects.toThrow(/timed out/);
  });

  test('returns a fast result unchanged', async () => {
    expect(await withRequestDeadline(Promise.resolve('ok'), 1000, 'test')).toBe('ok');
  });
});

describe('ledger honesty', () => {
  function noUsageStub(id: string) {
    return {
      id,
      displayName: id,
      description: id,
      defaultBaseUrl: 'http://localhost',
      async listModels() {
        return [{
          id: `${id}/model`, name: id, providerId: id, created: 1,
          contextWindow: 100000, supportsStreaming: true, supportsTools: false,
          supportsThinking: false, isFree: true, tags: [],
        }];
      },
      async execute() {
        return { id: 'r', model: `${id}/model`, created: 1, content: [{ type: 'text' as const, text: 'hi' }], stopReason: 'stop' as const };
      },
      async executeStream() {
        return (async function* () {
          yield { type: 'stream_start' as const, id: 's', model: `${id}/model`, created: 1 };
          yield { type: 'text_delta' as const, delta: 'hi' };
          yield { type: 'stream_error' as const, error: { message: 'dropped', type: 'upstream', code: 'dropped', status: 502 } };
        })();
      },
      async healthCheck() { return { healthy: true, checkedAt: Date.now() }; },
    } as unknown as ProviderPlugin;
  }

  test('usage inferred at the edge is labelled estimated', async () => {
    const plugin = noUsageStub('estimate_stub');
    globalPluginRegistry.register(plugin);
    try {
      const app = createServer({}, [plugin]);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'estimate_stub/model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
      const last = requestLedger.readRecent(1)[0];
      expect(last.provider).toBe('estimate_stub');
      expect(last.estimated).toBeTrue();
    } finally {
      globalPluginRegistry.unregister('estimate_stub');
    }
  });

  test('a failed stream is recorded with its real status', async () => {
    const plugin = noUsageStub('failed_stream_stub');
    globalPluginRegistry.register(plugin);
    try {
      const app = createServer({}, [plugin]);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'failed_stream_stub/model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      await res.text();
      const last = requestLedger.readRecent(1)[0];
      expect(last.provider).toBe('failed_stream_stub');
      expect(last.status).toBe(502);
    } finally {
      globalPluginRegistry.unregister('failed_stream_stub');
    }
  });
});

describe('honest combo failover', () => {
  function streamStub(id: string, behaviour: 'fail-before-content' | 'metadata-then-fail' | 'fail-after-content' | 'succeed') {
    return {
      id,
      displayName: id,
      description: id,
      defaultBaseUrl: 'http://localhost',
      async listModels() {
        return [{
          id: `${id}/model`, name: id, providerId: id, created: 1,
          contextWindow: 100000, supportsStreaming: true, supportsTools: false,
          supportsThinking: false, isFree: true, tags: [],
        }];
      },
      async execute() {
        throw new Error('not used');
      },
      async executeStream() {
        return (async function* () {
          if (behaviour === 'fail-before-content') {
            const err: any = new Error('rate limited');
            err.status = 429;
            throw err;
          }
          yield { type: 'stream_start' as const, id: 's', model: `${id}/model`, created: 1 };
          if (behaviour === 'metadata-then-fail') {
            const err: any = new Error('rate limited after metadata');
            err.status = 429;
            throw err;
          }
          yield { type: 'text_delta' as const, delta: 'hello' };
          if (behaviour === 'fail-after-content') {
            const err: any = new Error('connection dropped');
            err.status = 502;
            throw err;
          }
          yield { type: 'stream_end' as const, stopReason: 'stop' as const };
        })();
      },
      async healthCheck() { return { healthy: true, checkedAt: Date.now() }; },
    } as unknown as ProviderPlugin;
  }

  test('a stream failing before any content retries the next target', async () => {
    const { LatticeComboPlugin } = await import('../../src/plugins/combo');
    const { globalComboManager } = await import('../../src/pool/combos');
    const first = streamStub('pre_fail_stub', 'fail-before-content');
    const second = streamStub('pre_ok_stub', 'succeed');
    globalPluginRegistry.register(first);
    globalPluginRegistry.register(second);
    globalComboManager.createCombo({
      id: 'test/pre-content', name: 'pre', description: '',
      targets: ['pre_fail_stub/model', 'pre_ok_stub/model'], createdAt: Date.now(),
    });
    try {
      const combo = new LatticeComboPlugin();
      const stream = await combo.executeStream({
        id: 'r', model: 'test/pre-content', messages: [{ role: 'user', content: 'hi' }],
      } as any);
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      expect(events.some((e) => e.type === 'text_delta' && e.delta === 'hello')).toBeTrue();
    } finally {
      globalPluginRegistry.unregister('pre_fail_stub');
      globalPluginRegistry.unregister('pre_ok_stub');
      globalComboManager.deleteCombo('test/pre-content');
    }
  });

  test('a stream that dies after metadata but before content retries the next target', async () => {
    const { LatticeComboPlugin } = await import('../../src/plugins/combo');
    const { globalComboManager } = await import('../../src/pool/combos');
    const first = streamStub('meta_fail_stub', 'metadata-then-fail');
    const second = streamStub('meta_ok_stub', 'succeed');
    globalPluginRegistry.register(first);
    globalPluginRegistry.register(second);
    globalComboManager.createCombo({
      id: 'test/metadata-then-fail', name: 'meta', description: '',
      targets: ['meta_fail_stub/model', 'meta_ok_stub/model'], createdAt: Date.now(),
    });
    try {
      const combo = new LatticeComboPlugin();
      const stream = await combo.executeStream({
        id: 'r', model: 'test/metadata-then-fail', messages: [{ role: 'user', content: 'hi' }],
      } as any);
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      expect(events.some((e) => e.type === 'text_delta' && e.delta === 'hello')).toBeTrue();
    } finally {
      globalPluginRegistry.unregister('meta_fail_stub');
      globalPluginRegistry.unregister('meta_ok_stub');
      globalComboManager.deleteCombo('test/metadata-then-fail');
    }
  });

  test('a stream failing after content emits an error and does not switch targets', async () => {
    const { LatticeComboPlugin } = await import('../../src/plugins/combo');
    const { globalComboManager } = await import('../../src/pool/combos');
    const first = streamStub('post_fail_stub', 'fail-after-content');
    const second = streamStub('post_ok_stub', 'succeed');
    globalPluginRegistry.register(first);
    globalPluginRegistry.register(second);
    globalComboManager.createCombo({
      id: 'test/post-content', name: 'post', description: '',
      targets: ['post_fail_stub/model', 'post_ok_stub/model'], createdAt: Date.now(),
    });
    try {
      const combo = new LatticeComboPlugin();
      const stream = await combo.executeStream({
        id: 'r', model: 'test/post-content', messages: [{ role: 'user', content: 'hi' }],
      } as any);
      const events: any[] = [];
      for await (const event of stream) events.push(event);
      expect(events.some((e) => e.type === 'stream_error')).toBeTrue();
      expect(events.filter((e) => e.type === 'text_delta' && e.delta === 'hello')).toHaveLength(1);
    } finally {
      globalPluginRegistry.unregister('post_fail_stub');
      globalPluginRegistry.unregister('post_ok_stub');
      globalComboManager.deleteCombo('test/post-content');
    }
  });
});

describe('plugin enable state', () => {
  function stub(id: string): ProviderPlugin {
    const model: ModelDescriptor = {
      id: `${id}/model`, name: id, providerId: id, created: 1,
      contextWindow: 1000, supportsStreaming: false, supportsTools: false,
      supportsThinking: false, isFree: true, tags: [],
    };
    return {
      id,
      displayName: id,
      description: id,
      defaultBaseUrl: 'http://localhost',
      async listModels() { return [model]; },
      async execute() { return { id: 'r', model: model.id, created: 1, content: [{ type: 'text' as const, text: id }], stopReason: 'stop' as const }; },
      async executeStream() {
        return (async function* () {})();
      },
      async healthCheck() { return { healthy: true, checkedAt: Date.now() }; },
    } as unknown as ProviderPlugin;
  }

  test('oversized request bodies are rejected before parsing', async () => {
    const app = createServer({ maxBodyBytes: 100 });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  test('disabled plugins are absent from /v1/models', async () => {
    const enabled = stub('enabled_stub');
    const disabled = stub('disabled_stub');
    globalPluginRegistry.register(enabled);
    globalPluginRegistry.register(disabled, false);
    try {
      const app = createServer({}, [enabled, disabled]);
      const res = await app.request('/v1/models');
      const json = (await res.json()) as any;
      const ids = json.data.map((m: any) => m.id);
      expect(ids).toContain('enabled_stub/model');
      expect(ids).not.toContain('disabled_stub/model');
    } finally {
      globalPluginRegistry.unregister('enabled_stub');
      globalPluginRegistry.unregister('disabled_stub');
    }
  });
});
