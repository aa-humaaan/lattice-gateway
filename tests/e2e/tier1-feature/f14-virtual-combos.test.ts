/**
 * Feature F14: Core Infrastructure - Virtual Model Combos & Hierarchical Fallbacks
 * 
 * Verifies:
 * - Virtual model alias (e.g., `lattice/code-flagship`) routes to primary provider model
 * - Primary provider 429 fails over to secondary provider in combo definition
 * - 3-tier fallback chain (Kilo -> Nous -> Cline) traverses in priority order
 * - Dynamic combo creation takes effect immediately
 * - Unknown combo alias returns descriptive 404 with available combos
 * - Combo model descriptors exposed in /v1/models catalog
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertModelPresent,
  assertDialectError,
} from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

export interface ComboTarget {
  providerId: string;
  modelId: string;
}

export interface VirtualCombo {
  id: string; // e.g. "lattice/code-flagship"
  name: string;
  targets: ComboTarget[];
}

export class VirtualComboRouter implements ProviderPlugin {
  readonly id = 'lattice';
  readonly displayName = 'Project Lattice Virtual Combos Provider';
  readonly defaultBaseUrl: string;
  private combos: Map<string, VirtualCombo> = new Map();
  public subProviders: Map<string, ProviderPlugin> = new Map();

  constructor(upstreamBaseUrl: string) {
    this.defaultBaseUrl = upstreamBaseUrl;
  }

  registerCombo(combo: VirtualCombo): void {
    this.combos.set(combo.id, combo);
  }

  getCombos(): VirtualCombo[] {
    return Array.from(this.combos.values());
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return Array.from(this.combos.values()).map((c) => ({
      id: c.id,
      name: c.name,
      providerId: 'lattice',
      ownedBy: 'lattice-combo',
      created: 1731693600,
    }));
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const combo = this.combos.get(req.model);
    if (!combo) {
      const available = Array.from(this.combos.keys()).join(', ');
      throw new GatewayError(
        404,
        '404',
        `Unknown combo alias: '${req.model}'. Available combos: [${available}]`
      );
    }

    let lastError: any = null;

    // Traverse combo targets in strict priority order
    for (let i = 0; i < combo.targets.length; i++) {
      const target = combo.targets[i];
      const provider = this.subProviders.get(target.providerId);
      if (!provider) {
        continue;
      }

      const targetReq: CanonicalRequest = {
        ...req,
        model: `${target.providerId}/${target.modelId}`,
      };

      try {
        const res = await provider.execute(targetReq, signal);
        return {
          ...res,
          model: req.model, // Preserve virtual combo alias in output
        };
      } catch (err: any) {
        lastError = err;
        // If 429 or 5xx, failover to next target
        if (err.statusCode === 429 || (err.statusCode && err.statusCode >= 500)) {
          continue;
        }
        // Non-retryable error (e.g. 400 bad request) throws immediately
        throw err;
      }
    }

    throw lastError || new GatewayError(502, '502', `All combo targets failed for ${req.model}`);
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'text_delta', delta: 'Virtual combo stream turn' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

// Simple test sub-provider that records which target was called
class SimpleSubProvider implements ProviderPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly defaultBaseUrl: string;
  public forceStatus?: number;
  public calledCount = 0;

  constructor(id: string, baseUrl: string) {
    this.id = id;
    this.displayName = `${id} Sub Provider`;
    this.defaultBaseUrl = baseUrl;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: `${this.id}/test-model`, name: `${this.id} Test Model`, providerId: this.id }];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.calledCount++;
    if (this.forceStatus === 429) {
      throw new GatewayError(429, '429', `${this.id} rate limited`, { retryAfter: 15 });
    }
    if (this.forceStatus && this.forceStatus >= 500) {
      throw new GatewayError(this.forceStatus, String(this.forceStatus), `${this.id} service error`);
    }

    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: `Resolved by sub-provider ${this.id}` }],
      stopReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    return (async function* () {
      yield { type: 'text_delta', delta: 'sub stream' };
    })();
  }
}

describe('Feature F14: Virtual Model Combos & Hierarchical Fallbacks', () => {
  let mockServer: MockUpstreamServer;
  let comboRouter: VirtualComboRouter;
  let subKilo: SimpleSubProvider;
  let subNous: SimpleSubProvider;
  let subCline: SimpleSubProvider;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();

    comboRouter = new VirtualComboRouter(mockServer.url);
    subKilo = new SimpleSubProvider('kilo', mockServer.url);
    subNous = new SimpleSubProvider('nous', mockServer.url);
    subCline = new SimpleSubProvider('cline', mockServer.url);

    comboRouter.subProviders.set('kilo', subKilo);
    comboRouter.subProviders.set('nous', subNous);
    comboRouter.subProviders.set('cline', subCline);

    // Register initial combo: 3-tier fallback chain
    comboRouter.registerCombo({
      id: 'lattice/code-flagship',
      name: 'Lattice Code Flagship Combo',
      targets: [
        { providerId: 'kilo', modelId: 'kilo-auto' },
        { providerId: 'nous', modelId: 'hermes-3-llama-3.1-8b' },
        { providerId: 'cline', modelId: 'claude-3-7-sonnet' },
      ],
    });

    const app = createServer({ port: 0 }, [comboRouter]);
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
    subKilo.forceStatus = undefined;
    subKilo.calledCount = 0;
    subNous.forceStatus = undefined;
    subNous.calledCount = 0;
    subCline.forceStatus = undefined;
    subCline.calledCount = 0;
  });

  // Test 1: Virtual model alias routes to primary provider model
  it('routes virtual combo alias to primary provider model when healthy', async () => {
    const res = await client.openaiChat({
      model: 'lattice/code-flagship',
      messages: [{ role: 'user', content: 'Generate code' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Resolved by sub-provider kilo');
    expect(body.model).toBe('lattice/code-flagship');

    expect(subKilo.calledCount).toBe(1);
    expect(subNous.calledCount).toBe(0);
    expect(subCline.calledCount).toBe(0);
  });

  // Test 2: Primary provider 429 fails over to secondary provider in combo
  it('fails over to secondary provider when primary provider returns 429', async () => {
    subKilo.forceStatus = 429; // Kilo hits rate limit

    const res = await client.openaiChat({
      model: 'lattice/code-flagship',
      messages: [{ role: 'user', content: 'Fallback check' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Resolved by sub-provider nous');

    expect(subKilo.calledCount).toBe(1);
    expect(subNous.calledCount).toBe(1);
    expect(subCline.calledCount).toBe(0);
  });

  // Test 3: 3-tier fallback chain (Kilo -> Nous -> Cline) traverses in priority order
  it('traverses 3-tier fallback chain in priority order when first two targets fail', async () => {
    subKilo.forceStatus = 429; // Tier 1: 429 Rate Limit
    subNous.forceStatus = 502; // Tier 2: 502 Bad Gateway
    // Tier 3 (Cline): Healthy

    const res = await client.openaiChat({
      model: 'lattice/code-flagship',
      messages: [{ role: 'user', content: '3-tier check' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Resolved by sub-provider cline');

    expect(subKilo.calledCount).toBe(1);
    expect(subNous.calledCount).toBe(1);
    expect(subCline.calledCount).toBe(1);
  });

  // Test 4: Dynamic combo creation takes effect immediately
  it('registers new virtual combo dynamically and makes it immediately routable', async () => {
    comboRouter.registerCombo({
      id: 'lattice/fast-general',
      name: 'Lattice Fast General Combo',
      targets: [{ providerId: 'nous', modelId: 'hermes-3-llama-3.1-8b' }],
    });

    const res = await client.openaiChat({
      model: 'lattice/fast-general',
      messages: [{ role: 'user', content: 'Dynamic combo test' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toBe('Resolved by sub-provider nous');
    expect(body.model).toBe('lattice/fast-general');
  });

  // Test 5: Unknown combo alias returns descriptive 404
  it('returns descriptive 404 when requested combo alias does not exist', async () => {
    const res = await client.openaiChat({
      model: 'lattice/non-existent-combo',
      messages: [{ role: 'user', content: '404 check' }],
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 404);
    expect(body.error.message).toContain('Unknown combo alias');
    expect(body.error.message).toContain('lattice/code-flagship');
  });

  // Test 6: Virtual combos listed in /v1/models catalog
  it('exposes virtual combo aliases in aggregated /v1/models catalog', async () => {
    const res = await client.getModels();
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as any;
    assertModelPresent(catalog, 'lattice/code-flagship');
    assertModelPresent(catalog, 'lattice/fast-general');
  });
});
