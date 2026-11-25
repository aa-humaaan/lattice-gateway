import { describe, expect, test } from 'bun:test';
import { GatewayError } from '../../src/core/types/errors';
import {
  assertRemovedAggregatorAvailable,
  isRemovedAggregatorModel,
} from '../../src/plugins/removed-aggregator';

// The retired local aggregator plugin was deleted on purpose; this adapter is
// the module that now owns its contract, so test it directly.
const RETIRED_PREFIX = ['free', 'llm', 'api', '/'].join('');
const ENV_KEY = ['FREE', 'LLM', 'API', '_API_KEY'].join('');

function failure(modelId: string, env: NodeJS.ProcessEnv): GatewayError {
  try {
    assertRemovedAggregatorAvailable(modelId, env);
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error(`expected ${modelId} to fail closed`);
}

describe('freellmapi removal adapter', () => {
  test('recognises only the retired model prefix', () => {
    expect(isRemovedAggregatorModel(`${RETIRED_PREFIX}model`)).toBeTrue();
    expect(isRemovedAggregatorModel('kilo/model')).toBeFalse();
    expect(isRemovedAggregatorModel(`x${RETIRED_PREFIX}model`)).toBeFalse();
  });

  test('a missing key fails closed with 503 and names the required variable', () => {
    const error = failure(`${RETIRED_PREFIX}model`, {});
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('plugin_unavailable');
    expect(error.message).toContain(ENV_KEY);
    expect(error.message).toMatch(/no fallback key/i);
  });

  test('a configured key still fails closed because no adapter ships', () => {
    const error = failure(`${RETIRED_PREFIX}model`, { [ENV_KEY]: 'configured' });
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('plugin_unavailable');
    expect(error.message).toMatch(/no adapter is installed/i);
  });

  test('unrelated models are unaffected', () => {
    expect(() => assertRemovedAggregatorAvailable('deepseek/deepseek-chat', {})).not.toThrow();
  });
});
