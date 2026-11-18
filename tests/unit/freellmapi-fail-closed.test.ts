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
