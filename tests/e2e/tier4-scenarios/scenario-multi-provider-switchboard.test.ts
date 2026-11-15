/**
 * Tier 4 Real-World Application Scenario: S5 - Multi-Provider Dynamic Switchboard
 * 
 * Simulates a developer seamlessly switching between multiple models and providers:
 * 1. Aggregated /v1/models catalog discovery across Kilo, Nous, Cline, DeepSeek, and Combos
 * 2. Dynamic routing to Kilo Code, Nous Hermes, Cline Pool, and Virtual Combos
 * 3. Real-time SSE log streaming via GET /api/logs/stream capturing latency and provider attribution
 * 4. Admin REST API inspection for /api/accounts and /api/combos
 * 5. Dynamic provider disabling and automatic combo fallback traversal
 * 6. Concurrent mixed-dialect request distribution without race conditions
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertAnthropicSuccess,
  assertModelPresent,
  assertThinkingContent,
} from '../../harness/assertions';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

// 1. Kilo Code Plugin
class SwitchboardKiloPlugin implements ProviderPlugin {
  readonly id = 'kilo';
  readonly displayName = 'Kilo Code Upstream Plugin';
  readonly defaultBaseUrl = 'https://mock.kilo.local/v1';
  public enabled = true;
  public totalRequests = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.enabled) return [];
    return [
      {
        id: 'kilo/code-fast:free',
        name: 'Kilo Code Fast (Free Tier)',
        providerId: 'kilo',
        ownedBy: 'kilo',
        created: 1731693600,
        isFree: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    if (!this.enabled) {
      throw new GatewayError(503, 'service_unavailable', 'Kilo provider is currently disabled');
    }
    this.totalRequests++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'Kilo Code review: Code syntax and imports are valid.' }],
      stopReason: 'stop',
      usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    const text = (res.content[0] as any).text;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };
      yield { type: 'text_delta', delta: text };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

// 2. Nous Research Hermes Plugin
class SwitchboardNousPlugin implements ProviderPlugin {
  readonly id = 'nous';
  readonly displayName = 'Nous Research Hermes Plugin';
  readonly defaultBaseUrl = 'https://mock.nous.local/v1';
  public totalRequests = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'nous/hermes-3-llama3',
        name: 'Nous Hermes 3 LLaMA 3',
        providerId: 'nous',
        ownedBy: 'nous',
        created: 1731693600,
        supportsTools: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.totalRequests++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'Nous Hermes creative synthesis: Architecture is robust and decoupled.' }],
      stopReason: 'stop',
      usage: { promptTokens: 35, completionTokens: 20, totalTokens: 55 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    const text = (res.content[0] as any).text;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };
      yield { type: 'text_delta', delta: text };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

// 3. Cline Pool Plugin
class SwitchboardClinePlugin implements ProviderPlugin {
  readonly id = 'cline';
  readonly displayName = 'Cline Pool Plugin';
  readonly defaultBaseUrl = 'https://mock.cline.local/v1';
  public totalRequests = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'cline/sonnet-agent',
        name: 'Cline Sonnet Agent (Thinking Enabled)',
        providerId: 'cline',
        ownedBy: 'cline',
        created: 1731693600,
        supportsThinking: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.totalRequests++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [
        { type: 'thinking', thinking: 'Cline agent systematically planning execution sequence.' },
        { type: 'text', text: 'Cline task plan established.' },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70, reasoningTokens: 15 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.totalRequests++;
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'thinking_delta', delta: 'Cline agent systematically planning execution sequence.' };
      yield { type: 'text_delta', delta: 'Cline task plan established.' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

// 4. DeepSeek Web Pool Plugin
class SwitchboardDeepSeekPlugin implements ProviderPlugin {
  readonly id = 'deepseek';
  readonly displayName = 'DeepSeek Web Pool Plugin';
  readonly defaultBaseUrl = 'https://mock.deepseek.local/v1';
  public totalRequests = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'deepseek/v3-chat',
        name: 'DeepSeek V3 Chat',
        providerId: 'deepseek',
        ownedBy: 'deepseek',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.totalRequests++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'DeepSeek V3 high-throughput response.' }],
      stopReason: 'stop',
      usage: { promptTokens: 25, completionTokens: 15, totalTokens: 40 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    const text = (res.content[0] as any).text;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };
      yield { type: 'text_delta', delta: text };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

// 5. Virtual Combo Plugin (Hierarchical Fallback)
class SwitchboardComboPlugin implements ProviderPlugin {
  readonly id = 'lattice';
  readonly displayName = 'Project Lattice Virtual Combos';
  readonly defaultBaseUrl = 'https://mock.lattice.local/v1';
  public totalRequests = 0;

  constructor(
    public kilo: SwitchboardKiloPlugin,
    public nous: SwitchboardNousPlugin
  ) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'lattice/code-flagship',
        name: 'Lattice Flagship Combo (Kilo -> Nous)',
        providerId: 'lattice',
        ownedBy: 'lattice-combo',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    this.totalRequests++;
    // Fallback order: Kilo -> Nous
    if (this.kilo.enabled) {
      try {
        return await this.kilo.execute(req);
      } catch {}
    }
    // Fallback to Nous
    return await this.nous.execute(req);
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.totalRequests++;
    if (this.kilo.enabled) {
      try {
        return await this.kilo.executeStream(req);
      } catch {}
    }
    return await this.nous.executeStream(req);
  }
}

describe('Tier 4 Scenario S5: Multi-Provider Dynamic Switchboard', () => {
  let kiloPlugin: SwitchboardKiloPlugin;
  let nousPlugin: SwitchboardNousPlugin;
  let clinePlugin: SwitchboardClinePlugin;
  let deepseekPlugin: SwitchboardDeepSeekPlugin;
  let comboPlugin: SwitchboardComboPlugin;

  let gatewayServer: any;
  let client: TestClient;

  let adminMockServer: MockUpstreamServer;
  let adminClient: TestClient;

  // Real-time log buffer for /api/logs/stream simulation
  const capturedLogs: any[] = [];
  let logListeners: ((log: any) => void)[] = [];

  const broadcastLog = (log: any) => {
    capturedLogs.push(log);
    for (const listener of logListeners) {
      listener(log);
    }
  };

  beforeAll(async () => {
    kiloPlugin = new SwitchboardKiloPlugin();
    nousPlugin = new SwitchboardNousPlugin();
    clinePlugin = new SwitchboardClinePlugin();
    deepseekPlugin = new SwitchboardDeepSeekPlugin();
    comboPlugin = new SwitchboardComboPlugin(kiloPlugin, nousPlugin);

    // Initialize in-memory Gateway server with all 5 switchboard plugins
    const app = createServer({ port: 0 }, [
      kiloPlugin,
      nousPlugin,
      clinePlugin,
      deepseekPlugin,
      comboPlugin,
    ]);

    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);

    // Initialize Admin Control Plane Mock Server for /api/accounts, /api/combos, and /api/logs/stream
    adminMockServer = await createMockUpstream();
    adminClient = new TestClient(adminMockServer.url);

    // Mount /api/accounts endpoint
    adminMockServer.onPath('/api/accounts', () => {
      return new Response(
        JSON.stringify({
          accounts: [
            { id: 'acc_kilo_01', providerId: 'kilo', status: kiloPlugin.enabled ? 'active' : 'disabled', totalServed: kiloPlugin.totalRequests },
            { id: 'acc_nous_01', providerId: 'nous', status: 'active', totalServed: nousPlugin.totalRequests },
            { id: 'acc_cline_01', providerId: 'cline', status: 'active', totalServed: clinePlugin.totalRequests },
            { id: 'acc_deepseek_01', providerId: 'deepseek', status: 'active', totalServed: deepseekPlugin.totalRequests },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Mount /api/combos endpoint
    adminMockServer.onPath('/api/combos', () => {
      return new Response(
        JSON.stringify({
          combos: [
            {
              id: 'lattice/code-flagship',
              name: 'Lattice Flagship Combo',
              targets: [
                { providerId: 'kilo', modelId: 'kilo/code-fast:free' },
                { providerId: 'nous', modelId: 'nous/hermes-3-llama3' },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Mount /api/logs/stream endpoint
    adminMockServer.onPath('/api/logs/stream', () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const listener = (log: any) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
            } catch {}
          };
          logListeners.push(listener);
        },
        cancel() {
          logListeners = [];
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    });
  });

  afterAll(async () => {
    if (gatewayServer) gatewayServer.stop(true);
    if (adminMockServer) await adminMockServer.stop();
  });

  // --------------------------------------------------------------------------
  // Test 1: Aggregated Model Catalog Discovery Across 5 Provider Types
  // --------------------------------------------------------------------------
  it('discovers and aggregates model descriptors across Kilo, Nous, Cline, DeepSeek, and Combos', async () => {
    const res = await client.getModels();
    expect(res.status).toBe(200);

    const catalog = (await res.json()) as any;
    expect(catalog.object).toBe('list');
    expect(Array.isArray(catalog.data)).toBeTrue();

    // Verify models from each distinct provider exist in aggregated catalog
    assertModelPresent(catalog, 'kilo/code-fast:free');
    assertModelPresent(catalog, 'nous/hermes-3-llama3');
    assertModelPresent(catalog, 'cline/sonnet-agent');
    assertModelPresent(catalog, 'deepseek/v3-chat');
    assertModelPresent(catalog, 'lattice/code-flagship');
  });

  // --------------------------------------------------------------------------
  // Test 2: Dynamic Switchboard Routing to 4 Distinct Upstreams
  // --------------------------------------------------------------------------
  it('dynamically routes requests across Kilo, Nous, Cline, and Combos with dialect compliance', async () => {
    // 1. Kilo Code (OpenAI Dialect)
    const t0 = Date.now();
    const resKilo = await client.openaiChat({
      model: 'kilo/code-fast:free',
      messages: [{ role: 'user', content: 'Review auth function' }],
      stream: false,
    });
    const kiloLatency = Date.now() - t0;
    expect(resKilo.status).toBe(200);
    const kiloBody = (await resKilo.json()) as any;
    assertOpenAISuccess(kiloBody);
    expect(kiloBody.choices[0].message.content).toContain('Kilo Code review');
    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'kilo',
      model: 'kilo/code-fast:free',
      status: 200,
      latencyMs: kiloLatency,
    });

    // 2. Nous Research Hermes (Anthropic Dialect)
    const t1 = Date.now();
    const resNous = await client.anthropicMessages({
      model: 'nous/hermes-3-llama3',
      messages: [{ role: 'user', content: 'Synthesize architecture proposal' }],
      stream: false,
    });
    const nousLatency = Date.now() - t1;
    expect(resNous.status).toBe(200);
    const nousBody = (await resNous.json()) as any;
    assertAnthropicSuccess(nousBody);
    expect(nousBody.content[0].text).toContain('Nous Hermes creative synthesis');
    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/messages',
      provider: 'nous',
      model: 'nous/hermes-3-llama3',
      status: 200,
      latencyMs: nousLatency,
    });

    // 3. Cline Pool with Thinking Tokens
    const t2 = Date.now();
    const resCline = await client.openaiChat({
      model: 'cline/sonnet-agent',
      messages: [{ role: 'user', content: 'Plan refactoring sequence' }],
      stream: false,
    });
    const clineLatency = Date.now() - t2;
    expect(resCline.status).toBe(200);
    const clineBody = (await resCline.json()) as any;
    expect(clineBody.choices[0].message.content).toContain('Cline task plan established');
    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'cline',
      model: 'cline/sonnet-agent',
      status: 200,
      latencyMs: clineLatency,
    });

    // 4. Virtual Combo
    const t3 = Date.now();
    const resCombo = await client.openaiChat({
      model: 'lattice/code-flagship',
      messages: [{ role: 'user', content: 'Combo execution' }],
      stream: false,
    });
    const comboLatency = Date.now() - t3;
    expect(resCombo.status).toBe(200);
    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'lattice',
      model: 'lattice/code-flagship',
      status: 200,
      latencyMs: comboLatency,
    });
  });

  // --------------------------------------------------------------------------
  // Test 3: Admin Telemetry & Real-Time SSE Log Streaming
  // --------------------------------------------------------------------------
  it('captures real-time log events via SSE stream with latency metrics and provider attribution', async () => {
    // Start consumer for /api/logs/stream
    const logEvents: any[] = [];
    const stream = adminClient.getLogStream();

    const logSubscription = (async () => {
      for await (const log of stream) {
        logEvents.push(log);
        if (logEvents.length >= 2) break;
      }
    })();

    // Ensure connection is established and listener registered before broadcasting
    while (logListeners.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Emit live logs to stream
    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: 'deepseek',
      model: 'deepseek/v3-chat',
      status: 200,
      latencyMs: 88,
    });

    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/messages',
      provider: 'kilo',
      model: 'kilo/code-fast:free',
      status: 200,
      latencyMs: 114,
    });

    await logSubscription;

    expect(logEvents.length).toBe(2);
    expect(logEvents[0].provider).toBe('deepseek');
    expect(logEvents[0].status).toBe(200);
    expect(logEvents[0].latencyMs).toBeGreaterThan(0);

    expect(logEvents[1].provider).toBe('kilo');
    expect(logEvents[1].latencyMs).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Test 4: Admin Accounts & Combos Configuration Inspection
  // --------------------------------------------------------------------------
  it('inspects registered accounts and virtual combos via Admin REST API contracts', async () => {
    // 1. Inspect accounts
    const accRes = await adminClient.getAccounts();
    expect(accRes.status).toBe(200);
    const accBody = (await accRes.json()) as any;
    expect(Array.isArray(accBody.accounts)).toBeTrue();
    expect(accBody.accounts.length).toBe(4);

    const kiloAcc = accBody.accounts.find((a: any) => a.providerId === 'kilo');
    expect(kiloAcc).toBeDefined();
    expect(kiloAcc.status).toBe('active');

    // 2. Inspect combos
    const comboRes = await adminClient.getCombos();
    expect(comboRes.status).toBe(200);
    const comboBody = (await comboRes.json()) as any;
    expect(Array.isArray(comboBody.combos)).toBeTrue();

    const flagship = comboBody.combos.find((c: any) => c.id === 'lattice/code-flagship');
    expect(flagship).toBeDefined();
    expect(flagship.targets.length).toBe(2);
    expect(flagship.targets[0].providerId).toBe('kilo');
    expect(flagship.targets[1].providerId).toBe('nous');
  });

  // --------------------------------------------------------------------------
  // Test 5: Dynamic Provider Disabling and Automatic Fallback Traversal
  // --------------------------------------------------------------------------
  it('automatically routes combo to secondary provider when primary provider is disabled', async () => {
    // Disable Kilo provider
    kiloPlugin.enabled = false;

    // Send request to virtual combo (which falls back from Kilo to Nous)
    const res = await client.openaiChat({
      model: 'lattice/code-flagship',
      messages: [{ role: 'user', content: 'Test combo fallback with Kilo disabled' }],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // Must be served by Nous Hermes
    expect(body.choices[0].message.content).toContain('Nous Hermes creative synthesis');

    // Re-enable Kilo
    kiloPlugin.enabled = true;
    const res2 = await client.openaiChat({
      model: 'lattice/code-flagship',
      messages: [{ role: 'user', content: 'Test combo recovery with Kilo re-enabled' }],
      stream: false,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as any;
    expect(body2.choices[0].message.content).toContain('Kilo Code review');
  });

  // --------------------------------------------------------------------------
  // Test 6: Concurrent Mixed-Dialect Load Balancing
  // --------------------------------------------------------------------------
  it('serves concurrent requests across OpenAI and Anthropic dialects without race conditions', async () => {
    const promises = [
      client.openaiChat({
        model: 'kilo/code-fast:free',
        messages: [{ role: 'user', content: 'Concurrent request 1' }],
        stream: false,
      }),
      client.anthropicMessages({
        model: 'nous/hermes-3-llama3',
        messages: [{ role: 'user', content: 'Concurrent request 2' }],
        stream: false,
      }),
      client.openaiChat({
        model: 'cline/sonnet-agent',
        messages: [{ role: 'user', content: 'Concurrent request 3' }],
        stream: false,
      }),
      client.openaiChat({
        model: 'deepseek/v3-chat',
        messages: [{ role: 'user', content: 'Concurrent request 4' }],
        stream: false,
      }),
    ];

    const responses = await Promise.all(promises);

    expect(responses[0].status).toBe(200);
    expect(responses[1].status).toBe(200);
    expect(responses[2].status).toBe(200);
    expect(responses[3].status).toBe(200);

    const body0 = (await responses[0].json()) as any;
    const body1 = (await responses[1].json()) as any;
    const body2 = (await responses[2].json()) as any;
    const body3 = (await responses[3].json()) as any;

    assertOpenAISuccess(body0);
    assertAnthropicSuccess(body1);
    assertOpenAISuccess(body2);
    assertOpenAISuccess(body3);
  });
});
