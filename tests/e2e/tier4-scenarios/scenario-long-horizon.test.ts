/**
 * Tier 4 Real-World Application Scenario: Long-Horizon Agent Loop
 * 
 * Simulates an authentic 50+ turn Claude Code engineering loop where:
 * 1. An agent iterates across 50+ continuous tool-use turns.
 * 2. Message history and context grow progressively from 500 tokens past 128k tokens.
 * 3. The virtual combo has a 128k primary target and a 1M fallback target.
 * 4. Early turns route cleanly to the 128k target.
 * 5. As context grows past 128k, the combo automatically skips the 128k target
 *    and seamlessly fails over to the 1M target without client-side error.
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
import { LatticeComboPlugin } from '../../../src/plugins/combo';
import { globalComboManager } from '../../../src/pool/combos';
import { globalPluginRegistry } from '../../../src/plugins/registry';

class LongHorizonPrimaryPlugin implements ProviderPlugin {
  readonly id = 'long-primary';
  readonly displayName = 'Primary 128k Provider';
  readonly defaultBaseUrl = 'https://mock.primary.local/v1';

  public callCount = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'long-primary/claude-128k',
        name: 'Claude 3.7 (128k Context)',
        providerId: 'long-primary',
        ownedBy: 'anthropic',
        created: 1731693600,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.callCount++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [
        {
          type: 'text',
          text: `Served turn by long-primary (turn call #${this.callCount})`,
        },
      ],
      stopReason: 'stop',
      usage: {
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.callCount++;
    const count = this.callCount;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Date.now() };
      yield { type: 'text_delta', delta: `Streamed turn by long-primary (#${count})` };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

class LongHorizonSecondaryPlugin implements ProviderPlugin {
  readonly id = 'long-secondary';
  readonly displayName = 'Secondary 1M Provider';
  readonly defaultBaseUrl = 'https://mock.secondary.local/v1';

  public callCount = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'long-secondary/particle-1m',
        name: 'Particle 1 (1M Context)',
        providerId: 'long-secondary',
        ownedBy: 'particle',
        created: 1731693600,
        contextWindow: 1000000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.callCount++;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [
        {
          type: 'text',
          text: `Served overflow turn by long-secondary (turn call #${this.callCount})`,
        },
      ],
      stopReason: 'stop',
      usage: {
        promptTokens: 135000,
        completionTokens: 35,
        totalTokens: 135035,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.callCount++;
    const count = this.callCount;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Date.now() };
      yield { type: 'text_delta', delta: `Streamed overflow turn by long-secondary (#${count})` };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 4 Scenario: 50+ Turn Long-Horizon Agent Loop with 128k->1M Context Failover', () => {
  let primaryPlugin: LongHorizonPrimaryPlugin;
  let secondaryPlugin: LongHorizonSecondaryPlugin;
  let gatewayServer: any;
  let client: TestClient;
  const COMBO_ID = 'lattice/long-horizon-combo';

  beforeAll(async () => {
    primaryPlugin = new LongHorizonPrimaryPlugin();
    secondaryPlugin = new LongHorizonSecondaryPlugin();

    globalPluginRegistry.register(primaryPlugin);
    globalPluginRegistry.register(secondaryPlugin);

    globalComboManager.createCombo({
      id: COMBO_ID,
      name: 'Long Horizon 128k to 1M Combo',
      targets: ['long-primary/claude-128k', 'long-secondary/particle-1m'],
      createdAt: Date.now(),
    });

    const comboPlugin = new LatticeComboPlugin();
    globalPluginRegistry.register(comboPlugin);

    const app = createServer({ env: 'test' }, [primaryPlugin, secondaryPlugin, comboPlugin]);
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
    globalPluginRegistry.unregister(primaryPlugin.id);
    globalPluginRegistry.unregister(secondaryPlugin.id);
  });

  it('runs 52 consecutive turns, successfully transitioning from 128k to 1M target as context grows past 128k', async () => {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Turns 1 to 45: Incremental agent interactions under 128k tokens
    for (let turn = 1; turn <= 45; turn++) {
      messages.push({
        role: 'user',
        content: `Turn ${turn}: Inspecting module src/core/auth_subsystem_${turn}.ts and auditing invariants.`,
      });

      const res = await client.anthropicMessages({
        model: COMBO_ID,
        max_tokens: 100,
        messages: [...messages],
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.model).toBe(COMBO_ID);
      expect(json.content[0].text).toContain('long-primary');

      messages.push({
        role: 'assistant',
        content: json.content[0].text,
      });
    }

    expect(primaryPlugin.callCount).toBe(45);
    expect(secondaryPlugin.callCount).toBe(0);

    // Turn 46 to 52: Massive repository context injection pushing tokens past 128k (~135,000 tokens)
    // 130,000 tokens ~ 520,000 chars of source text
    const largeCodeContext = '// Large code dump\n' + 'const variable_x = 42; // codebase scan line\n'.repeat(12000);
    messages.push({
      role: 'user',
      content: `Turn 46: Full repository symbol dump for deep cross-module analysis:\n${largeCodeContext}`,
    });

    for (let turn = 46; turn <= 52; turn++) {
      if (turn > 46) {
        messages.push({
          role: 'user',
          content: `Turn ${turn}: Verify symbol resolution for reference batch #${turn}.`,
        });
      }

      const res = await client.anthropicMessages({
        model: COMBO_ID,
        max_tokens: 100,
        messages: [...messages],
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.model).toBe(COMBO_ID);
      // As context exceeded 128k, long-primary was safely skipped, and long-secondary served the turn!
      expect(json.content[0].text).toContain('long-secondary');

      messages.push({
        role: 'assistant',
        content: json.content[0].text,
      });
    }

    // Verify turn metrics across plugins
    expect(primaryPlugin.callCount).toBe(45);
    expect(secondaryPlugin.callCount).toBe(7);
    expect(messages.length).toBe(52 * 2);
  }, 60_000);
});
