import { describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../src/core/types/canonical';
import type { ProviderPlugin } from '../../src/core/types/plugin';

let captured: CanonicalRequest | undefined;

function stub(id: string, capabilities?: ProviderPlugin['capabilities']): ProviderPlugin {
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'http://stub',
    capabilities,
    cachedModels: [{ id: `${id}/model`, name: id }],
    listModels: async () => [{ id: `${id}/model`, name: id }],
    execute: async (req: CanonicalRequest): Promise<CanonicalResponse> => {
      captured = req;
      return {
        id: req.id,
        model: req.model,
        created: 1,
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    executeStream: async (): Promise<AsyncIterable<CanonicalStreamEvent>> =>
      (async function* () {
        yield { type: 'stream_end', stopReason: 'stop' };
      })(),
  };
}

async function post(model: string, extra: Record<string, unknown> = {}) {
  return createServer({}, [stub('structured-supported', { responseFormat: true, samplingFields: true }), stub('structured-unsupported')])
    .request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } },
        frequency_penalty: 0.5,
        presence_penalty: -0.25,
        seed: 42,
        ...extra,
      }),
    });
}

describe('P1-4 structured outputs and sampling fields', () => {
  test('response_format and sampling fields reach the provider', async () => {
    captured = undefined;
    const res = await post('structured-supported/model');
    expect(res.status).toBe(200);
    expect((captured as any)?.responseFormat).toEqual({
      type: 'json_schema',
      jsonSchema: { name: 'answer', strict: true },
    });
    expect((captured as any)?.frequencyPenalty).toBe(0.5);
    expect((captured as any)?.presencePenalty).toBe(-0.25);
    expect((captured as any)?.seed).toBe(42);
  });

  test('an unsupported provider rejects response_format explicitly', async () => {
    const res = await post('structured-unsupported/model');
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('response_format');
  });
});
