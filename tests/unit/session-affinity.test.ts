import { describe, expect, test } from 'bun:test';
import {
  createSessionAffinityStore,
  deriveSessionKey,
} from '../../src/core/session-affinity';
import { createServer } from '../../src/core/server';
import type { CanonicalRequest } from '../../src/core/types/canonical';
import type { ProviderPlugin } from '../../src/core/types/plugin';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalComboManager } from '../../src/pool/combos';

describe('session affinity identity', () => {
  test('hashes raw identifiers deterministically without retaining them', () => {
    const raw = 'customer@example.com/private-conversation';
    const first = deriveSessionKey({ 'x-lattice-session': raw });
    const second = deriveSessionKey({ 'X-Lattice-Session': raw });

    expect(first).toBe(second);
    expect(first).toMatch(/^ses_[a-f0-9]{32}$/);
    expect(first).not.toContain('customer');
  });

  test('header identity wins over supported metadata fallbacks', () => {
    const fromHeader = deriveSessionKey(
      { 'x-lattice-session': 'header-session' },
      { metadata: { session_id: 'metadata-session' } }
    );
    expect(fromHeader).toBe(deriveSessionKey({}, { metadata: { session_id: 'header-session' } }));
    expect(fromHeader).not.toBe(deriveSessionKey({}, { metadata: { session_id: 'metadata-session' } }));
  });

  test('supports conversation and task metadata but ignores user identity and unrelated metadata', () => {
    expect(deriveSessionKey({}, { metadata: { conversation_id: 'conversation' } })).toBeTruthy();
    expect(deriveSessionKey({}, { metadata: { task_id: 'task' } })).toBeTruthy();
    expect(deriveSessionKey({}, { metadata: { user_id: 'anthropic-user' } })).toBeUndefined();
    expect(deriveSessionKey({}, { metadata: { arbitrary: 'not-a-session' } })).toBeUndefined();
    expect(deriveSessionKey()).toBeUndefined();
  });
});

describe('bounded session affinity store', () => {
  test('keeps target and provider account pins isolated by session', () => {
    const store = createSessionAffinityStore();
    store.pinTarget('ses_a', 'model/a');
    store.pinAccount('ses_a', 'kilo', 'account/a');
    store.pinTarget('ses_b', 'model/b');
    store.pinAccount('ses_b', 'kilo', 'account/b');

    expect(store.getTarget('ses_a')).toBe('model/a');
    expect(store.getAccount('ses_a', 'kilo')).toBe('account/a');
    expect(store.getTarget('ses_b')).toBe('model/b');
    expect(store.getAccount('ses_b', 'kilo')).toBe('account/b');
  });

  test('expires idle entries after the configured TTL', () => {
    let now = 1_000;
    const store = createSessionAffinityStore({ ttlMs: 100, now: () => now });
    store.pinTarget('ses_expiring', 'model/a');
    now = 1_101;

    expect(store.getTarget('ses_expiring')).toBeUndefined();
    expect(store.listSummary()).toEqual([]);
  });

  test('evicts the least recently used entry at capacity', () => {
    let now = 1;
    const store = createSessionAffinityStore({ maxEntries: 2, now: () => now });
    store.pinTarget('ses_old', 'model/old');
    now = 2;
    store.pinTarget('ses_keep', 'model/keep');
    now = 3;
    expect(store.getTarget('ses_old')).toBe('model/old');
    now = 4;
    store.pinTarget('ses_new', 'model/new');

    expect(store.getTarget('ses_keep')).toBeUndefined();
    expect(store.getTarget('ses_old')).toBe('model/old');
    expect(store.getTarget('ses_new')).toBe('model/new');
  });

  test('summary contains only hashed identity, pins and expiry', () => {
    let now = 500;
    const raw = 'raw-private-session';
    const sessionKey = deriveSessionKey({ 'x-lattice-session': raw })!;
    const store = createSessionAffinityStore({ ttlMs: 1_000, now: () => now });
    store.pinTarget(sessionKey, 'kilo/model');
    store.pinAccount(sessionKey, 'kilo', 'acc_1');

    const json = JSON.stringify(store.listSummary());
    expect(json).not.toContain(raw);
    expect(store.listSummary()).toEqual([{
      sessionKey,
      targetModel: 'kilo/model',
      accounts: [{ providerId: 'kilo', accountId: 'acc_1' }],
      expiresAt: 1_500,
    }]);
  });

  test('reading summaries does not keep idle sessions alive', () => {
    let now = 1_000;
    const store = createSessionAffinityStore({ ttlMs: 100, now: () => now });
    store.pinTarget('ses_idle', 'model/a');
    now = 1_050;
    expect(store.listSummary()).toHaveLength(1);
    now = 1_101;
    expect(store.getTarget('ses_idle')).toBeUndefined();
  });
});

