/**
 * Feature F10: Plugin - OpenCode Zen Upstream & Gate Tools
 * 
 * Verifies:
 * - Bun BoringSSL uTLS ClientHello mimicry configuration
 * - Gate tools injection schema (`zen_gate_tools.json` / `/api/gate/tools`)
 * - Keyless anonymous session minting (session-id & parent-session-id)
 * - OpenCode `/inference` and `/api/zen/completions` endpoint routing
 * - Upstream 403 error detection and automatic session reset
 * - Model catalog discovery for OpenCode free models
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertModelPresent,
} from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

export interface ZenGateTool {
  name: string;
  description: string;
}

class StubOpenCodeProviderPlugin implements ProviderPlugin {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode Zen Provider';
  readonly defaultBaseUrl: string;
  public cachedGateTools: ZenGateTool[] = [];
  public currentSessionId?: string;
  public currentParentSessionId?: string;
  public sessionResetCount = 0;

  constructor(upstreamBaseUrl: string) {
    this.defaultBaseUrl = upstreamBaseUrl;
  }

  async fetchGateTools(): Promise<ZenGateTool[]> {
    const res = await fetch(`${this.defaultBaseUrl}/api/gate/tools`, {
      method: 'GET',
      headers: { 'Connection': 'close' },
    });
    if (!res.ok) throw new Error(`Failed to load gate tools: ${res.statusText}`);
    const data = (await res.json()) as any;
    this.cachedGateTools = data.tools || [];
    return this.cachedGateTools;
  }

  mintSession(): { sessionId: string; parentSessionId: string } {
    this.currentSessionId = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.currentParentSessionId = `psess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return {
      sessionId: this.currentSessionId,
      parentSessionId: this.currentParentSessionId,
    };
  }

  resetSession(): void {
    this.currentSessionId = undefined;
    this.currentParentSessionId = undefined;
    this.sessionResetCount++;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'opencode/big-pickle',
        name: 'OpenCode Big Pickle (Free)',
        providerId: 'opencode',
        ownedBy: 'opencode',
        created: 1731693600,
        isFree: true,
      },
      {
        id: 'opencode/minimax-m3.1-flash-free',
        name: 'MiniMax M3.1 Flash Free',
        providerId: 'opencode',
        ownedBy: 'opencode',
        created: 1731693600,
        isFree: true,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    if (!this.currentSessionId) {
      this.mintSession();
    }

    if (this.cachedGateTools.length === 0) {
      await this.fetchGateTools();
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Bun/1.4.2',
      'X-uTLS-Fingerprint': 't13d1713h1',
      'x-opencode-session-id': this.currentSessionId!,
      'x-opencode-parent-session-id': this.currentParentSessionId!,
      'Connection': 'close',
    };

    const res = await fetch(`${this.defaultBaseUrl}/api/zen/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model.replace(/^opencode\//, ''),
        messages: req.messages,
        gate_tools: this.cachedGateTools,
        stream: false,
      }),
      signal,
    });

    if (res.status === 403) {
      this.resetSession();
      throw new GatewayError(403, '403', 'OpenCode workspace access denied: session cleared');
    }

    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `OpenCode upstream error: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: data.text || 'Zen completion response' }],
      stopReason: data.finish_reason || 'stop',
      usage: { promptTokens: 12, completionTokens: 18, totalTokens: 30 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'text_delta', delta: 'Zen completion streamed response' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Feature F10: Plugin OpenCode Zen Upstream & Gate Tools', () => {
  let mockServer: MockUpstreamServer;
  let opencodePlugin: StubOpenCodeProviderPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();
    opencodePlugin = new StubOpenCodeProviderPlugin(mockServer.url);

    const app = createServer({ port: 0 }, [opencodePlugin]);
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
    opencodePlugin.cachedGateTools = [];
    opencodePlugin.resetSession();
  });

  // Test 1: Bun BoringSSL uTLS ClientHello mimicry configuration
  it('configures Bun BoringSSL uTLS ClientHello fingerprint and headers', async () => {
    await client.openaiChat({
      model: 'opencode/big-pickle',
      messages: [{ role: 'user', content: 'Test uTLS headers' }],
    });

    const requests = mockServer.getRequests();
    const zenReq = requests.find((r) => r.path === '/api/zen/completions');
    expect(zenReq).toBeDefined();
    expect(zenReq!.headers['user-agent']).toBe('Bun/1.4.2');
    expect(zenReq!.headers['x-utls-fingerprint']).toBe('t13d1713h1');
  });

  // Test 2: Gate tools injection schema
  it('fetches and injects gate tools schema into requests', async () => {
    await client.openaiChat({
      model: 'opencode/big-pickle',
      messages: [{ role: 'user', content: 'Test gate tools' }],
    });

    const requests = mockServer.getRequests();
    const gateToolsReq = requests.find((r) => r.path === '/api/gate/tools');
    expect(gateToolsReq).toBeDefined();

    const zenReq = requests.find((r) => r.path === '/api/zen/completions');
    expect(zenReq).toBeDefined();
    expect(Array.isArray(zenReq!.body.gate_tools)).toBeTrue();
    expect(zenReq!.body.gate_tools.some((t: any) => t.name === 'execute_command')).toBeTrue();
  });

  // Test 3: Keyless anonymous session minting
  it('mints unique anonymous session IDs (x-opencode-session-id, x-opencode-parent-session-id)', async () => {
    const { sessionId, parentSessionId } = opencodePlugin.mintSession();
    expect(sessionId.startsWith('sess_')).toBeTrue();
    expect(parentSessionId.startsWith('psess_')).toBeTrue();

    await client.openaiChat({
      model: 'opencode/big-pickle',
      messages: [{ role: 'user', content: 'Session check' }],
    });

    const requests = mockServer.getRequests();
    const zenReq = requests.find((r) => r.path === '/api/zen/completions');
    expect(zenReq).toBeDefined();
    expect(zenReq!.headers['x-opencode-session-id']).toBe(sessionId);
    expect(zenReq!.headers['x-opencode-parent-session-id']).toBe(parentSessionId);
  });

  // Test 4: OpenCode /inference and zen completions routing
  it('routes requests to OpenCode Zen completions endpoint and formats response', async () => {
    const res = await client.openaiChat({
      model: 'opencode/big-pickle',
      messages: [{ role: 'user', content: 'Inference test' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Zen completion response');
  });

  // Test 5: Error detection and session reset on upstream 403 rejection
  it('detects upstream 403 rejection and resets cached anonymous session', async () => {
    const oldSessionId = opencodePlugin.currentSessionId;

    // Pre-seed gate tools so the 403 error specifically targets the inference endpoint
    opencodePlugin.cachedGateTools = [{ name: 'execute_command', description: 'Run bash' }];

    // Simulate 403 Forbidden
    mockServer.simulateError({
      status: 403,
      message: 'Workspace access denied',
      dialect: 'openai',
      count: 1,
    });

    const res = await client.openaiChat({
      model: 'opencode/big-pickle',
      messages: [{ role: 'user', content: 'Forbidden turn' }],
    });

    expect(res.status).toBe(403);
    expect(opencodePlugin.sessionResetCount).toBeGreaterThan(0);
    expect(opencodePlugin.currentSessionId).toBeUndefined();

    // Next request automatically mints a new session ID
    mockServer.reset();
    await client.openaiChat({
      model: 'opencode/big-pickle',
      messages: [{ role: 'user', content: 'Recovered turn' }],
    });

    expect(opencodePlugin.currentSessionId).toBeDefined();
    expect(opencodePlugin.currentSessionId).not.toBe(oldSessionId);
  });

  // Test 6: Model catalog discovery
  it('exposes OpenCode free models in aggregated catalog', async () => {
    const res = await client.getModels();
    expect(res.status).toBe(200);
    const catalog = await res.json();
    assertModelPresent(catalog, 'opencode/big-pickle');
    assertModelPresent(catalog, 'opencode/minimax-m3.1-flash-free');
  });
});
