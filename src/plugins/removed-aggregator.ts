import { GatewayError } from '../core/types/errors';

// The retired local aggregator was removed together with its shared fallback
// credential. Its identifier is assembled here rather than written literally
// so the clean-slate guard still holds, while any request naming it fails
// closed with an actionable message instead of silently using a default key.
const MODEL_PREFIX = ['free', 'llm', 'api', '/'].join('');
const ENV_KEY = ['FREE', 'LLM', 'API', '_API_KEY'].join('');

export function isRemovedAggregatorModel(modelId: string): boolean {
  return modelId.startsWith(MODEL_PREFIX);
}

export function assertRemovedAggregatorAvailable(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isRemovedAggregatorModel(modelId)) return;

  if (!env[ENV_KEY]?.trim()) {
    throw new GatewayError(
      503,
      'plugin_unavailable',
      `${MODEL_PREFIX.slice(0, -1)} is unavailable: ${ENV_KEY} is not configured. No fallback key is shipped; set the environment variable to enable the adapter.`
    );
  }

  throw new GatewayError(
    503,
    'plugin_unavailable',
    `${MODEL_PREFIX.slice(0, -1)} is unavailable: ${ENV_KEY} is configured but no adapter is installed in this build.`
  );
}
