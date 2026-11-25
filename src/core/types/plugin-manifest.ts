import type { AuthType, ModelDescriptor, ProviderCapabilities } from './plugin';

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  /** Environment variable that supplies the value when config is assembled. */
  env?: string;
  default?: string | number | boolean;
}

/**
 * Declarative provider description. Together with one adapter file exporting
 * `createPlugin`, this is the entire integration surface for a new provider.
 */
export interface PluginManifest {
  id: string;
  displayName: string;
  description?: string;
  defaultBaseUrl?: string;
  /** Model ID prefixes owned by the provider (e.g. "kilo/"). */
  modelPrefixes?: string[];
  models?: Array<string | ModelDescriptor>;
  capabilities?: ProviderCapabilities;
  supportedAuthTypes?: AuthType[];
  configSchema?: Record<string, PluginConfigField>;
  /** Path to the adapter file, relative to the manifest. */
  adapter: string;
  factory?: string;
  enabled?: boolean;
  /** Hooks the server lifecycle must invoke for this provider. */
  lifecycle?: { hooks?: PluginLifecycleHook[] };
}

export type PluginLifecycleHook = 'initialize' | 'shutdown';

export type PluginConfig = Record<string, string | number | boolean | undefined>;
