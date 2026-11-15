import { describe, it, expect } from 'bun:test';
import { createServer } from '../../src/core/server';
import { MockProviderPlugin } from '../mocks/mock-provider';

describe('Server Ingress & Route Integration (Hono in-memory)', () => {
  const mockPlugin = new MockProviderPlugin();
  const app = createServer({ defaultKeepaliveMs: 100 }, [mockPlugin]);

  it('I1: GET /healthz returns 200 OK', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.version).toBe('0.1.0');
  });

  it('I2: GET /live returns 200 OK', async () => {
    const res = await app.request('/live');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.live).toBe(true);
  });

  it('I3: GET /v1/models returns aggregated list', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(8);
    const modelIds = body.data.map((m: any) => m.id);
    expect(modelIds).toContain('mock-chat');
    expect(modelIds).toContain('mock-thinking');
  });

  it('I4: POST /v1/chat/completions non-streaming JSON', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'Testing OpenAI endpoint' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toContain('Echo: Testing OpenAI endpoint');
  });

  it('I5: POST /v1/chat/completions streaming SSE', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'Testing stream' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {');
    expect(text).toContain('data: [DONE]\n\n');
  });

  it('I6: POST /v1/messages non-streaming JSON', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'Testing Anthropic endpoint' }],
        max_tokens: 100,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toContain('Echo: Testing Anthropic endpoint');
  });

  it('I7: POST /v1/messages streaming SSE with thinking', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-thinking',
        messages: [{ role: 'user', content: 'Solve this' }],
        stream: true,
        max_tokens: 200,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('"type":"thinking"');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_stop');
  });

  it('I8: POST /v1/responses non-streaming JSON', async () => {
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        input: 'Test response',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
  });

  it('I9: POST /v1/chat/completions invalid body returns 400', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ malformed_json: ',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('I10: POST /v1/messages invalid body returns 400', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid_body: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('I11: POST /v1/chat/completions 429 error simulation', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-error-429',
        messages: [{ role: 'user', content: 'test rate limit' }],
      }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe('rate_limit_error');
    expect(res.headers.get('retry-after')).toBe('20');
  });

  it('I12: OPTIONS preflight returns permissive CORS', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('I13: x-request-id tracing header preservation', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'req_custom_123',
      },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'Check trace header' }],
      }),
    });

    expect(res.headers.get('x-request-id')).toBe('req_custom_123');
  });
});
