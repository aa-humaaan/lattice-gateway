import { globalPluginRegistry } from '../plugins/registry';
import type { ProviderPlugin } from '../core/types/plugin';
import { GatewayError } from '../core/types/errors';

export function resolveTargetProviderId(modelId: string): string {
  if (modelId.startsWith('freellmapi/')) return 'freellmapi';
  if (modelId.startsWith('kilo/')) return 'kilo';
  if (
    modelId.startsWith('cline/') ||
    modelId.startsWith('cline-free/') ||
    modelId.startsWith('reflection/') ||
    modelId.startsWith('poolside/')
  ) {
    return 'cline';
  }
  if (modelId.startsWith('nous/')) return 'nous';
  if (
    modelId.startsWith('deepseek/') ||
    modelId === 'deepseek-chat' ||
    modelId === 'deepseek-reasoner'
  ) {
    return 'deepseek';
  }
  if (
    modelId.startsWith('opencode/') ||
    modelId === 'big-pickle' ||
    modelId.includes('flash-free') ||
    modelId.includes('lightning-free') ||
    modelId.includes('muse-spark') ||
    modelId.includes('contributor-free') ||
    modelId.includes('ultra-free') ||
    modelId.includes('ling-3.0')
  ) {
    return 'opencode';
  }
  if (modelId.startsWith('lattice/')) return 'lattice';

  const parts = modelId.split('/');
  if (parts.length > 1 && globalPluginRegistry.has(parts[0])) {
    return parts[0];
  }

  if (globalPluginRegistry.has(modelId)) {
    return modelId;
  }

  return 'unknown';
}

export function resolveProviderForModel(modelId: string): {
  plugin: ProviderPlugin;
  resolvedModel: string;
} {
  const providerId = resolveTargetProviderId(modelId);
  if (providerId !== 'unknown' && globalPluginRegistry.isEnabled(providerId)) {
    return { plugin: globalPluginRegistry.get(providerId)!, resolvedModel: modelId };
  }

  // Check if any enabled plugin serves this model in its catalog
  for (const plugin of globalPluginRegistry.getEnabled()) {
    if (plugin.id === 'lattice') continue;
    const cached = (plugin as any).cachedModels;
    if (
      Array.isArray(cached) &&
      cached.some((m: any) => m.id === modelId || m.id.endsWith('/' + modelId))
    ) {
      return { plugin, resolvedModel: modelId };
    }
  }

  throw new GatewayError(
    404,
    'model_not_found',
    `No active provider found for combo target model: ${modelId}`
  );
}
