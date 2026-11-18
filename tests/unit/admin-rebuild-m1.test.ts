import { describe, it, expect } from 'bun:test';
import { createAdminRouter } from '../../src/admin/admin-router';
import { globalPluginRegistry } from '../../src/plugins/registry';
import type { ProviderPlugin } from '../../src/core/types/plugin';

describe('Admin Dashboard Rebuild (Milestone 1)', () => {
  const router = createAdminRouter();

  function probeStub(id: string): ProviderPlugin {
    return {
      id,
      displayName: 'Probe Stub',
      defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [{ id: `${id}/model`, name: 'Probe Model', providerId: id }];
      },
      async execute(request) {
        return {
          id: 'probe-response', model: request.model, created: 1,
          content: [{ type: 'text', text: 'pong' }], stopReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async executeStream() { return (async function* () {})(); },
    } as ProviderPlugin;
  }

  it('serves dashboard HTML with no external CDN font links and graphite dark palette', async () => {
    const res = await router.request('/admin');
    expect(res.status).toBe(200);
    const html = await res.text();

    // Verify external Google Fonts CDN links are completely absent
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');

    // Verify warm graphite / zinc dark palette tokens
    expect(html).toContain('--bg-canvas: #09090b');
    expect(html).toContain('--bg-surface: #121214');
    expect(html).toContain('--border-subtle: #27272a');

    // Verify critical test invariants
    expect(html).toContain('Lattice Gateway — Mission Control');
    expect(html).toContain('modal-credentials');
    expect(html).toContain('modal-combo-wizard');
    expect(html).toContain('Real-Time Token Telemetry');
    expect(html).toContain('tab-btn-kilo');
    expect(html).toContain('tab-btn-nous');
    expect(html).toContain('tab-btn-cline');
    expect(html).toContain('tab-btn-deepseek');
    expect(html).toContain('wizard-chain-preview');

    // Verify new views
    expect(html).toContain('id="view-models"');
    expect(html).toContain('id="view-harnesses"');
    expect(html).toContain('Free Models Explorer');
    expect(html).toContain('Developer Harness Setup');
  });

  it('GET /api/models returns enriched catalog with at least 31 free models', async () => {
    const res = await router.request('/api/models');
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.count).toBeGreaterThanOrEqual(31);
    expect(Array.isArray(json.models)).toBeTrue();

    // Verify Kilo 1M models
    const particle = json.models.find((m: any) => m.id === 'kilo/particle-ai/particle-1:free');
    expect(particle).toBeDefined();
    expect(particle.contextWindow).toBe(1048576);
    expect(particle.isFree).toBeTrue();
    expect(particle.badges.some((b: any) => b.text === '1M Context')).toBeTrue();

    // Verify Cline pooled models
    const clineStep5 = json.models.find((m: any) => m.id === 'cline-free/step-5-preview');
    expect(clineStep5).toBeDefined();
    expect(clineStep5.contextWindow).toBe(1000000);

    // Verify DeepSeek web pool models
    const dsReasoner = json.models.find((m: any) => m.id === 'deepseek/deepseek-reasoner');
    expect(dsReasoner).toBeDefined();
    expect(dsReasoner.supportsThinking).toBeTrue();

    // Verify OpenCode Zen keyless models
    const bigPickle = json.models.find((m: any) => m.id === 'big-pickle');
    expect(bigPickle).toBeDefined();
    expect(bigPickle.providerId).toBe('opencode');

    // Verify Lattice Virtual Combos
    const lattice1m = json.models.find((m: any) => m.id === 'lattice/1m-free');
    expect(lattice1m).toBeDefined();
    expect(lattice1m.contextWindow).toBe(1048576);
  });

  it('POST /api/models/probe executes live probe and measures latency', async () => {
    const plugin = probeStub('admin_probe_body');
    globalPluginRegistry.register(plugin);
    try {
      const res = await router.request('/api/models/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'admin_probe_body/model' }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBeTrue();
      expect(json.model).toBe('admin_probe_body/model');
      expect(typeof json.latencyMs).toBe('number');
      expect(json.latencyMs).toBeGreaterThan(0);
      expect(json.healthy).toBeTrue();
    } finally {
      globalPluginRegistry.unregister(plugin.id);
    }
  });

  it('POST /api/models/:id/test executes probe via parameterized URL path', async () => {
    const plugin = probeStub('admin_probe_path');
    globalPluginRegistry.register(plugin);
    try {
      const res = await router.request('/api/models/admin_probe_path%2Fmodel/test', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBeTrue();
      expect(json.model).toBe('admin_probe_path/model');
      expect(typeof json.latencyMs).toBe('number');
    } finally {
      globalPluginRegistry.unregister(plugin.id);
    }
  });

  it('GET /api/harness/status returns status for all 7 developer tools', async () => {
    const res = await router.request('/api/harness/status');
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.count).toBe(7);
    expect(Array.isArray(json.harnesses)).toBeTrue();

    const ids = json.harnesses.map((h: any) => h.id);
    expect(ids).toContain('opencode');
    expect(ids).toContain('kilo');
    expect(ids).toContain('roo');
    expect(ids).toContain('claude');
    expect(ids).toContain('gemini');
    expect(ids).toContain('crush');
    expect(ids).toContain('cursor');

    for (const h of json.harnesses) {
      expect(typeof h.targetPath).toBe('string');
      expect(typeof h.detected).toBe('boolean');
      expect(typeof h.configured).toBe('boolean');
      expect(typeof h.configSnippet).toBe('string');
      expect(h.configSnippet.length).toBeGreaterThan(10);
    }
  });

  it('POST /api/harness/setup validates harness ID and configures without crashing', async () => {
    const res = await router.request('/api/harness/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: 'opencode' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.harness).toBe('opencode');
    expect(json.path).toContain('opencode.json');
    expect(json.message).toBeDefined();
  });

  it('POST /api/harness/setup returns 400 when harness parameter is missing', async () => {
    const res = await router.request('/api/harness/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.success).toBeFalse();
  });

  it('POST /api/harness/setup-all batch configures all 7 developer tools', async () => {
    const res = await router.request('/api/harness/setup-all', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.count).toBe(7);
    expect(json.results.claude.success).toBeTrue();
    expect(json.results.opencode.success).toBeTrue();
    expect(json.results.kilo.success).toBeTrue();
  });
});
