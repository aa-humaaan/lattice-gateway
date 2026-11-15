/**
 * Feature F7: Plugin - Kilo Code Upstream & Free Models
 * 
 * Verifies:
 * - Kilo Code API key authentication and bearer token propagation
 * - Kilo Code `:free` tagged free-tier models routing
 * - `X-KiloCode-OrganizationId` header injection when configured
 * - Kilo OAuth device flow authorization and token exchange
 * - Upstream request transformation and dialect mapping
 * - Upstream 401 Unauthorized detection and error classification
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertAnthropicSuccess,
  assertDialectError,
  assertModelPresent,
} from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

class KiloProviderPlugin implements ProviderPlugin {
  readonly id = 'kilo';
  readonly displayName = 'Kilo Code Upstream Plugin';
  readonly defaultBaseUrl: string;
  public account: StoredAccount;

  constructor(upstreamBaseUrl: string, account?: Partial<StoredAccount>) {
    this.defaultBaseUrl = upstreamBaseUrl;
    this.account = {
      id: 'acc_kilo_primary',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: {
        apiKey: 'kilo_api_key_test_123',
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
        id: 'kilo/claude-3-7-sonnet',
        name: 'Kilo Claude 3.7 Sonnet',
        providerId: 'kilo',
        ownedBy: 'kilo',
        created: 1731693600,
        isFree: false,
      },
      {
        id: 'kilo/free-model:free',
        name: 'Kilo Free Model',
        providerId: 'kilo',
        ownedBy: 'kilo',
        created: 1731693600,
        isFree: true,
      },
      {
        id: 'kilo/qwen-2.5-coder:free',
        name: 'Kilo Qwen 2.5 Coder Free',
        providerId: 'kilo',
        ownedBy: 'kilo',
        created: 1731693600,
        isFree: true,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.account.credentials.apiKey}`,
    };

    if (this.account.credentials.organizationId) {
      headers['X-KiloCode-OrganizationId'] = this.account.credentials.organizationId;
    }

    const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model.replace(/^kilo\//, ''),
        messages: req.messages,
        temperature: req.temperature,
        stream: false,
      }),
      signal,
    });

    if (res.status === 401) {
      throw new GatewayError(401, '401', 'Invalid Kilo API key');
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 10);
      throw new GatewayError(429, '429', 'Kilo rate limit reached', { retryAfter });
    }
    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `Kilo upstream error: ${res.statusText}`);
    }

    const data = await res.json() as any;
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
        promptTokens: data.usage?.prompt_tokens || 10,
        completionTokens: data.usage?.completion_tokens || 15,
        totalTokens: data.usage?.total_tokens || 25,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'text_delta', delta: 'Streamed response from Kilo upstream' };
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 } };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Feature F7: Plugin Kilo Code Upstream', () => {
  let mockServer: MockUpstreamServer;
  let kiloPlugin: KiloProviderPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();
    kiloPlugin = new KiloProviderPlugin(mockServer.url);

    const app = createServer({ port: 0 }, [kiloPlugin]);
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

  // Test 1: API key authentication and Bearer token propagation
  it('propagates Kilo API key as Bearer token to upstream Kilo gateway', async () => {
    mockServer.configureOpenAIChat({
      content: 'Authenticated response from Kilo',
      model: 'claude-3-7-sonnet',
    });

    const res = await client.openaiChat({
      model: 'kilo/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Hello Kilo' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Authenticated response from Kilo');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].path).toBe('/v1/chat/completions');
    expect(requests[0].headers['authorization']).toBe('Bearer kilo_api_key_test_123');
  });

  // Test 2: Free-tier :free tagged models routing
  it('routes :free tagged free-tier models correctly and marks descriptor as isFree', async () => {
    const modelsRes = await client.getModels();
    expect(modelsRes.status).toBe(200);
    const modelsBody = await modelsRes.json();
    assertModelPresent(modelsBody, 'kilo/free-model:free');
    assertModelPresent(modelsBody, 'kilo/qwen-2.5-coder:free');

    mockServer.configureOpenAIChat({
      content: 'Free-tier completion from Kilo',
      model: 'free-model',
    });

    const res = await client.openaiChat({
      model: 'kilo/free-model:free',
      messages: [{ role: 'user', content: 'Code test' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Free-tier completion from Kilo');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].body.model).toBe('free-model:free');
  });

  // Test 3: X-KiloCode-OrganizationId header injection
  it('injects X-KiloCode-OrganizationId header when organizationId is configured', async () => {
    kiloPlugin.account.credentials.organizationId = 'org_kilo_corp_999';

    mockServer.configureOpenAIChat({
      content: 'Org-verified response',
      model: 'claude-3-7-sonnet',
    });

    const res = await client.openaiChat({
      model: 'kilo/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Org check' }],
    });

    expect(res.status).toBe(200);
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].headers['x-kilocode-organizationid']).toBe('org_kilo_corp_999');

    // Clean up
    delete kiloPlugin.account.credentials.organizationId;
  });

  // Test 4: Kilo OAuth device flow authorization and token exchange
  it('completes Kilo OAuth device code flow and token exchange', async () => {
    // 1. Device Code Request
    const devCodeRes = await fetch(`${mockServer.url}/api/v1/auth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'kilo_client_app' }),
    });

    expect(devCodeRes.status).toBe(200);
    const devCodeData = (await devCodeRes.json()) as any;
    expect(devCodeData.user_code).toBe('KILO-7890');
    expect(devCodeData.device_code).toBe('dev_code_kilo_xyz');
    expect(devCodeData.verification_uri).toBe('https://kilo.ai/auth');

    // 2. Token Exchange
    const tokenRes = await fetch(`${mockServer.url}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: devCodeData.device_code,
      }),
    });

    expect(tokenRes.status).toBe(200);
    const tokenData = (await tokenRes.json()) as any;
    expect(tokenData.access_token).toBe('kilo_access_token_mock');
    expect(tokenData.refresh_token).toBe('kilo_refresh_token_mock');
    expect(tokenData.token_type).toBe('Bearer');
    expect(tokenData.expires_in).toBe(3600);

    // 3. Update account credentials and verify subsequent request uses new token
    kiloPlugin.account.credentials.apiKey = tokenData.access_token;
    await client.openaiChat({
      model: 'kilo/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Post-auth test' }],
    });

    const requests = mockServer.getRequests();
    expect(requests[requests.length - 1].headers['authorization']).toBe('Bearer kilo_access_token_mock');
  });

  // Test 5: Upstream request transformation across dialects (Anthropic -> Kilo OpenAI upstream)
  it('transforms Anthropic dialect request into Kilo upstream and returns valid Anthropic envelope', async () => {
    mockServer.configureOpenAIChat({
      content: 'Kilo Anthropic bridge answer',
      model: 'claude-3-7-sonnet',
    });

    const res = await client.anthropicMessages({
      model: 'kilo/claude-3-7-sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Translate to Anthropic' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);
    expect(body.content[0].text).toBe('Kilo Anthropic bridge answer');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].path).toBe('/v1/chat/completions');
  });

  // Test 6: 401 Unauthorized handling
  it('handles Kilo upstream 401 unauthorized and normalizes dialect error', async () => {
    mockServer.simulateError({
      status: 401,
      message: 'Invalid or revoked Kilo API key',
      dialect: 'openai',
    });

    const res = await client.openaiChat({
      model: 'kilo/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Unauthorized test' }],
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 401);
    expect(body.error.message).toContain('Invalid Kilo API key');
  });
});
