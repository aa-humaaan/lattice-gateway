import { describe, expect, test } from 'bun:test';
import { runConformanceFixture, type ConformanceFixture } from '../../src/conformance/runner';

const fixture: ConformanceFixture = {
  name: 'chat-basic', dialect: 'openai-chat',
  request: { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
  canonicalExpect: { 'model': 'test', 'messages.0.role': 'user', 'messages.0.content': 'hello' },
  response: {
    id: 'resp_1', model: 'test', created: 1,
    content: [{ type: 'text', text: 'world' }], stopReason: 'stop',
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
  },
  responseExpect: { 'choices.0.message.content': 'world', 'choices.0.finish_reason': 'stop', 'usage.total_tokens': 3 },
};

describe('dialect conformance runner', () => {
  test('runs literal semantic path expectations through real dialect code', async () => {
    const result = await runConformanceFixture(fixture);
    expect(result.passed).toBeTrue();
    expect(result.failures).toEqual([]);
  });

  test('reports stage, path, expected and actual for a wrong expectation', async () => {
    const broken = structuredClone(fixture);
    broken.responseExpect['usage.total_tokens'] = 99;
    const result = await runConformanceFixture(broken);
    expect(result.passed).toBeFalse();
    expect(result.failures[0]).toEqual({ stage: 'response', path: 'usage.total_tokens', expected: 99, actual: 3 });
  });

  test('rejects malformed fixture objects instead of skipping them', async () => {
    await expect(runConformanceFixture({ name: 'bad' } as any)).rejects.toThrow(/dialect/);
  });
});