describe('gateway affinity ingress', () => {
  test('all three dialects attach the same hashed header session key', async () => {
    const seen: CanonicalRequest[] = [];
    const plugin = {
      id: 'affinity_ingress',
      displayName: 'Affinity Ingress',
      defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [{ id: 'affinity_ingress/model', name: 'Affinity', providerId: 'affinity_ingress' }];
      },
      async execute(request: CanonicalRequest) {
        seen.push(request);
        return {
          id: 'response', model: request.model, created: 1,
          content: [{ type: 'text' as const, text: 'ok' }], stopReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async executeStream() { return (async function* () {})(); },
    } as ProviderPlugin;
    const app = createServer({}, [plugin]);
    const headers = {
      'Content-Type': 'application/json',
      'x-lattice-session': 'same-private-session',
      'Authorization': 'Bearer gateway-secret',
      'User-Agent': 'affinity-test-client',
    };

    await app.request('/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'affinity_ingress/model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await app.request('/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'affinity_ingress/model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await app.request('/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'affinity_ingress/model', input: 'hi' }),
    });

    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((request) => request.affinity?.sessionKey)).size).toBe(1);
    expect(seen[0].affinity?.sessionKey).toMatch(/^ses_[a-f0-9]{32}$/);
    expect(JSON.stringify(seen.map((request) => request.rawHeaders))).not.toContain('gateway-secret');
    expect(JSON.stringify(seen.map((request) => request.rawHeaders))).not.toContain('same-private-session');
    expect(seen[0].rawHeaders?.['user-agent']).toBe('affinity-test-client');
  });

  test('metadata supplies affinity while requests without identity remain stateless', async () => {
    const seen: CanonicalRequest[] = [];
    const plugin = {
      id: 'affinity_metadata', displayName: 'Affinity Metadata', defaultBaseUrl: 'https://example.com',
      async listModels() { return [{ id: 'affinity_metadata/model', name: 'Affinity' }]; },
      async execute(request: CanonicalRequest) {
        seen.push(request);
        return {
          id: 'response', model: request.model, created: 1,
          content: [{ type: 'text' as const, text: 'ok' }], stopReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async executeStream() { return (async function* () {})(); },
    } as ProviderPlugin;
    const app = createServer({}, [plugin]);
    const base = { model: 'affinity_metadata/model', messages: [{ role: 'user', content: 'hi' }] };

    await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, metadata: { conversation_id: 'metadata-session' } }),
    });
    await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(base),
    });

    expect(seen[0].affinity?.sessionKey).toBe(deriveSessionKey({}, { metadata: { conversation_id: 'metadata-session' } }));
    expect(seen[1].affinity).toBeUndefined();
  });
});

describe('combo target affinity', () => {
  test('a successful fallback becomes the next turn target without affecting another session', async () => {
    const store = createSessionAffinityStore();
    let firstFails = true;
    const calls: string[] = [];
    const provider = (id: string, shouldFail: () => boolean): ProviderPlugin => ({
      id, displayName: id, defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [{ id: `${id}/model`, name: id, contextWindow: 100_000 }];
      },
      async execute(request) {
        calls.push(id);
        if (shouldFail()) throw new Error(`${id} unavailable`);
        return {
          id: 'response', model: request.model, created: 1,
          content: [{ type: 'text', text: id }], stopReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async executeStream() { return (async function* () {})(); },
    });
    const first = provider('affinity_target_first', () => firstFails);
    const second = provider('affinity_target_second', () => false);
    globalPluginRegistry.register(first);
    globalPluginRegistry.register(second);
    globalComboManager.createCombo({
      id: 'test/affinity-target', name: 'Affinity Target', createdAt: Date.now(),
      targets: ['affinity_target_first/model', 'affinity_target_second/model'],
    });
    try {
      const combo = new LatticeComboPlugin(undefined, store);
      const request = (sessionKey: string) => ({
        id: 'request', clientDialect: 'openai-chat' as const,
        model: 'test/affinity-target', messages: [{ role: 'user' as const, content: 'hi' }],
        stream: false, affinity: { sessionKey },
      });
      await combo.execute(request('ses_one'));
      expect(store.getTarget('ses_one')).toBe('affinity_target_second/model');

      firstFails = false;
      calls.length = 0;
      await combo.execute(request('ses_one'));
      expect(calls[0]).toBe('affinity_target_second');

      calls.length = 0;
      await combo.execute(request('ses_two'));
      expect(calls[0]).toBe('affinity_target_first');
      expect(store.getTarget('ses_two')).toBe('affinity_target_first/model');
    } finally {
      globalComboManager.deleteCombo('test/affinity-target');
      globalPluginRegistry.unregister(first.id);
      globalPluginRegistry.unregister(second.id);
    }
  });

  test('a stream failure before content repins the successful fallback', async () => {
    const store = createSessionAffinityStore();
    const provider = (id: string, failBeforeContent: boolean): ProviderPlugin => ({
      id, displayName: id, defaultBaseUrl: 'https://example.com',
      async listModels() { return [{ id: `${id}/model`, name: id, contextWindow: 100_000 }]; },
      async execute() { throw new Error('not used'); },
      async executeStream(request) {
        return (async function* () {
          yield { type: 'stream_start' as const, id: 'stream', model: request.model, created: 1 };
          if (failBeforeContent) throw new Error('dropped before content');
          yield { type: 'text_delta' as const, delta: id };
          yield { type: 'stream_end' as const, stopReason: 'stop' as const };
        })();
      },
    });
    const first = provider('affinity_stream_first', true);
    const second = provider('affinity_stream_second', false);
    globalPluginRegistry.register(first);
    globalPluginRegistry.register(second);
    globalComboManager.createCombo({
      id: 'test/affinity-stream', name: 'Affinity Stream', createdAt: Date.now(),
      targets: ['affinity_stream_first/model', 'affinity_stream_second/model'],
    });
    store.pinTarget('ses_stream', 'affinity_stream_first/model');
    try {
      const combo = new LatticeComboPlugin(undefined, store);
      const stream = await combo.executeStream({
        id: 'request', clientDialect: 'openai-chat', model: 'test/affinity-stream',
        messages: [{ role: 'user', content: 'hi' }], stream: true,
        affinity: { sessionKey: 'ses_stream' },
      });
      for await (const _event of stream) { /* consume */ }
      expect(store.getTarget('ses_stream')).toBe('affinity_stream_second/model');
    } finally {
      globalComboManager.deleteCombo('test/affinity-stream');
      globalPluginRegistry.unregister(first.id);
      globalPluginRegistry.unregister(second.id);
    }
  });
});
