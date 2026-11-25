import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ComboManager, globalComboManager } from '../../src/pool/combos';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import type { ProviderPlugin } from '../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../src/core/types/canonical';

const POLICY_COMBO = 'lattice/policy-free-then-paid';

function stub(id: string, fail: boolean): any {
  const calls = { count: 0 };
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'http://127.0.0.1:1',
    cachedModels: [{ id: `${id}/model`, name: id }],
    calls,
    async listModels() { return this.cachedModels!; },
    async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
      calls.count++;
      if (fail) throw new Error(`${id} failed`);
      return {
        id: 'ok', model: req.model, created: 1,
        content: [{ type: 'text', text: id }], stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      throw new Error('not used');
    },
  };
}

const policy: any = {
  id: POLICY_COMBO,
  name: 'Policy free-then-paid',
  description: 'Data-only combo definition',
  policy: { version: 1, strategy: 'tier-failover', tiers: ['free', 'paid'], maxFailuresPerTier: 2 },
  targets: [
    { model: 'free-a/model', tier: 'free' },
    { model: 'free-b/model', tier: 'free' },
    { model: 'free-c/model', tier: 'free' },
    { model: 'paid/model', tier: 'paid' },
  ],
};

describe('P2-5 data-driven combos', () => {
  test('a combo can be added as data only, with no source edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-policy-'));
    try {
      writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
      const manager = new ComboManager(dir);
      const combo = manager.getCombo(POLICY_COMBO);
      expect(combo).toBeDefined();
      expect(combo!.targets).toEqual([
        'free-a/model', 'free-b/model', 'free-c/model', 'paid/model',
      ]);
      expect(combo!.policy?.maxFailuresPerTier).toBe(2);
      expect(combo!.policy?.tiers).toEqual(['free', 'paid']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the migrated fast-free combo keeps its exact target order', () => {
    const combo = new ComboManager().getCombo('lattice/fast-free');
    expect(combo!.targets).toEqual([
      'kilo/nvidia/nemotron-3.5-lightning:free',
      'kilo/code-fast:free',
      'kilo/kilo-auto/free',
      'kilo/deepseek-r1:free',
      'big-pickle',
      'mimo-v2.6-flash-free',
    ]);
    expect(combo!.name).toBe('Lattice Fast Free 0$ Tier');
    expect(combo!.policy?.strategy).toBe('tier-failover');
  });

  test('free first, then paid after two failures', async () => {
    const plugins = [stub('free-a', true), stub('free-b', true), stub('free-c', true), stub('paid', false)];
    for (const plugin of plugins) globalPluginRegistry.register(plugin);
    const dir = mkdtempSync(join(tmpdir(), 'lattice-policy-route-'));
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
    const loaded = new ComboManager(dir).getCombo(POLICY_COMBO)!;
    globalComboManager.createCombo(loaded);
    try {
      const comboPlugin = new LatticeComboPlugin();
      const response = await comboPlugin.execute({
        id: 'req_policy', model: POLICY_COMBO,
        messages: [{ role: 'user', content: 'hi' }],
      } as CanonicalRequest);
      expect(response.content[0]).toMatchObject({ text: 'paid' });
      expect((plugins[0] as any).calls.count).toBe(1);
      expect((plugins[1] as any).calls.count).toBe(1);
      expect((plugins[2] as any).calls.count).toBe(0);
      expect((plugins[3] as any).calls.count).toBe(1);
    } finally {
      globalComboManager.deleteCombo(POLICY_COMBO);
      for (const plugin of plugins) globalPluginRegistry.unregister(plugin.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // SOURCE GUARD: context-window inference from model names is a property of
  // source code, invisible to the routing behavior exercised above.
  test('SOURCE GUARD: context windows never come from model-name substrings', () => {
    const src = readFileSync('src/plugins/combo.ts', 'utf8');
    expect(src).not.toContain("includes('1m')");
    expect(src).not.toContain("includes('particle-1')");
    expect(src).not.toContain("includes('nemotron-3.5-lightning')");
  });

  test('the policy format is documented in the repository', () => {
    const doc = readFileSync('docs/combo-policies.md', 'utf8');
    expect(doc).toContain('maxFailuresPerTier');
    expect(doc).toContain('tier-failover');
  });
});
