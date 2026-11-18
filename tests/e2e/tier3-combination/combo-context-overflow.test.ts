/**
 * Tier 3 Integration Test: Mixed 128k / 1M Context Overflow Routing
 * 
 * Verifies that a virtual combo configured with mixed context-length targets:
 * 1. Routes small prompts (<128k) to the fast/primary 128k model.
 * 2. Automatically skips the 128k model when prompt exceeds its context window and routes to the 1M model.
 * 3. Handles streaming requests with prompt exceeding 128k by streaming from the 1M model.
 * 4. Rejects prompts that exceed even the 1M model with a clean 400 context_length_exceeded error.
 * 5. Dynamically clamps maxTokens to available output budget when prompt approaches context limit.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';
import { globalComboManager } from '../../../src/pool/combos';
import { globalPluginRegistry } from '../../../src/plugins/registry';
import { LatticeComboPlugin } from '../../../src/plugins/combo';

class ContextStubPlugin implements ProviderPlugin {
  readonly defaultBaseUrl = 'https://mock.context.local/v1';
  public callCount = 0;
  public lastReceivedMaxTokens?: number;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private models: ModelDescriptor[]
  ) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.callCount++;
    this.lastReceivedMaxTokens = req.maxTokens;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: `Served by ${this.id}` }],
      stopReason: 'stop',
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.callCount++;
    const pluginId = this.id;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Date.now() };
      yield { type: 'text_delta', delta: `Streamed by ${pluginId}` };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 3 Combination: Mixed 128k / 1M Combo Context Overflow Routing', () => {
  let plugin128k: ContextStubPlugin;
  let plugin1M: ContextStubPlugin;
  let gatewayServer: any;
  let client: TestClient;
  const COMBO_ID = 'lattice/mixed-128k-1m-combo';

  beforeAll(async () => {
    plugin128k = new ContextStubPlugin('stub-128k', 'Stub 128k Provider', [
      {
        id: 'stub-128k/model-128k',
        name: 'Model 128k',
        providerId: 'stub-128k',
        contextWindow: 128000,
        maxOutputTokens: 8192,
      },
    ]);

    plugin1M = new ContextStubPlugin('stub-1m', 'Stub 1M Provider', [
      {
        id: 'stub-1m/model-1m',
        name: 'Model 1M',
        providerId: 'stub-1m',
        contextWindow: 1000000,
        maxOutputTokens: 16384,
      },
    ]);

    globalPluginRegistry.register(plugin128k);
    globalPluginRegistry.register(plugin1M);

    const comboPlugin = new LatticeComboPlugin();
    globalPluginRegistry.register(comboPlugin);

    globalComboManager.createCombo({
      id: COMBO_ID,
      name: 'Mixed 128k and 1M Combo',
      targets: ['stub-128k/model-128k', 'stub-1m/model-1m'],
      createdAt: Date.now(),
    });

    const app = createServer({ env: 'test' }, [plugin128k, plugin1M, comboPlugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) {
      gatewayServer.stop(true);
    }
    globalComboManager.deleteCombo(COMBO_ID);
    globalPluginRegistry.unregister(plugin128k.id);
    globalPluginRegistry.unregister(plugin1M.id);
  });

  function generateTokens(targetLines: number): string {
    const line = (i: number) =>
      'Line ' + i + ': detailed unique token string analysis module test case with parameters and identifiers ' + (i * 7) + '\n';
    return Array.from({ length: targetLines }, (_, i) => line(i)).join('');
  }

  it('routes small prompt (10k tokens) to the primary 128k target', async () => {
    // ~10,000 tokens ~ 500 lines
    const text10k = generateTokens(500);

    const res = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: text10k }],
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toBe('Served by stub-128k');
    expect(plugin128k.callCount).toBe(1);
    expect(plugin1M.callCount).toBe(0);
  });

  it('automatically skips 128k target and routes to 1M target when prompt exceeds 128k', async () => {
    // ~140,000 tokens = 6750 lines
    const text140k = generateTokens(6750);

    const res = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: text140k }],
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    // 128k was safely skipped, 1M target executed successfully
    expect(json.choices[0].message.content).toBe('Served by stub-1m');
    expect(plugin128k.callCount).toBe(1); // Still 1, was not called for this prompt
    expect(plugin1M.callCount).toBe(1);
  });

  it('automatically skips 128k target on streaming request when prompt exceeds 128k', async () => {
    // ~140,000 tokens = 6750 lines
    const text140k = generateTokens(6750);

    const stream = client.openaiChatStream({
      model: COMBO_ID,
      messages: [{ role: 'user', content: text140k }],
    });

    let fullText = '';
    for await (const chunk of stream) {
      if (chunk.choices?.[0]?.delta?.content) {
        fullText += chunk.choices[0].delta.content;
      }
    }

    expect(fullText).toContain('Streamed by stub-1m');
    expect(plugin1M.callCount).toBe(2);
  });

  it('returns clean 400 context_length_exceeded when prompt exceeds even the 1M target', async () => {
    // ~1,111,000 tokens = 53000 lines
    const giantPrompt = generateTokens(53000);

    const res = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: giantPrompt }],
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error.type).toBe('invalid_request_error');
    expect(json.error.message).toMatch(/context window/i);
    expect(json.error.message).toMatch(/1000000/);
  });

  it('safely clamps maxTokens when prompt approaches the context boundary', async () => {
    // 5800 lines ~ 120,650 tokens in 128k model: available = 128,000 - 120,650 - 4000 = 3,350
    // Client requested maxTokens: 8192, so gateway safely clamps maxTokens to ~3350
    const text120k = generateTokens(5800);

    const res = await client.openaiChat({
      model: COMBO_ID,
      messages: [{ role: 'user', content: text120k }],
      max_tokens: 8192,
    });

    expect(res.status).toBe(200);
    expect(plugin128k.lastReceivedMaxTokens).toBeDefined();
    expect(plugin128k.lastReceivedMaxTokens!).toBeLessThan(8192);
    expect(plugin128k.lastReceivedMaxTokens!).toBeGreaterThan(0);
  });
});
