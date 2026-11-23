import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createModelPassportStore,
  createPassportSigner,
  verifyPassport,
} from '../../src/core/model-passports';
import type { ModelDescriptor, ProviderPlugin, HealthCheckResult } from '../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalComboManager } from '../../src/pool/combos';

const COMBO_ID = 'test/health-combo';
const TARGET_A = 'health-stub-a/model';
const TARGET_B = 'health-stub-b/model';

const registered: string[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  globalComboManager.deleteCombo(COMBO_ID);
  for (const id of registered) globalPluginRegistry.unregister(id);
  registered.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function descriptor(id: string, contextWindow = 128_000): ModelDescriptor {
  return { id, name: id, providerId: id.split('/')[0], contextWindow };
}

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-health-'));
  tempDirs.push(dir);
  const signer = createPassportSigner(dir);
  return createModelPassportStore(join(dir, 'passports.json'), signer);
}

class StubPlugin implements ProviderPlugin {
  readonly defaultBaseUrl = 'http://stub';
  readonly displayName: string;
  calls = 0;

  constructor(readonly id: string, private modelId: string) {
    this.displayName = `Stub ${id}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [descriptor(this.modelId)];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    this.calls++;
    return {
      id: 'resp_1',
      model: req.model,
      created: 1,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.calls++;
    return (async function* () {
      yield { type: 'stream_start', id: 'resp_1', model: req.model, created: 1 };
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, checkedAt: Date.now() };
  }
}

function setup() {
  const store = newStore();
  store.observe(descriptor(TARGET_A), 'health-stub-a', 10);
  store.observe(descriptor(TARGET_B), 'health-stub-b', 10);
  store.recordAvailability(TARGET_A, { healthy: false, latencyMs: 900, observedAt: 20, evidence: 'probe' });
  store.recordAvailability(TARGET_B, { healthy: true, latencyMs: 30, observedAt: 20, evidence: 'probe' });

  const a = new StubPlugin('health-stub-a', TARGET_A);
  const b = new StubPlugin('health-stub-b', TARGET_B);
  globalPluginRegistry.register(a);
  globalPluginRegistry.register(b);
  registered.push(a.id, b.id);
  globalComboManager.createCombo({
    id: COMBO_ID,
    name: 'Health combo',
    targets: [TARGET_A, TARGET_B],
    createdAt: Date.now(),
  });
  return { store, a, b };
}

function request(): CanonicalRequest {
  return {
    id: 'req_health',
    clientDialect: 'openai-chat',
    model: COMBO_ID,
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  };
}

describe('P1-5 passport availability evidence', () => {
  test('probe result survives a later catalogue refresh', () => {
    const store = newStore();
    store.observe(descriptor(TARGET_A), 'health-stub-a', 10);
    store.recordAvailability(TARGET_A, { healthy: false, latencyMs: 900, observedAt: 20 });

    const refreshed = store.observe(descriptor(TARGET_A, 200_000), 'health-stub-a', 30);

    expect(refreshed.claims.contextWindow?.value).toBe(200_000);
    expect(refreshed.availability?.observedAt).toBe(20);
    expect(refreshed.availability?.value.healthy).toBeFalse();
    expect(refreshed.availability?.value.latencyMs).toBe(900);
    expect(verifyPassport(refreshed)).toBeTrue();
  });

  test('combo execute skips an unhealthy target when a healthy alternative exists', async () => {
    const { store, a, b } = setup();

    const res = await new LatticeComboPlugin(store).execute(request());

    expect(res.model).toBe(COMBO_ID);
    expect(a.calls).toBe(0);
    expect(b.calls).toBe(1);
  });

  test('combo stream skips an unhealthy target when a healthy alternative exists', async () => {
    const { store, a, b } = setup();

    const events = [];
    for await (const event of await new LatticeComboPlugin(store).executeStream(request())) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'stream_end')).toBeTrue();
    expect(a.calls).toBe(0);
    expect(b.calls).toBe(1);
  });
});
