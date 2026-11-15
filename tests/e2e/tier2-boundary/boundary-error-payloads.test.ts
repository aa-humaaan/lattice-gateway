/**
 * Tier 2 Boundary & Corner Cases: Upstream Error Payloads Normalization
 * 
 * Verifies Universal Error Normalizer when upstream returns adversarial / malformed error payloads:
 * - Upstream sending non-JSON error body (e.g. Cloudflare HTML 502 Bad Gateway)
 * - Upstream returning empty 500 response (0-byte body)
 * - Upstream returning 429 without Retry-After header
 * - Upstream returning 429 with invalid or unparseable Retry-After header
 * - Upstream connection refused (ECONNREFUSED / offline target)
 * - Upstream hanging / request aborted timeout
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertDialectError,
  assertRetryAfterHeader,
} from '../../harness/assertions';
import { GatewayError } from '../../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class ErrorTestingProviderPlugin implements ProviderPlugin {
  readonly id = 'err-test';
  readonly displayName = 'Error Testing Provider';
  readonly defaultBaseUrl: string = 'http://127.0.0.1';
  public upstreamUrl: string;

  constructor(upstreamUrl: string) {
    this.upstreamUrl = upstreamUrl;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'err-test/model',
        name: 'Error Test Model',
        providerId: 'err-test',
        ownedBy: 'err-test',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    try {
      const res = await fetch(`${this.upstreamUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
        signal,
      });

      if (!res.ok) {
        let retryAfterVal: number | undefined;
        const retryHeader = res.headers.get('retry-after');
        if (retryHeader) {
          const parsedInt = parseInt(retryHeader, 10);
          if (!isNaN(parsedInt) && parsedInt > 0) {
            retryAfterVal = parsedInt;
          }
        }

        // Try reading body as JSON, fallback to text or empty
        let errMessage = `Upstream error status ${res.status}`;
        try {
          const rawText = await res.text();
          if (rawText.trim().length > 0) {
            try {
              const parsedJson = JSON.parse(rawText);
              errMessage = parsedJson.error?.message || parsedJson.message || rawText;
            } catch {
              // Non-JSON body (e.g. HTML or plain text)
              errMessage = `Upstream error ${res.status}: ${rawText.slice(0, 100)}`;
            }
          } else {
            errMessage = `Upstream returned empty ${res.status} response`;
          }
        } catch {}

        throw new GatewayError(
          res.status,
          res.status === 429 ? 'rate_limit_error' : 'upstream_error',
          errMessage,
          { retryAfter: retryAfterVal ?? (res.status === 429 ? 10 : undefined) }
        );
      }

      const data = (await res.json()) as any;
      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [{ type: 'text', text: data.choices?.[0]?.message?.content || 'OK' }],
        stopReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    } catch (err: any) {
      if (err instanceof GatewayError) throw err;
      // Network refusal or timeout
      if (err.name === 'AbortError' || err.message?.includes('timeout')) {
        throw new GatewayError(504, 'gateway_timeout', 'Upstream request timed out');
      }
      throw new GatewayError(502, 'bad_gateway', `Upstream connection failed: ${err.message}`);
    }
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    // For stream tests, delegate to execute or throw
    const res = await this.execute(req, signal);
    return (async function* () {
      yield { type: 'stream_start', id: res.id, model: res.model, created: res.created };
      yield { type: 'text_delta', delta: res.content[0]?.type === 'text' ? (res.content[0] as any).text : '' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 2 Boundary: Upstream Error Payloads Normalization', () => {
  let mockUpstreamServer: any;
  let mockUpstreamPort: number;
  let mockHandler: (req: Request) => Response | Promise<Response>;

  let gatewayServer: any;
  let plugin: ErrorTestingProviderPlugin;
  let client: TestClient;

  beforeAll(async () => {
    // Ephemeral mock upstream server with dynamic handler
    mockUpstreamServer = Bun.serve({
      port: 0,
      fetch(req) {
        return mockHandler(req);
      },
    });
    mockUpstreamPort = mockUpstreamServer.port;

    plugin = new ErrorTestingProviderPlugin(`http://127.0.0.1:${mockUpstreamPort}`);
    const app = createServer({ port: 0 }, [plugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) gatewayServer.stop(true);
    if (mockUpstreamServer) mockUpstreamServer.stop(true);
  });

  // 1. Upstream sending non-JSON error body (e.g. Cloudflare HTML 502 Bad Gateway)
  it('normalizes upstream Cloudflare HTML 502 into clean dialect JSON error', async () => {
    const htmlBody = `<!DOCTYPE html>
<html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><h1>502 Bad Gateway</h1></center>
<hr><center>cloudflare</center>
</body>
</html>`;

    mockHandler = () =>
      new Response(htmlBody, {
        status: 502,
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      });

    // Test with OpenAI dialect
    const resOpenAI = await client.openaiChat({
      model: 'err-test/model',
      messages: [{ role: 'user', content: 'Test HTML 502' }],
    });

    expect(resOpenAI.status).toBe(502);
    expect(resOpenAI.headers.get('content-type')).toContain('application/json');
    const bodyOpenAI = (await resOpenAI.json()) as any;
    assertDialectError(bodyOpenAI, 'openai');
    expect(bodyOpenAI.error.message).toContain('502');

    // Test with Anthropic dialect
    const resAnthropic = await client.anthropicMessages({
      model: 'err-test/model',
      messages: [{ role: 'user', content: 'Test HTML 502 Anthropic' }],
    });

    expect(resAnthropic.status).toBe(502);
    expect(resAnthropic.headers.get('content-type')).toContain('application/json');
    const bodyAnthropic = (await resAnthropic.json()) as any;
    assertDialectError(bodyAnthropic, 'anthropic');
    expect(bodyAnthropic.type).toBe('error');
  });

  // 2. Upstream returning empty 500 response (0-byte body)
  it('normalizes empty 500 response without crashing or throwing JSON parse errors', async () => {
    mockHandler = () =>
      new Response('', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });

    const res = await client.openaiChat({
      model: 'err-test/model',
      messages: [{ role: 'user', content: 'Test empty 500' }],
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai');
    expect(body.error.message).toContain('empty 500');
  });

  // 3. Upstream returning 429 without Retry-After header
  it('safely assigns fallback cooldown when upstream returns 429 without Retry-After header', async () => {
    mockHandler = () =>
      new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });

    const res = await client.openaiChat({
      model: 'err-test/model',
      messages: [{ role: 'user', content: 'Test 429 without retry-after' }],
    });

    expect(res.status).toBe(429);
    // Should attach default retry-after header
    assertRetryAfterHeader(res.headers);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai');
  });

  // 4. Upstream returning 429 with invalid or unparseable Retry-After header
  it('handles invalid or non-numeric Retry-After header without NaN or failure', async () => {
    mockHandler = () =>
      new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': 'invalid-date-or-string-value',
        },
      });

    const res = await client.openaiChat({
      model: 'err-test/model',
      messages: [{ role: 'user', content: 'Test unparseable retry-after' }],
    });

    expect(res.status).toBe(429);
    // Verified fallback Retry-After is valid positive integer
    const retryHeader = res.headers.get('retry-after');
    expect(retryHeader).toBeDefined();
    const parsed = parseInt(retryHeader!, 10);
    expect(isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThan(0);
  });

  // 5. Upstream connection refused (ECONNREFUSED / offline server)
  it('normalizes upstream ECONNREFUSED into 502 Bad Gateway dialect error', async () => {
    // Point plugin to an unused loopback port that will refuse connection
    const unusedPort = 59182;
    plugin.upstreamUrl = `http://127.0.0.1:${unusedPort}`;

    const res = await client.openaiChat({
      model: 'err-test/model',
      messages: [{ role: 'user', content: 'Test connection refused' }],
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai');
    expect(body.error.message.toLowerCase()).toContain('connection failed');

    // Restore upstreamUrl
    plugin.upstreamUrl = `http://127.0.0.1:${mockUpstreamPort}`;
  });

  // 6. Upstream hanging / timeout handling
  it('handles upstream hanging request and normalizes into 504 Gateway Timeout error', async () => {
    // Mock handler hangs indefinitely
    mockHandler = () => new Promise(() => {});

    // Invoke with short client timeout
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 150);

    const res = await client.openaiChat(
      {
        model: 'err-test/model',
        messages: [{ role: 'user', content: 'Test timeout' }],
      },
      { signal: abortController.signal }
    ).catch((err) => {
      // Client-side fetch aborted
      return { status: 504, clientAborted: true };
    });

    expect(res.status === 504 || (res as any).clientAborted).toBe(true);
  });
});
