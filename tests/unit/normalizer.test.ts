import { describe, it, expect } from 'bun:test';
import {
  normalizeOpenAIChat,
  normalizeAnthropicMessages,
  normalizeOpenAIResponses,
} from '../../src/engine/dialect/normalizer';
import { GatewayError } from '../../src/core/types/errors';

describe('Inbound Dialect Normalizer', () => {
  it('N1: OpenAI standard chat normalizes correctly', () => {
    const input = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const canonical = normalizeOpenAIChat(input);
    expect(canonical.clientDialect).toBe('openai-chat');
    expect(canonical.model).toBe('gpt-4');
    expect(canonical.messages.length).toBe(1);
    expect(canonical.messages[0].role).toBe('user');
    expect(canonical.messages[0].content).toBe('hi');
    expect(canonical.stream).toBe(false);
  });

  it('N2: OpenAI system message extraction', () => {
    const input = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
    };
    const canonical = normalizeOpenAIChat(input);
    expect(canonical.systemPrompt).toBe('You are helpful.');
    expect(canonical.messages.length).toBe(2);
  });

  it('N3: OpenAI reasoning_effort mapping', () => {
    const input = {
      model: 'o1',
      messages: [{ role: 'user', content: 'Solve this puzzle' }],
      reasoning_effort: 'high' as const,
    };
    const canonical = normalizeOpenAIChat(input);
    expect(canonical.thinking?.type).toBe('enabled');
    expect(canonical.reasoningEffort).toBe('high');
  });

  it('N4: OpenAI tool calls and tool results', () => {
    const input = {
      model: 'gpt-4',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '72F and sunny',
        },
      ],
    };
    const canonical = normalizeOpenAIChat(input);
    expect(canonical.messages.length).toBe(2);

    const assistantMsg = canonical.messages[0];
    expect(assistantMsg.role).toBe('assistant');
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const toolUsePart = (assistantMsg.content as any[])[0];
    expect(toolUsePart.type).toBe('tool_use');
    expect(toolUsePart.id).toBe('call_1');
    expect(toolUsePart.name).toBe('get_weather');
    expect(toolUsePart.input).toEqual({ city: 'NYC' });

    const toolMsg = canonical.messages[1];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.toolCallId).toBe('call_1');
    expect(Array.isArray(toolMsg.content)).toBe(true);
    const toolResultPart = (toolMsg.content as any[])[0];
    expect(toolResultPart.type).toBe('tool_result');
    expect(toolResultPart.toolCallId).toBe('call_1');
    expect(toolResultPart.content).toBe('72F and sunny');
  });

  it('N5: Anthropic system string normalization', () => {
    const input = {
      model: 'claude-3-7-sonnet',
      system: 'Act as architect.',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    };
    const canonical = normalizeAnthropicMessages(input);
    expect(canonical.clientDialect).toBe('anthropic-messages');
    expect(canonical.model).toBe('claude-3-7-sonnet');
    expect(canonical.systemPrompt).toBe('Act as architect.');
  });

  it('N6: Anthropic thinking budget normalization', () => {
    const input = {
      model: 'claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Explain quantum computing' }],
      thinking: { type: 'enabled' as const, budget_tokens: 4096 },
      max_tokens: 8192,
    };
    const canonical = normalizeAnthropicMessages(input);
    expect(canonical.thinking?.type).toBe('enabled');
    expect(canonical.thinking?.budgetTokens).toBe(4096);
    expect(canonical.reasoningEffort).toBe('medium');
  });

  it('N7: Anthropic same-role adjacent message merging', () => {
    const input = {
      model: 'claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
      ],
      max_tokens: 1000,
    };
    const canonical = normalizeAnthropicMessages(input);
    expect(canonical.messages.length).toBe(1);
    expect(canonical.messages[0].role).toBe('user');
    expect(typeof canonical.messages[0].content).toBe('string');
    expect(canonical.messages[0].content).toContain('A');
    expect(canonical.messages[0].content).toContain('B');
  });

  it('N8: Anthropic content blocks with thinking and signature', () => {
    const input = {
      model: 'claude-3-7-sonnet',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think deeply...', signature: 'sig_proof_123' },
            { type: 'text', text: 'Here is the response.' },
          ],
        },
      ],
      max_tokens: 2000,
    };
    const canonical = normalizeAnthropicMessages(input);
    expect(canonical.messages.length).toBe(2);
    const assistantMsg = canonical.messages[1];
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const parts = assistantMsg.content as any[];
    expect(parts[0].type).toBe('thinking');
    expect(parts[0].thinking).toBe('Let me think deeply...');
    expect(parts[0].signature).toBe('sig_proof_123');
    expect(parts[1].type).toBe('text');
    expect(parts[1].text).toBe('Here is the response.');
  });

  it('N9: OpenAI Responses input normalization', () => {
    const input = {
      model: 'gpt-4o',
      input: 'Generate code.',
    };
    const canonical = normalizeOpenAIResponses(input);
    expect(canonical.clientDialect).toBe('openai-responses');
    expect(canonical.model).toBe('gpt-4o');
    expect(canonical.messages.length).toBe(1);
    expect(canonical.messages[0].content).toBe('Generate code.');
  });

  it('N10: Invalid payload rejection throws GatewayError with 400 status', () => {
    expect(() => normalizeOpenAIChat({})).toThrow();
    try {
      normalizeOpenAIChat({});
    } catch (err) {
      expect(err instanceof GatewayError).toBe(true);
      expect((err as GatewayError).statusCode).toBe(400);
    }

    try {
      normalizeAnthropicMessages({});
    } catch (err) {
      expect(err instanceof GatewayError).toBe(true);
      expect((err as GatewayError).statusCode).toBe(400);
    }
  });
});
