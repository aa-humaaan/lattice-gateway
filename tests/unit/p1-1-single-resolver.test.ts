import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { createServer } from '../../src/core/server';
import { createAdminRouter } from '../../src/admin/admin-router';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { resolveTargetProviderId } from '../../src/utils/model-resolver';
import type { ProviderPlugin } from '../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';

function plugin(id: string, modelIds: string[]): ProviderPlugin {
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'http://stub.local/v1',
    cachedModels: modelIds.map((modelId) => ({ id: modelId, name: modelId })),
    listModels: async () => modelIds.map((modelId) => ({ id: modelId, name: modelId })),
    execute: async (req: CanonicalRequest): Promise<CanonicalResponse> => ({
      id: req.id,
      model: req.model,
      created: 1,
      content: [{ type: 'text', text: `PLUGIN:${id}` }],
      stopReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
    executeStream: async (): Promise<AsyncIterable<CanonicalStreamEvent>> =>
      (async function* () {
        yield { type: 'stream_end', stopReason: 'stop' };
      })(),
  };
}

function resetRegistry(): void {
  for (const p of globalPluginRegistry.getAll()) globalPluginRegistry.unregister(p.id);
}

beforeEach(resetRegistry);
afterEach(resetRegistry);

async function routerResolution(app: ReturnType<typeof createServer>, model: string): Promise<string> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
  if (res.status !== 200) return `HTTP_${res.status}`;
  const json: any = await res.json();
  return json.choices[0].message.content;
}

describe('P1-1: one catalog-driven resolver', () => {
  test('both entrypoints agree on aliases and nested harness prefixes', async () => {
    const plugins = [
      plugin('kilo', ['kilo/claude-3-7-sonnet']),
      plugin('lattice', ['lattice/code-flagship', 'lattice/1m-free']),
      plugin('newcomer', ['newcomer/widget']),
    ];
    const app = createServer({}, plugins);
    resetRegistry();
    for (const p of plugins) globalPluginRegistry.register(p);

    for (const model of [
      'lattice/kilo/claude-3-7-sonnet',
      'claude-3-7-sonnet',
      'auto',
      'default',
    ]) {
      const providerId = await resolveTargetProviderId(model);
      const routed = await routerResolution(app, model);
      expect(routed, `model ${model}: resolver=${providerId} router=${routed}`).toBe(
        `PLUGIN:${providerId}`
      );
    }
  });

  test('a newly registered plugin routes with no core-file edits', async () => {
    const fresh = plugin('zephyr', ['zephyr/quantum-model']);
    const companion = plugin('kilo', ['kilo/claude-3-7-sonnet']);
    const app = createServer({}, [companion, fresh]);
    resetRegistry();
    globalPluginRegistry.register(companion);
    globalPluginRegistry.register(fresh);

    expect(await resolveTargetProviderId('zephyr/quantum-model')).toBe('zephyr');
    expect(await routerResolution(app, 'zephyr/quantum-model')).toBe('PLUGIN:zephyr');
  });

  test('single-plugin setup rejects an unknown model (F-22)', async () => {
    const solo = plugin('solo', ['solo/known']);
    const app = createServer({}, [solo]);
    resetRegistry();
    globalPluginRegistry.register(solo);

    expect(await resolveTargetProviderId('totally-unknown')).toBe('unknown');
    expect(await routerResolution(app, 'totally-unknown')).toBe('HTTP_404');
    expect(await routerResolution(app, 'solo/known')).toBe('PLUGIN:solo');
  });

  test('admin bootstrap does not overwrite an already registered lattice plugin', () => {
    const combo = plugin('lattice', ['lattice/code-flagship']);
    globalPluginRegistry.register(combo);
    createAdminRouter();
    expect(globalPluginRegistry.get('lattice')).toBe(combo);
    expect(globalPluginRegistry.has('lattice-combo')).toBe(false);
  });

  // SOURCE GUARD: prefix hardcoding is a source-level design property; the
  // routing behavior above cannot reveal a dormant literal in another file.
  test('SOURCE GUARD: no hardcoded provider-prefix startsWith checks remain outside plugin definitions', () => {
    for (const path of [
      'src/utils/model-resolver.ts',
      'src/core/router.ts',
      'src/admin/admin-router.ts',
      'src/admin/dashboard-ui.ts',
    ]) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/startsWith\(['"][a-z][a-z0-9-]*\//);
    }
  });
});
