import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { ProviderPlugin, ModelDescriptor } from '../core/types/plugin';
import type {
  PluginConfig,
  PluginLifecycleHook,
  PluginManifest,
} from '../core/types/plugin-manifest';
import { logger } from '../utils/logger';

function resolveConfig(manifest: PluginManifest): PluginConfig {
  const config: PluginConfig = {};
  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    const raw = field.env ? process.env[field.env] : undefined;
    const value = raw ?? field.default;
    if (value === undefined || value === '') {
      if (field.required) {
        throw new Error(`Plugin ${manifest.id}: ${field.env ?? key} is required`);
      }
      continue;
    }
    config[key] = field.type === 'number'
      ? Number(value)
      : field.type === 'boolean'
        ? value === true || value === 'true'
        : String(value);
  }
  return config;
}

export class PluginRegistry {
  private plugins = new Map<string, ProviderPlugin>();
  private enabledStates = new Map<string, boolean>();
  private manifests = new Map<string, PluginManifest>();

  register(plugin: ProviderPlugin, enabled = true): void {
    this.plugins.set(plugin.id, plugin);
    this.enabledStates.set(plugin.id, enabled);
    logger.info(`[PluginRegistry] Registered plugin: ${plugin.id} (${plugin.displayName}) [enabled=${enabled}]`);
  }

  unregister(pluginId: string): boolean {
    this.enabledStates.delete(pluginId);
    this.manifests.delete(pluginId);
    return this.plugins.delete(pluginId);
  }

  /** Load every manifest in a directory, importing each adapter by path. */
  async loadManifestsFrom(directory: string): Promise<ProviderPlugin[]> {
    const files = readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
    const loaded: ProviderPlugin[] = [];
    for (const file of files) {
      const manifest = JSON.parse(readFileSync(join(directory, file), 'utf8')) as PluginManifest;
      if (!manifest.id || !manifest.displayName || !manifest.adapter) {
        throw new Error(`Invalid plugin manifest: ${file}`);
      }
      const modulePath = resolve(directory, manifest.adapter);
      const adapter = await import(pathToFileURL(modulePath).href);
      const factoryName = manifest.factory ?? 'createPlugin';
      const factory = adapter[factoryName];
      if (typeof factory !== 'function') {
        throw new Error(`Plugin ${manifest.id}: ${factoryName} is not exported by ${manifest.adapter}`);
      }
      const plugin = await factory(resolveConfig(manifest)) as ProviderPlugin;
      if (!plugin || plugin.id !== manifest.id) {
        throw new Error(`Plugin ${manifest.id}: adapter returned a mismatched plugin`);
      }
      for (const hook of manifest.lifecycle?.hooks ?? []) {
        if (typeof (plugin as any)[hook] !== 'function') {
          throw new Error(`Plugin ${manifest.id}: lifecycle hook ${hook} declared but not implemented`);
        }
      }
      this.manifests.set(plugin.id, manifest);
      this.register(plugin, manifest.enabled !== false);
      loaded.push(plugin);
    }
    return loaded;
  }

  getManifest(pluginId: string): PluginManifest | undefined {
    return this.manifests.get(pluginId);
  }

  getLifecycleHooks(pluginId: string): readonly PluginLifecycleHook[] {
    return this.manifests.get(pluginId)?.lifecycle?.hooks ?? [];
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

    // 3. Manifest-declared prefixes and models (no adapter catalog call needed)
    for (const plugin of enabled) {
      const manifest = this.manifests.get(plugin.id);
      if (manifest?.modelPrefixes?.some((prefix) => modelId.startsWith(prefix))) return plugin;
      if (manifest?.models?.some((model) => (typeof model === 'string' ? model : model.id) === modelId)) {
        return plugin;
      }
    }

    // 4. Catalog scan across enabled plugins
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
