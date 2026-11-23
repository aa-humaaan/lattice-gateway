import { describe, expect, test } from 'bun:test';
import { normalizeAnthropicMessages, normalizeOpenAIChat } from '../../src/engine/dialect/normalizer';
import { serializeAnthropicRequestMessages } from '../../src/engine/dialect/serializer';

describe('P1-4 cache_control round trip', () => {
  test('Anthropic cache_control survives normalize then serialize', () => {
    const canonical = normalizeAnthropicMessages(
      {
        model: 'claude-test',
        max_tokens: 32,
        system: [{ type: 'text', text: 'cached system', cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
              { type: 'text', text: 'not cached' },
            ],
          },
        ],
      },
      'trace_cache_1'
    );

    const userParts = canonical.messages[0].content;
    expect(Array.isArray(userParts)).toBe(true);
    expect((userParts as any[])[0].cacheControl).toEqual({ type: 'ephemeral' });
    expect((userParts as any[])[1].cacheControl).toBeUndefined();

    const roundTrip = serializeAnthropicRequestMessages(
      canonical.messages,
      canonical.systemPrompt,
      canonical.systemContent
    );
    const content = roundTrip.messages[0].content as any[];
    expect(content[0]).toEqual({
      type: 'text',
      text: 'hello',
      cache_control: { type: 'ephemeral' },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'not cached' });
    expect((roundTrip.system?.[0] as any)?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('OpenAI text parts with cache_control are carried into canonical content', () => {
    const canonical = normalizeOpenAIChat(
      {
        model: 'openai-test',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }],
          },
        ],
      },
      'trace_cache_2'
    );
    const parts = canonical.messages[0].content as any[];
    expect(parts[0].cacheControl).toEqual({ type: 'ephemeral' });
  });
});
