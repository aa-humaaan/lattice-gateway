import { globalPluginRegistry } from '../plugins/registry';
import { globalAccountPool } from '../pool/account-pool';
import type { ModelDescriptor, ProviderPlugin } from '../core/types/plugin';
import { formatContextWindow, type EnrichedModelCatalogItem, type ModelBadge } from './models-catalog';

interface LiveProvider {
  syncModels?(account?: unknown): Promise<ModelDescriptor[]>;
  listModels(account?: unknown): Promise<ModelDescriptor[]>;
}

function freeBadges(model: ModelDescriptor): ModelBadge[] {
  const badges: ModelBadge[] = [{ text: 'Free ($0)', color: 'emerald' }];
  if ((model.contextWindow ?? 0) >= 1_000_000) badges.push({ text: '1M Context', color: 'emerald' });
  if (model.supportsThinking) badges.push({ text: 'Reasoning', color: 'amber' });
  return badges;
}

function toEnriched(model: ModelDescriptor, providerId: string): EnrichedModelCatalogItem {
  return {
    id: model.id,
    name: model.name || model.id,
    providerId: model.providerId || providerId,
    ownedBy: model.ownedBy || providerId,
    ...(model.contextWindow !== undefined
      ? { contextWindow: model.contextWindow, contextWindowFormatted: formatContextWindow(model.contextWindow) }
      : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    supportsThinking: !!model.supportsThinking,
    supportsTools: !!model.supportsTools,
    supportsStreaming: model.supportsStreaming !== false,
    isFree: true,
    tags: model.tags?.length ? model.tags : ['free'],
    badges: freeBadges(model),
    description: model.name ? `Live free model from ${providerId}` : undefined,
    available: true,
  };
}

/** Builds the Free Models catalog from live provider data only. Providers are
 *  queried only when they have an active account; paid models are excluded. */
export async function buildLiveFreeCatalog(): Promise<EnrichedModelCatalogItem[]> {
  const results: EnrichedModelCatalogItem[] = [];
  for (const plugin of globalPluginRegistry.getEnabled()) {
    if (plugin.id === 'lattice') continue;
    const accounts = globalAccountPool.listAccounts(plugin.id).filter((a) => a.status === 'active');
    if (accounts.length === 0) continue;
    const live = plugin as ProviderPlugin & LiveProvider;
    try {
      const models = typeof live.syncModels === 'function'
        ? await live.syncModels(accounts[0])
        : await live.listModels(accounts[0]);
      for (const model of models) {
        if (model.isFree !== true) continue;
        results.push(toEnriched(model, plugin.id));
      }
    } catch {
      // A failing provider contributes no models; others still appear.
    }
  }
  return results;
}
