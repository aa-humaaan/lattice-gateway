/**
 * Tier 1 Feature Coverage: F4 - Models Catalog & Discovery
 * 
 * Verifies standard OpenAI /v1/models catalog endpoint behavior:
 * - GET /v1/models returns valid OpenAI-compatible list data array
 * - Returns models aggregated across all active plugins
 * - Virtual model combos and plugin descriptors included with model metadata
 * - Model object attributes conform to specification (id, object, created, owned_by, root)
 * - Non-existent route / model endpoint returns proper 404 error
 * - Dynamic plugin registration reflects immediately in catalog
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient } from '../../harness/test-client';
import { assertModelPresent, assertDialectError } from '../../harness/assertions';
import { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';

// Custom plugin simulating a second provider with virtual combos
class VirtualComboPlugin implements ProviderPlugin {
  readonly id = 'combo';
  readonly displayName = 'Virtual Combo Provider';
  readonly defaultBaseUrl = 'https://combo.lattice.local';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'combo/code-flagship',
        name: 'Flagship Coding Combo',
        ownedBy: 'lattice-combo',
        created: 1731694000,
        tags: ['flagship', 'coding', 'combo'],
      },
      {
        id: 'combo/fast-reasoning',
        name: 'Fast Reasoning Combo',
        ownedBy: 'lattice-combo',
        created: 1731694000,
        tags: ['reasoning', 'fast', 'combo'],
      },
    ];
  }

  async execute(): Promise<any> {
    throw new Error('Not implemented');
  }

  async executeStream(): Promise<any> {
    throw new Error('Not implemented');
  }
}

describe('F4: Models Catalog & Discovery (/v1/models)', () => {
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

  // 1. GET /v1/models returns valid OpenAI-compatible data array
  it('returns valid OpenAI-compatible models list with 200 OK status', async () => {
    const res = await client.getModels();

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBeTrue();
    expect(body.data.length).toBeGreaterThanOrEqual(4);

    for (const model of body.data) {
      expect(model.id).toBeString();
      expect(model.object).toBe('model');
      expect(typeof model.created).toBe('number');
      expect(model.created).toBeGreaterThan(0);
      expect(model.owned_by).toBeString();
    }
  });

  // 2. Returns models aggregated across active plugins
  it('aggregates models from default registered provider plugin', async () => {
    const res = await client.getModels();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    assertModelPresent(body, 'mock-chat');
    assertModelPresent(body, 'mock-thinking');
    assertModelPresent(body, 'mock-tools');
    assertModelPresent(body, 'mock-xml-tool');
  });

  // 3. Model object metadata conforms to specification
  it('verifies model object metadata including owned_by, created, and root references', async () => {
    const res = await client.getModels();
    const body = (await res.json()) as any;

    const mockChat = body.data.find((m: any) => m.id === 'mock-chat');
    expect(mockChat).toBeDefined();
    expect(mockChat.id).toBe('mock-chat');
    expect(mockChat.root).toBe('mock-chat');
    expect(mockChat.owned_by).toBe('lattice-mock');
    expect(mockChat.parent).toBeNull();
    expect(Array.isArray(mockChat.permission)).toBeTrue();
  });

  // 4. Dynamic multi-plugin aggregation with virtual combos
  it('aggregates models dynamically when multiple plugins including combos are loaded', async () => {
    // Dynamic import to create custom server with multiple plugins
    const { createServer } = await import('../../../src/core/server');
    const { MockProviderPlugin } = await import('../../mocks/mock-provider');

    const multiApp = createServer({}, [
      new MockProviderPlugin(),
      new VirtualComboPlugin(),
    ]);

    const res = await multiApp.request('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.object).toBe('list');
    const modelIds = body.data.map((m: any) => m.id);

    // Verify models from primary provider
    expect(modelIds).toContain('mock-chat');
    expect(modelIds).toContain('mock-thinking');

    // Verify virtual model combos are included
    expect(modelIds).toContain('combo/code-flagship');
    expect(modelIds).toContain('combo/fast-reasoning');

    const comboModel = body.data.find((m: any) => m.id === 'combo/code-flagship');
    expect(comboModel.owned_by).toBe('lattice-combo');
  });

  // 5. Non-existent model query or route returns proper 404 error
  it('returns proper 404 error when querying an unmounted model endpoint or path', async () => {
    const res = await fetch(`${gateway.baseUrl}/v1/models/non-existent-model-xyz`, {
      method: 'GET',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 404);
    expect(body.error.message).toContain('was not found');
  });

  // 6. Direct model lookup verification from aggregated catalog
  it('allows clients to filter and resolve specific model descriptors from catalog', async () => {
    const res = await client.getModels();
    const body = (await res.json()) as any;

    const thinkingModel = body.data.find((m: any) => m.id === 'mock-thinking');
    expect(thinkingModel).toBeDefined();
    expect(thinkingModel.object).toBe('model');
    expect(thinkingModel.owned_by).toBe('lattice-mock');
  });
});
