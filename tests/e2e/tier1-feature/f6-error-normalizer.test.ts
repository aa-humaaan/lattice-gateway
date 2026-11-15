/**
 * Tier 1 Feature Coverage: F6 - Universal Error Normalizer
 * 
 * Verifies standard error mapping and dialect-compliant responses:
 * - 400 Bad Request error returned in dialect format (OpenAI vs Anthropic)
 * - 401 Unauthorized error formatted with proper error type
 * - 404 Route / Model Not Found error formatted with proper message
 * - 429 Rate Limit error with Retry-After header and cooldown details
 * - 500 / 502 Upstream Gateway Error gracefully caught and formatted
 * - Preservation of x-request-id trace header on all error responses
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient } from '../../harness/test-client';
import { assertDialectError, assertRetryAfterHeader } from '../../harness/assertions';

describe('F6: Universal Error Normalizer', () => {
  let gateway: GatewayInstance;
  let client: TestClient;

  beforeAll(async () => {
    gateway = await startGateway({ mode: 'in-process' });
    client = new TestClient(gateway.baseUrl);
  });

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  // 1. 400 Bad Request error returned in dialect format (OpenAI vs Anthropic)
  it('formats 400 Bad Request error in OpenAI dialect envelope', async () => {
    const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid json payload string{',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 400);

    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Invalid JSON payload');
  });

  it('formats 400 Bad Request error in Anthropic dialect envelope', async () => {
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'malformed anthropic json body}',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    assertDialectError(body, 'anthropic');

    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Invalid JSON payload');
  });

  // 2. 401 Unauthorized error formatted with proper error type
  it('returns 401 Unauthorized error formatted in client dialect', async () => {
    // OpenAI dialect
    const res1 = await client.openaiChat({
      model: 'mock-error-401',
      messages: [{ role: 'user', content: 'test 401' }],
    });

    expect(res1.status).toBe(401);
    const body1 = (await res1.json()) as any;
    assertDialectError(body1, 'openai', 401);
    expect(body1.error.type).toBe('authentication_error');

    // Anthropic dialect
    const res2 = await client.anthropicMessages({
      model: 'mock-error-401',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test 401' }],
    });

    expect(res2.status).toBe(401);
    const body2 = (await res2.json()) as any;
    assertDialectError(body2, 'anthropic');
    expect(body2.error.type).toBe('authentication_error');
  });

  // 3. 404 Route / Model Not Found error formatted with proper error message
  it('returns 404 Not Found formatted in client dialect for unknown routes', async () => {
    const resOpenAI = await fetch(`${gateway.baseUrl}/v1/unknown_openai_path`, {
      method: 'GET',
    });
    expect(resOpenAI.status).toBe(404);
    const bodyOpenAI = (await resOpenAI.json()) as any;
    assertDialectError(bodyOpenAI, 'openai', 404);
    expect(bodyOpenAI.error.message).toContain('was not found');

    const resAnthropic = await fetch(`${gateway.baseUrl}/v1/messages/unknown_path`, {
      method: 'GET',
    });
    expect(resAnthropic.status).toBe(404);
    const bodyAnthropic = (await resAnthropic.json()) as any;
    assertDialectError(bodyAnthropic, 'anthropic');
    expect(bodyAnthropic.error.message).toContain('was not found');
  });

  // 4. 429 Rate Limit error with Retry-After header and cooldown information
  it('returns 429 Rate Limit error with Retry-After header and cooldown details', async () => {
    const res = await client.openaiChat({
      model: 'mock-error-429',
      messages: [{ role: 'user', content: 'trigger rate limit' }],
    });

    expect(res.status).toBe(429);
    assertRetryAfterHeader(res.headers, 20);

    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 429);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toContain('429 Rate Limit Exceeded');
  });

  // 5. 500 / 502 Upstream Gateway Error gracefully caught and formatted
  it('catches upstream 500 failure gracefully without unhandled exceptions or crashes', async () => {
    const res = await client.openaiChat({
      model: 'mock-error-500',
      messages: [{ role: 'user', content: 'trigger server error' }],
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 500);
    expect(body.error.message).toContain('Mock provider simulated 500');
  });

  // 6. Preservation of x-request-id trace header on error responses
  it('attaches x-request-id tracing header to error responses for diagnostics', async () => {
    const customTraceId = 'req_trace_diag_987654321';
    const res = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': customTraceId,
      },
      body: 'bad json',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe(customTraceId);
  });
});
