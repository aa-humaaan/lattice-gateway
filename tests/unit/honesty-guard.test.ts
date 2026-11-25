import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import type { CanonicalRequest } from '../../src/core/types/canonical';
import type { ProviderPlugin, StoredAccount } from '../../src/core/types/plugin';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import { ClinePoolPlugin } from '../../src/plugins/cline';
import { NousProviderPlugin } from '../../src/plugins/nous';
import { DeepSeekPoolPlugin } from '../../src/plugins/deepseek';
import { OpenCodeProviderPlugin } from '../../src/plugins/opencode';
import { createServer } from '../../src/core/server';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { requestLedger } from '../../src/admin/admin-router';

// SOURCE GUARD: these numbers and claims live in shipped source/config text,
// not in a callable module. No in-process API exposes them, so the only way to
// catch a reintroduced fake counter or claim is to inspect the text itself.
describe('SOURCE GUARD: no fabricated telemetry ships', () => {
  const router = readFileSync('src/admin/admin-router.ts', 'utf8');
  const catalog = readFileSync('src/admin/models-catalog.ts', 'utf8');

  test('no seeded counters, multipliers or fake log rows', () => {
    expect(router).not.toContain('524300');
    expect(router).not.toContain('813700');
    expect(router).not.toContain('let multiplier');
    expect(router).not.toContain('effectiveLogs = [');
    expect(router).not.toContain('/api/telemetry/simulate');
  });

  test('no random measurements', () => {
    expect(catalog).not.toContain('Math.random');
    expect(router).not.toContain('Math.random');
  });

  test('README does not advertise proxy rotation or uTLS', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).not.toContain('Egress Proxy Manager');
    expect(readme).not.toContain('uTLS Bun ClientHello');
    expect(readme).not.toContain('(uTLS Bun / 0$)');
    expect(readme).not.toContain('egress proxy rotation');
  });

  test('telemetry and usage endpoints derive from the ledger', () => {
    expect(router).toContain('requestLedger.metrics()');
    expect(router).toContain('requestLedger.readRecent(');
  });
});

describe('no plugin fabricates usage when upstream omits it', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const account = (providerId: string): StoredAccount => ({
    id: `test-${providerId}`,
    providerId,
    authType: 'api_key',
    credentials: { accessToken: 'test-token' },
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    errorCount: 0,
  });

  const request: CanonicalRequest = {
    id: 'req_f21',
    clientDialect: 'openai-chat',
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    stream: false,
  };

  const factories: Array<[string, () => ProviderPlugin]> = [
    ['kilo', () => new KiloProviderPlugin('http://127.0.0.1:1')],
    ['cline', () => new ClinePoolPlugin('http://127.0.0.1:1', [account('cline')])],
    ['nous', () => new NousProviderPlugin('http://127.0.0.1:1')],
    ['deepseek', () => new DeepSeekPoolPlugin('http://127.0.0.1:1', [account('deepseek')])],
    ['opencode', () => new OpenCodeProviderPlugin('http://127.0.0.1:1')],
  ];

  test.each(factories)('%s labels omitted usage estimated, never reported', async (_name, create) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    const result = await create().execute(request);

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.estimated).not.toBe(false);
    expect(result.usage.promptTokens).not.toBe(10);
    expect(result.usage.completionTokens).not.toBe(15);
    expect(result.usage.totalTokens).not.toBe(25);
    expect(result.usage.promptTokens + result.usage.completionTokens + result.usage.totalTokens).toBe(0);
  });

  test('router records upstream-omitted usage as estimated, never reported', async () => {
    const id = 'f21-estimated-stub';
    const plugin = {
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
        return {
          id: 'r', model: `${id}/model`, created: 1,
          content: [{ type: 'text' as const, text: 'hi' }], stopReason: 'stop' as const,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true },
        };
      },
    } as unknown as ProviderPlugin;
    globalPluginRegistry.register(plugin);
    try {
      const app = createServer({}, [plugin]);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `${id}/model`, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
      const event = requestLedger.readRecent(50).find((entry) => entry.provider === id);
      expect(event?.estimated).toBeTrue();
    } finally {
      globalPluginRegistry.unregister(id);
    }
  });
});
