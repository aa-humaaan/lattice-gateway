import { globalPluginRegistry } from '../plugins/registry';
import type { ModelDescriptor, ProviderPlugin } from '../core/types/plugin';
import { GatewayError } from '../core/types/errors';
import { assertRemovedAggregatorAvailable } from '../plugins/removed-aggregator';

// Virtual model aliases. These are gateway model definitions, not provider
// prefixes: the "lattice" segment is the combo plugin's registered ID.
const MODEL_ALIASES: Record<string, string> = {
  'claude-3-7-sonnet-20250219': 'lattice/code-flagship',
  'claude-3-7-sonnet': 'lattice/code-flagship',
  'claude-3-5-sonnet-20241022': 'lattice/code-flagship',
  'claude-3-5-sonnet-20240620': 'lattice/code-flagship',
  'claude-3-5-sonnet': 'lattice/code-flagship',
  'claude-3-5-haiku-20241022': 'lattice/1m-free',
  'claude-3-5-haiku': 'lattice/1m-free',
  'claude-3-haiku-20240307': 'lattice/fast-free',
  'claude-3-opus-20240229': 'lattice/code-flagship',
  'claude-3-opus': 'lattice/code-flagship',
  'claude-sonnet-4-6': 'lattice/code-flagship',
  'claude-opus-4-6': 'lattice/code-flagship',
  'claude-haiku-4-5': 'lattice/1m-free',
  auto: 'lattice/1m-free',
  default: 'lattice/code-flagship',
  'lattice/long-context-free': 'lattice/1m-free',
};

export interface ModelResolution {
  plugin: ProviderPlugin;
  resolvedModel: string;
  providerId: string;
}

interface CatalogIndex {
  byId: Map<string, ProviderPlugin>;
  exact: Map<string, ProviderPlugin>;
  bare: Map<string, ProviderPlugin>;
}

const CATALOG_TTL_MS = 60_000;

function newIndex(): CatalogIndex {
  return { byId: new Map(), exact: new Map(), bare: new Map() };
}

function addPlugin(index: CatalogIndex, plugin: ProviderPlugin, models: ModelDescriptor[]): void {
  index.byId.set(plugin.id, plugin);
  for (const model of models) {
    if (!index.exact.has(model.id)) index.exact.set(model.id, plugin);
    if (model.id.includes('/')) {
      const bareName = model.id.split('/').slice(1).join('/');
      if (!index.bare.has(bareName)) index.bare.set(bareName, plugin);
    }
  }
}

function availablePlugins(plugins: Iterable<ProviderPlugin>): ProviderPlugin[] {
  return Array.from(plugins).filter(
    (p) => !globalPluginRegistry.has(p.id) || globalPluginRegistry.isEnabled(p.id)
  );
}

function match(modelId: string, catalog: CatalogIndex): ModelResolution | undefined {
  const exact = catalog.exact.get(modelId);
  if (exact) return { plugin: exact, resolvedModel: modelId, providerId: exact.id };

  const byId = catalog.byId.get(modelId);
  if (byId) return { plugin: byId, resolvedModel: modelId, providerId: byId.id };

  const bare = catalog.bare.get(modelId);
  if (bare) return { plugin: bare, resolvedModel: modelId, providerId: bare.id };

  const segments = modelId.split('/');

  // Harness prefixes ("lattice/kilo/model") wrap a real provider prefix.
  // Strip leading segments and retry before treating the outer segment as the
  // provider. Everything here comes from the registered catalog.
  for (let i = 1; i < segments.length; i++) {
    const nested = match(segments.slice(i).join('/'), catalog);
    if (nested) return nested;
  }

  if (segments.length > 1) {
    const prefixPlugin = catalog.byId.get(segments[0]);
    if (prefixPlugin) {
      return { plugin: prefixPlugin, resolvedModel: modelId, providerId: prefixPlugin.id };
    }
  }

  return undefined;
}

function resolveWith(modelId: string, catalog: CatalogIndex): ModelResolution {
  assertRemovedAggregatorAvailable(modelId);
  const alias = MODEL_ALIASES[modelId];
  const candidates = alias && alias !== modelId ? [alias, modelId] : [modelId];
  for (const candidate of candidates) {
    const found = match(candidate, catalog);
    if (found) return found;
  }
  throw new GatewayError(404, 'model_not_found', `No active provider found for model: ${modelId}`);
}

/**
 * The single catalog-driven resolver. Prefixes, model IDs and aliases are all
 * derived from the plugins handed to it — no provider prefix literals in the
 * resolution logic. Router, combos and admin all use this same matcher with
 * their own plugin source (server map vs global registry).
 */
export function createModelResolver(getPlugins: () => Iterable<ProviderPlugin>) {
  let cached: { index: CatalogIndex; at: number } | null = null;

  // Real plugins expose their curated catalog synchronously; this keeps the
  // sync callers (admin catalog, probe) on the exact same matcher.
  function syncIndex(): CatalogIndex {
    const index = newIndex();
    for (const plugin of availablePlugins(getPlugins())) {
      addPlugin(index, plugin, plugin.cachedModels ?? []);
    }
    return index;
  }

  async function fullIndex(): Promise<CatalogIndex> {
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.index;
    const index = newIndex();
    for (const plugin of availablePlugins(getPlugins())) {
      let models: ModelDescriptor[] = [];
      try {
        models = await plugin.listModels();
      } catch {
        // One unavailable provider must not break resolution for the others.
      }
      addPlugin(index, plugin, models);
    }
    cached = { index, at: Date.now() };
    return index;
  }

  const resolveSync = (modelId: string): ModelResolution => resolveWith(modelId, syncIndex());

  async function resolve(modelId: string): Promise<ModelResolution> {
    return resolveWith(modelId, await fullIndex());
  }

  const resolveProviderId = (modelId: string): string => {
    try {
      return resolveSync(modelId).providerId;
    } catch {
      return 'unknown';
    }
  };

  async function resolveProviderIdAsync(modelId: string): Promise<string> {
    try {
      return (await resolve(modelId)).providerId;
    } catch {
      return 'unknown';
    }
  }

  return {
    resolve,
    resolveSync,
    resolveProviderId,
    resolveProviderIdAsync,
    invalidate: () => {
      cached = null;
    },
  };
}

const globalResolver = createModelResolver(() => globalPluginRegistry.getAll());

export function resolveTargetProviderId(modelId: string): string {
  return globalResolver.resolveProviderId(modelId);
}

export function resolveProviderForModel(modelId: string): ModelResolution {
  return globalResolver.resolveSync(modelId);
}
