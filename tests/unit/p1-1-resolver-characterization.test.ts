import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
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

const CATALOG: Record<string, string[]> = {
  kilo: ['kilo/claude-3-7-sonnet', 'kilo/code-fast:free'],
  cline: ['cline/sonnet-agent', 'cline-free/mimo-v2.6-flash', 'reflection/beam-free'],
  nous: ['nous/hermes-3-llama3'],
  deepseek: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
  opencode: ['big-pickle', 'mimo-v2.6-flash-free'],
  lattice: ['lattice/code-flagship', 'lattice/1m-free'],
  newcomer: ['newcomer/widget'],
};

const MODELS = [
  'kilo/claude-3-7-sonnet',
  'cline/sonnet-agent',
  'cline-free/mimo-v2.6-flash',
  'reflection/beam-free',
  'nous/hermes-3-llama3',
  'deepseek/deepseek-chat',
  'deepseek-chat',
  'deepseek-reasoner',
  'big-pickle',
  'mimo-v2.6-flash-free',
  'opencode/big-pickle',
  'lattice/code-flagship',
  'lattice/kilo/claude-3-7-sonnet',
  'claude-3-7-sonnet',
  'auto',
  'default',
  'lattice/long-context-free',
  'newcomer/widget',
  'unknown-vendor/foo',
  'totally-unknown',
  'kilo',
  'lattice',
];

let multiApp: ReturnType<typeof createServer>;
let singleApp: ReturnType<typeof createServer>;

beforeEach(() => {
  const plugins = Object.entries(CATALOG).map(([id, models]) => plugin(id, models));
  multiApp = createServer({}, plugins);
  singleApp = createServer({}, [plugin('solo', ['solo/known'])]);
  for (const existing of globalPluginRegistry.getAll()) {
    globalPluginRegistry.unregister(existing.id);
  }
  for (const p of plugins) globalPluginRegistry.register(p);
});

afterEach(() => {
  for (const existing of globalPluginRegistry.getAll()) {
    globalPluginRegistry.unregister(existing.id);
  }
});

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

// Post-fix characterization: both entrypoints now agree on every row.
// Pre-fix disagreements were: lattice/kilo/claude-3-7-sonnet,
// claude-3-7-sonnet, auto, default (plus the single-plugin shortcut below).
const UNIFIED: Record<string, [string, string]> = {
  'kilo/claude-3-7-sonnet': ['kilo', 'PLUGIN:kilo'],
  'cline/sonnet-agent': ['cline', 'PLUGIN:cline'],
  'cline-free/mimo-v2.6-flash': ['cline', 'PLUGIN:cline'],
  'reflection/beam-free': ['cline', 'PLUGIN:cline'],
  'nous/hermes-3-llama3': ['nous', 'PLUGIN:nous'],
  'deepseek/deepseek-chat': ['deepseek', 'PLUGIN:deepseek'],
  'deepseek-chat': ['deepseek', 'PLUGIN:deepseek'],
  'deepseek-reasoner': ['deepseek', 'PLUGIN:deepseek'],
  'big-pickle': ['opencode', 'PLUGIN:opencode'],
  'mimo-v2.6-flash-free': ['opencode', 'PLUGIN:opencode'],
  'opencode/big-pickle': ['opencode', 'PLUGIN:opencode'],
  'lattice/code-flagship': ['lattice', 'PLUGIN:lattice'],
  'lattice/kilo/claude-3-7-sonnet': ['kilo', 'PLUGIN:kilo'],
  'claude-3-7-sonnet': ['lattice', 'PLUGIN:lattice'],
  auto: ['lattice', 'PLUGIN:lattice'],
  default: ['lattice', 'PLUGIN:lattice'],
  'lattice/long-context-free': ['lattice', 'PLUGIN:lattice'],
  'newcomer/widget': ['newcomer', 'PLUGIN:newcomer'],
  'unknown-vendor/foo': ['unknown', 'HTTP_404'],
  'totally-unknown': ['unknown', 'HTTP_404'],
  kilo: ['kilo', 'PLUGIN:kilo'],
  lattice: ['lattice', 'PLUGIN:lattice'],
};

describe('P1-1 characterization: two resolvers over an identical plugin catalog', () => {
  test('records both resolutions and reports the disagreements', async () => {
    const rows: Array<{ model: string; modelResolver: string; router: string; differs: boolean }> = [];
    for (const model of MODELS) {
      const modelResolver = await resolveTargetProviderId(model);
      const router = await routerResolution(multiApp, model);
      const expected = UNIFIED[model];
      expect([modelResolver, router]).toEqual(expected);
      rows.push({
        model,
        modelResolver,
        router,
        differs:
          router === `PLUGIN:${modelResolver}` ||
          (modelResolver === 'unknown' && router === 'HTTP_404')
            ? false
            : true,
      });
    }

    console.table(rows);
    expect(rows.length).toBe(22);
    expect(rows.filter((r) => r.differs).map((r) => r.model)).toEqual([]);
  });

  test('single-plugin router rejects an unknown model (F-22)', async () => {
    const modelResolver = await resolveTargetProviderId('totally-unknown');
    const router = await routerResolution(singleApp, 'totally-unknown');
    expect(modelResolver).toBe('unknown');
    expect(router).toBe('HTTP_404');
  });
});
