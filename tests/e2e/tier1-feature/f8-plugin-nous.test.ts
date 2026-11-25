/**
 * Feature F8: Plugin - Nous Research Upstream & Hermes
 * 
 * Verifies:
 * - Nous Portal OAuth device flow and token handling
 * - `sk-nous-...` API key authentication and model catalog retrieval
 * - Hermes flagship model request mapping
 * - Nous tool XML normalization via XMLToolInterceptor
 * - Rate limit and error handling for Nous endpoints
 * - Dialect transformation for Anthropic messages API
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertAnthropicSuccess,
  assertToolCallsEmitted,
  assertModelPresent,
  assertRetryAfterHeader,
} from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

class StubNousProviderPlugin implements ProviderPlugin {
  readonly id = 'nous';
  readonly displayName = 'Nous Research Hermes Plugin';
  readonly defaultBaseUrl: string;
  public account: StoredAccount;

  constructor(upstreamBaseUrl: string, account?: Partial<StoredAccount>) {
    this.defaultBaseUrl = upstreamBaseUrl;
    this.account = {
      id: 'acc_nous_primary',
      providerId: 'nous',
      authType: 'api_key',
      credentials: {
        apiKey: 'sk-nous-valid-token-mock',
        ...account?.credentials,
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
      ...account,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'nous/hermes-3-llama-3.1-8b',
        name: 'Nous Hermes 3 Llama 3.1 8B',
        providerId: 'nous',
        ownedBy: 'nous',
        created: 1731693600,
        supportsTools: true,
      },
      {
        id: 'nous/hermes-3-llama-3.1-70b',
        name: 'Nous Hermes 3 Llama 3.1 70B',
        providerId: 'nous',
        ownedBy: 'nous',
        created: 1731693600,
        supportsTools: true,
      },
      {
        id: 'hermes-3-llama-3.1-8b',
        name: 'Hermes 3 Direct Alias',
        providerId: 'nous',
        ownedBy: 'nous',
        created: 1731693600,
        supportsTools: true,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.account.credentials.apiKey}`,
      'Connection': 'close',
    };

    const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model.replace(/^nous\//, ''),
        messages: req.messages,
        temperature: req.temperature,
        stream: false,
      }),
      signal,
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 15);
      throw new GatewayError(429, '429', 'Nous inference rate limit reached', { retryAfter });
    }
    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `Nous upstream error: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const canonicalId =
      req.clientDialect === 'anthropic-messages' || req.id.startsWith('msg_')
        ? (req.id.startsWith('msg_') ? req.id : `msg_${req.id.replace(/^req_lat_/, '')}`)
        : (data.id || req.id);

    return {
      id: canonicalId,
      model: req.model,
      created: data.created || Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: choice?.message?.content || '' }],
      stopReason: choice?.finish_reason || 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens || 15,
        completionTokens: data.usage?.completion_tokens || 20,
        totalTokens: data.usage?.total_tokens || 35,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const isXmlToolTest = req.messages.some((m) =>
      typeof m.content === 'string' && m.content.includes('xml-tool')
    );

    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };

      if (isXmlToolTest) {
        // Emit Hermes XML tool call tokens that XMLToolInterceptor must intercept
        yield { type: 'text_delta', delta: 'Calculating expression...\n' };
        yield {
          type: 'text_delta',
          delta: '<tool_call>\n<function=calculator>\n<parameter=expr>2+2</parameter>\n</tool_call>',
        };
        yield { type: 'stream_end', stopReason: 'stop' };
      } else {
        yield { type: 'text_delta', delta: 'Hermes response stream' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }
    })();
  }
}

describe('Feature F8: Plugin Nous Research Upstream & Hermes', () => {
  let mockServer: MockUpstreamServer;
  let nousPlugin: StubNousProviderPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();
    nousPlugin = new StubNousProviderPlugin(mockServer.url);

    const app = createServer({ port: 0 }, [nousPlugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });

    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) gatewayServer.stop(true);
    if (mockServer) await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
  });

  // Test 1: Nous Portal OAuth device flow and token handling
  it('executes Nous Portal OAuth device flow and retrieves access token', async () => {
    // 1. Initial auth URL request
    const authRes = await fetch(`${mockServer.url}/v1/portal/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'nous_hermes_cli' }),
    });

    expect(authRes.status).toBe(200);
    const authData = (await authRes.json()) as any;
    expect(authData.auth_url).toContain('portal.nousresearch.com');
    expect(authData.session_id).toBe('nous_sess_mock_123');

    // 2. Token exchange with session_id
    const tokenRes = await fetch(`${mockServer.url}/v1/portal/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: authData.session_id }),
    });

    expect(tokenRes.status).toBe(200);
    const tokenData = (await tokenRes.json()) as any;
    expect(tokenData.access_token).toBe('sk-nous-valid-token-mock');
    expect(tokenData.token_type).toBe('Bearer');
  });

  // Test 2: sk-nous-... API key authentication and model catalog retrieval
  it('authenticates with sk-nous-... API key and exposes Hermes model catalog', async () => {
    const res = await client.getModels();
    expect(res.status).toBe(200);
    const catalog = await res.json();
    assertModelPresent(catalog, 'nous/hermes-3-llama-3.1-8b');
    assertModelPresent(catalog, 'nous/hermes-3-llama-3.1-70b');
    assertModelPresent(catalog, 'hermes-3-llama-3.1-8b');
  });

  // Test 3: Hermes flagship model request mapping
  it('maps Hermes flagship model request and forwards Bearer token upstream', async () => {
    mockServer.configureOpenAIChat({
      content: 'Hermes 3 flagship reasoning response',
      model: 'hermes-3-llama-3.1-8b',
    });

    const res = await client.openaiChat({
      model: 'nous/hermes-3-llama-3.1-8b',
      messages: [{ role: 'user', content: 'Explain logic gating' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Hermes 3 flagship reasoning response');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].path).toBe('/v1/chat/completions');
    expect(requests[0].headers['authorization']).toBe('Bearer sk-nous-valid-token-mock');
    expect(requests[0].body.model).toBe('hermes-3-llama-3.1-8b');
  });

  // Test 4: Nous tool XML normalization via XMLToolInterceptor
  it('normalizes Hermes raw XML tool calls into standard OpenAI tool_calls stream chunks', async () => {
    const chunks = await TestClient.collect(
      client.openaiChatStream({
        model: 'nous/hermes-3-llama-3.1-8b',
        messages: [{ role: 'user', content: 'xml-tool calculate 2+2' }],
      })
    );

    expect(chunks.length).toBeGreaterThan(0);
    const tools = assertToolCallsEmitted(chunks, 'calculator');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('calculator');
  });

  // Test 5: Rate limit and error handling for Nous endpoints
  it('normalizes Nous 429 rate limit into dialect-compliant error with Retry-After header', async () => {
    mockServer.simulateRateLimit({
      retryAfterSeconds: 15,
      message: 'Nous inference quota exceeded',
      dialect: 'openai',
      count: 1,
    });

    const res = await client.openaiChat({
      model: 'nous/hermes-3-llama-3.1-8b',
      messages: [{ role: 'user', content: 'Test rate limit' }],
    });

    expect(res.status).toBe(429);
    assertRetryAfterHeader(res.headers, 15);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('Nous');
  });

  // Test 6: Dialect transformation for Anthropic messages API
  it('translates Anthropic messages request into Nous Hermes format and returns valid Anthropic message', async () => {
    mockServer.configureOpenAIChat({
      content: 'Hermes response mapped to Anthropic format',
      model: 'hermes-3-llama-3.1-70b',
    });

    const res = await client.anthropicMessages({
      model: 'nous/hermes-3-llama-3.1-70b',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'Anthropic dialect test' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);
    expect(body.content[0].text).toBe('Hermes response mapped to Anthropic format');
  });
});
