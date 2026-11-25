import { OpenCodeProviderPlugin } from '../opencode';
import type { ProviderPlugin } from '../../core/types/plugin';

/** Manifest adapter for the OpenCode Zen provider (first migrated plugin). */
export function createPlugin(config: { baseUrl?: string } = {}): ProviderPlugin {
  return new OpenCodeProviderPlugin(config.baseUrl);
}
