import { describe, it, expect } from 'bun:test';
import { createServer } from '../../src/core/server';
import { assertRemovedAggregatorAvailable } from '../../src/plugins/removed-aggregator';

describe('SEC-06 / F-08: no fallback FreeLLMAPI credential', () => {
  it('fails closed with a clear message when FREELLMAPI_API_KEY is absent', () => {
    expect(() => assertRemovedAggregatorAvailable('freellmapi/model', {})).toThrow(/FREELLMAPI_API_KEY/);
  });

  it('still rejects when the key is present because no adapter is installed', () => {
    expect(() => assertRemovedAggregatorAvailable('freellmapi/model', { FREELLMAPI_API_KEY: 'configured' }))
      .toThrow(/no.*adapter|unavailable/i);
  });

  it('does not affect other model prefixes', () => {
    expect(() => assertRemovedAggregatorAvailable('kilo/model', {})).not.toThrow();
  });

  it('returns a non-success response for a freellmapi model request', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'freellmapi/model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toContain('FREELLMAPI_API_KEY');
  });
});

// Behavioral kill for the removed hardcoded-key fallback: if an adapter with
// a shipped default credential is restored, it will call this fake upstream
// (the retired plugin's hardcoded base URL) and the hit count gives it away.
describe('behavioral: retired model never reaches a fallback upstream', () => {
  const ENV_KEY = ['FREE', 'LLM', 'API', '_API_KEY'].join('');
  const MODEL = `${['free', 'llm', 'api'].join('')}/model`;
  const LEGACY_PORT = 31415;

  async function requestWithEnv(value: string | undefined) {
    const previous = process.env[ENV_KEY];
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;

    let hits = 0;
    const upstream = Bun.serve({
      port: LEGACY_PORT,
      fetch() {
        hits++;
        return new Response(
          JSON.stringify({
            id: 'fallback',
            object: 'chat.completion',
            created: 1,
            model: 'fallback',
            choices: [{ index: 0, message: { role: 'assistant', content: 'fallback served' }, finish_reason: 'stop' }],
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      },
    });
    try {
      const app = createServer({});
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = (await res.json()) as any;
      return { status: res.status, code: body?.error?.code ?? '', hits };
    } finally {
      upstream.stop(true);
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    }
  }

  it('fails closed with no upstream hit when no key is configured', async () => {
    const result = await requestWithEnv(undefined);
    expect(result.status).toBe(503);
    expect(result.code).toBe('plugin_unavailable');
    expect(result.hits).toBe(0);
  }, 15_000);

  it('fails closed with no upstream hit even when a key is configured', async () => {
    const result = await requestWithEnv('operator-supplied-key');
    expect(result.status).toBe(503);
    expect(result.code).toBe('plugin_unavailable');
    expect(result.hits).toBe(0);
  }, 15_000);
});
