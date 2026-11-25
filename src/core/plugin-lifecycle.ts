import type { ProviderPlugin } from './types/plugin';
import type { PluginLifecycleHook } from './types/plugin-manifest';

export interface PluginLifecycleContext {
  dataDir: string;
  logger: unknown;
}

export interface ManifestLifecycleRegistry {
  getEnabled(): ProviderPlugin[];
  getLifecycleHooks(pluginId: string): readonly PluginLifecycleHook[];
}

/** Server startup: initialize plugins in registration order. When a manifest
 *  supplies hook metadata, only declared hooks are invoked. */
export async function initializePlugins(
  plugins: ProviderPlugin[],
  context: PluginLifecycleContext,
  hooksFor?: (pluginId: string) => readonly PluginLifecycleHook[]
): Promise<void> {
  for (const plugin of plugins) {
    if (hooksFor && !hooksFor(plugin.id).includes('initialize')) continue;
    if (plugin.initialize) await plugin.initialize(context);
  }
}

/** Server shutdown: release plugins in reverse registration order. */
export async function shutdownPlugins(
  plugins: ProviderPlugin[],
  hooksFor?: (pluginId: string) => readonly PluginLifecycleHook[]
): Promise<void> {
  for (const plugin of [...plugins].reverse()) {
    if (hooksFor && !hooksFor(plugin.id).includes('shutdown')) continue;
    if (plugin.shutdown) await plugin.shutdown();
  }
}

/** Entrypoint lifecycle driven by plugin manifests rather than raw plugins. */
export async function initializeFromManifest(
  registry: ManifestLifecycleRegistry,
  context: PluginLifecycleContext
): Promise<void> {
  await initializePlugins(registry.getEnabled(), context, (id) => registry.getLifecycleHooks(id));
}

export async function shutdownFromManifest(registry: ManifestLifecycleRegistry): Promise<void> {
  await shutdownPlugins(registry.getEnabled(), (id) => registry.getLifecycleHooks(id));
}
