import type { ProviderPlugin, ModelDescriptor } from '../core/types/plugin';
import { logger } from '../utils/logger';

export class PluginRegistry {
  private plugins = new Map<string, ProviderPlugin>();
  private enabledStates = new Map<string, boolean>();

  register(plugin: ProviderPlugin, enabled = true): void {
    this.plugins.set(plugin.id, plugin);
    this.enabledStates.set(plugin.id, enabled);
    logger.info(`[PluginRegistry] Registered plugin: ${plugin.id} (${plugin.displayName}) [enabled=${enabled}]`);
  }

  unregister(pluginId: string): boolean {
    this.enabledStates.delete(pluginId);
    return this.plugins.delete(pluginId);
  }

  get(pluginId: string): ProviderPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  isEnabled(pluginId: string): boolean {
    return this.enabledStates.get(pluginId) ?? false;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    if (this.plugins.has(pluginId)) {
      this.enabledStates.set(pluginId, enabled);
      logger.info(`[PluginRegistry] Plugin ${pluginId} state set to ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  getAll(): ProviderPlugin[] {
    return Array.from(this.plugins.values());
  }

  getEnabled(): ProviderPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => this.isEnabled(p.id));
  }

  async getAllModels(): Promise<ModelDescriptor[]> {
    const models: ModelDescriptor[] = [];
    for (const plugin of this.getEnabled()) {
      try {
        const list = await plugin.listModels();
        models.push(...list);
      } catch (err) {
        logger.error(`[PluginRegistry] Error listing models for ${plugin.id}:`, err);
      }
    }
    return models;
  }

  async resolvePluginForModel(modelId: string): Promise<ProviderPlugin | undefined> {
    const enabled = this.getEnabled();

    // 1. Direct provider prefix match: "providerId/modelName"
    const [providerId] = modelId.split('/');
    if (this.plugins.has(providerId) && this.isEnabled(providerId)) {
      return this.plugins.get(providerId);
    }

    // 2. Direct plugin ID match (e.g., "kilo", "cline")
    if (this.plugins.has(modelId) && this.isEnabled(modelId)) {
      return this.plugins.get(modelId);
    }

    // 3. Catalog scan across enabled plugins
    for (const plugin of enabled) {
      try {
        const models = await plugin.listModels();
        for (const m of models) {
          if (m.id === modelId) return plugin;
          if (m.id.includes('/')) {
            const bare = m.id.split('/').slice(1).join('/');
            if (bare === modelId) return plugin;
          }
        }
      } catch {
        // continue
      }
    }

    return undefined;
  }
}

export const globalPluginRegistry = new PluginRegistry();
