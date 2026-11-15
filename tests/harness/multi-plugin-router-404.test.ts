import { describe, it, expect } from 'bun:test';
import { createServer } from '../../src/core/server';
import { ProviderPlugin, ModelDescriptor } from '../../src/core/types/plugin';
import {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';
import { GatewayError } from '../../src/core/types/errors';

// Helper to create simple mock plugin
function createMockPlugin(
  id: string,
  models: ModelDescriptor[],
  options?: { shouldFailListModels?: boolean }
): ProviderPlugin {
  return {
    id,
    displayName: `${id.toUpperCase()} Plugin`,
    defaultBaseUrl: `https://${id}.local/v1`,
    listModels: async () => {
      if (options?.shouldFailListModels) {
        throw new Error(`Plugin ${id} catalog service offline`);
      }
      return models;
    },
    execute: async (req: CanonicalRequest): Promise<CanonicalResponse> => {
      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [{ type: 'text', text: `Response from ${id} for ${req.model}` }],
        stopReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    },
    executeStream: async (req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> => {
      async function* gen() {
        yield { type: 'text_delta' as const, delta: `Stream from ${id} for ${req.model}` };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }
      return gen();
    },
  };
}

describe('Empirical Verification: Router 404 Behavior Under Multi-Plugin Configurations', () => {
  const pluginAlpha = createMockPlugin('alpha', [
    { id: 'alpha/gpt-4o', name: 'Alpha GPT-4o', created: 1731693600 },
    { id: 'alpha/gpt-4o-mini', name: 'Alpha GPT-4o Mini', created: 1731693600 },
    { id: 'alpha-fast', name: 'Alpha Fast (bare)', created: 1731693600 },
  ]);

  const pluginBeta = createMockPlugin('beta', [
    { id: 'beta/claude-3-7-sonnet', name: 'Beta Claude 3.7 Sonnet', created: 1731693600 },
    { id: 'beta/claude-3-5-haiku', name: 'Beta Claude 3.5 Haiku', created: 1731693600 },
  ]);

  const pluginGamma = createMockPlugin('gamma', [
    { id: 'gamma/deepseek-r1', name: 'Gamma DeepSeek R1', created: 1731693600 },
  ]);

  const multiApp = createServer({}, [pluginAlpha, pluginBeta, pluginGamma]);

  // --------------------------------------------------------------------------
  // 1. Non-existent model without vendor prefix
  // --------------------------------------------------------------------------
  describe('Unprefixed non-existent model', () => {
    it('POST /v1/chat/completions returns 404 in OpenAI dialect with model_not_found', async () => {
      const res = await multiApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'completely-nonexistent-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-request-id')).toBeTruthy();

      const json: any = await res.json();
      expect(json).toHaveProperty('error');
      expect(json.error.type).toBe('not_found_error');
      expect(json.error.code).toBe('model_not_found');
      expect(json.error.message).toContain('No active provider found for model: completely-nonexistent-model');
    });

    it('POST /v1/messages returns 404 in Anthropic dialect with not_found_error', async () => {
      const res = await multiApp.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'completely-nonexistent-model',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-request-id')).toBeTruthy();

      const json: any = await res.json();
      expect(json.type).toBe('error');
      expect(json.error.type).toBe('not_found_error');
      expect(json.error.message).toContain('No active provider found for model: completely-nonexistent-model');
    });

    it('POST /v1/responses returns 404 in OpenAI Responses dialect', async () => {
      const res = await multiApp.request('/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'completely-nonexistent-model',
          input: 'hello',
        }),
      });

      expect(res.status).toBe(404);
      const json: any = await res.json();
      expect(json.status).toBe('failed');
      expect(json.error.code).toBe('model_not_found');
      expect(json.error.message).toContain('No active provider found for model: completely-nonexistent-model');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Non-existent model with unknown vendor prefix
  // --------------------------------------------------------------------------
  describe('Unknown vendor prefix', () => {
    it('POST /v1/chat/completions returns 404 for unknown-vendor/some-model', async () => {
      const res = await multiApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'unknown-vendor/some-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(res.status).toBe(404);
      const json: any = await res.json();
      expect(json.error.type).toBe('not_found_error');
      expect(json.error.code).toBe('model_not_found');
      expect(json.error.message).toContain('No active provider found for model: unknown-vendor/some-model');
    });

    it('POST /v1/messages returns 404 for unknown-vendor/some-model', async () => {
      const res = await multiApp.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'unknown-vendor/some-model',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(404);
      const json: any = await res.json();
      expect(json.type).toBe('error');
      expect(json.error.type).toBe('not_found_error');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Streaming mode rejection before stream creation
  // --------------------------------------------------------------------------
  describe('Streaming mode behavior on non-existent model', () => {
    it('OpenAI stream=true returns immediate HTTP 404 JSON, NOT a 200 SSE stream', async () => {
      const res = await multiApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-stream-model',
          messages: [{ role: 'user', content: 'stream test' }],
          stream: true,
        }),
      });

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-type')).not.toContain('text/event-stream');

      const json: any = await res.json();
      expect(json.error.code).toBe('model_not_found');
    });

    it('Anthropic stream=true returns immediate HTTP 404 JSON, NOT a 200 SSE stream', async () => {
      const res = await multiApp.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-stream-model',
          messages: [{ role: 'user', content: 'stream test' }],
          max_tokens: 100,
          stream: true,
        }),
      });

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-type')).not.toContain('text/event-stream');

      const json: any = await res.json();
      expect(json.error.type).toBe('not_found_error');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Positive controls: valid models route to correct plugins
  // --------------------------------------------------------------------------
  describe('Positive controls across multi-plugin deployment', () => {
    it('routes alpha/gpt-4o to alpha plugin with 200 OK', async () => {
      const res = await multiApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'alpha/gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.choices[0].message.content).toContain('Response from alpha');
    });

    it('routes beta/claude-3-7-sonnet to beta plugin with 200 OK', async () => {
      const res = await multiApp.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'beta/claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.content[0].text).toContain('Response from beta');
    });

    it('routes gamma/deepseek-r1 to gamma plugin with 200 OK', async () => {
      const res = await multiApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gamma/deepseek-r1',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.choices[0].message.content).toContain('Response from gamma');
    });

    it('routes bare model name claude-3-7-sonnet to beta plugin via catalog bareName mapping', async () => {
      const res = await multiApp.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'test bare' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.content[0].text).toContain('Response from beta');
    });

    it('routes bare model name alpha-fast to alpha plugin via catalog', async () => {
      const res = await multiApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'alpha-fast',
          messages: [{ role: 'user', content: 'test bare' }],
        }),
      });

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.choices[0].message.content).toContain('Response from alpha');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Zero plugins edge case
  // --------------------------------------------------------------------------
  describe('Zero plugins active edge case', () => {
    it('returns 503 service_unavailable when plugins map is truly empty (no plugins registered)', async () => {
      // Directly create Hono app with empty plugins map (bypassing M1 auto-mock fallback)
      const emptyApp = new (await import('hono')).Hono();
      const { registerRoutes } = await import('../../src/core/router');
      const { loadConfig } = await import('../../src/core/config');
      const { GatewayError, serializeDialectError } = await import('../../src/core/types/errors');

      emptyApp.onError((err, c) => {
        if (err instanceof GatewayError) {
          return c.json(serializeDialectError(err, 'openai'), err.statusCode as any);
        }
        return c.json({ error: 'unknown' }, 500);
      });

      registerRoutes(emptyApp as any, { config: loadConfig(), plugins: new Map() });

      const res = await emptyApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'any-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      expect(res.status).toBe(503);
      const json: any = await res.json();
      expect(json.error.type).toBe('api_error');
      expect(json.error.code).toBe('service_unavailable');
      expect(json.error.message).toContain('No provider plugins are currently registered');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Resilient catalog build when one plugin fails listModels()
  // --------------------------------------------------------------------------
  describe('Catalog fault tolerance', () => {
    it('successfully routes to healthy plugins and returns 404 for unknown models when one plugin throws during listModels', async () => {
      const faultyPlugin = createMockPlugin('faulty', [], { shouldFailListModels: true });
      const mixedApp = createServer({}, [pluginAlpha, faultyPlugin]);

      // Healthy model should work
      const okRes = await mixedApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'alpha/gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });
      expect(okRes.status).toBe(200);

      // Non-existent model should return 404 cleanly, without 500 crash
      const notFoundRes = await mixedApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'totally-unknown-model',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });
      expect(notFoundRes.status).toBe(404);
      const json: any = await notFoundRes.json();
      expect(json.error.code).toBe('model_not_found');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Concurrent request stress testing
  // --------------------------------------------------------------------------
  describe('Concurrent 404 stress test', () => {
    it('serves 50 concurrent requests for invalid models with 100% 404 responses and unique request IDs', async () => {
      const requests = Array.from({ length: 50 }, (_, i) => {
        const isAnthropic = i % 2 === 0;
        const modelName = `stress-bogus-model-${i}`;
        const path = isAnthropic ? '/v1/messages' : '/v1/chat/completions';
        const body = isAnthropic
          ? { model: modelName, messages: [{ role: 'user', content: `test ${i}` }], max_tokens: 50 }
          : { model: modelName, messages: [{ role: 'user', content: `test ${i}` }] };

        return multiApp.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      });

      const responses = await Promise.all(requests);
      expect(responses.length).toBe(50);

      const requestIds = new Set<string>();
      for (const res of responses) {
        expect(res.status).toBe(404);
        const reqId = res.headers.get('x-request-id');
        expect(reqId).toBeTruthy();
        requestIds.add(reqId!);

        const json: any = await res.json();
        if (json.type === 'error') {
          expect(json.error.type).toBe('not_found_error');
        } else {
          expect(json.error.code).toBe('model_not_found');
        }
      }

      // All 50 concurrent requests must have unique request IDs
      expect(requestIds.size).toBe(50);
    });
  });
});
