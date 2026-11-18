import { describe, it, expect } from 'bun:test';
import {
  serializeOpenAIChat,
  serializeAnthropicMessage,
  serializeOpenAIResponse,
  serializeOpenAIMessages,
} from '../../src/engine/dialect/serializer';
import { CanonicalResponse, CanonicalMessage } from '../../src/core/types/canonical';

describe('Outbound Dialect Serializer', () => {
  it('S1: Serialize CanonicalResponse to OpenAI Chat JSON', () => {
    const res: CanonicalResponse = {
      id: 'resp_test_1',
      model: 'gpt-4',
      created: 1731693600,
      content: [{ type: 'text', text: 'Hello, how can I help you?' }],
      stopReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
    };

    const out = serializeOpenAIChat(res);
    expect(out.id).toBe('resp_test_1');
    expect(out.object).toBe('chat.completion');
    expect(out.model).toBe('gpt-4');
    expect(out.choices[0].message.content).toBe('Hello, how can I help you?');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage.prompt_tokens).toBe(10);
    expect(out.usage.completion_tokens).toBe(15);
    expect(out.usage.total_tokens).toBe(25);
  });

  it('S2: Serialize CanonicalResponse with reasoning_content', () => {
    const res: CanonicalResponse = {
      id: 'resp_test_2',
      model: 'deepseek-r1',
      created: 1731693600,
      content: [
        { type: 'thinking', thinking: '1. Break down into factors\n2. Multiply' },
        { type: 'text', text: 'The answer is 42.' },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50, reasoningTokens: 15 },
    };

    const out = serializeOpenAIChat(res);
    expect(out.choices[0].message.reasoning_content).toBe('1. Break down into factors\n2. Multiply');
    expect(out.choices[0].message.content).toBe('The answer is 42.');
    expect(out.usage.completion_tokens_details?.reasoning_tokens).toBe(15);
  });

  it('S3: Serialize CanonicalResponse with tool_calls', () => {
    const res: CanonicalResponse = {
      id: 'resp_test_3',
      model: 'gpt-4',
      created: 1731693600,
      content: [
        {
          type: 'tool_use',
          id: 'call_abc',
          name: 'get_stock_price',
          input: { ticker: 'AAPL' },
        },
      ],
      stopReason: 'tool_calls',
      usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
    };

    const out = serializeOpenAIChat(res);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls?.length).toBe(1);
    const tc = out.choices[0].message.tool_calls![0];
    expect(tc.id).toBe('call_abc');
    expect(tc.function.name).toBe('get_stock_price');
    expect(JSON.parse(tc.function.arguments)).toEqual({ ticker: 'AAPL' });
  });

  it('S4: Serialize CanonicalResponse to Anthropic Message JSON', () => {
    const res: CanonicalResponse = {
      id: 'msg_test_4',
      model: 'claude-3-7-sonnet',
      created: 1731693600,
      content: [
        { type: 'thinking', thinking: 'Analyzing the request.', signature: 'sig_valid' },
        { type: 'text', text: 'Final conclusion reached.' },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 30, completionTokens: 40, totalTokens: 70 },
    };

    const out = serializeAnthropicMessage(res);
    expect(out.id).toBe('msg_test_4');
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.model).toBe('claude-3-7-sonnet');
    expect(out.content.length).toBe(2);
    expect(out.content[0].type).toBe('thinking');
    expect((out.content[0] as any).thinking).toBe('Analyzing the request.');
    expect((out.content[0] as any).signature).toBe('sig_valid');
    expect(out.content[1].type).toBe('text');
    expect((out.content[1] as any).text).toBe('Final conclusion reached.');
    expect(out.stop_reason).toBe('end_turn');
  });

  it('S5: Serialize Anthropic tool_use stop_reason', () => {
    const res: CanonicalResponse = {
      id: 'msg_test_5',
      model: 'claude-3-7-sonnet',
      created: 1731693600,
      content: [
        {
          type: 'tool_use',
          id: 'tool_123',
          name: 'bash',
          input: { command: 'pwd' },
        },
      ],
      stopReason: 'tool_calls',
      usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
    };

    const out = serializeAnthropicMessage(res);
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content[0].type).toBe('tool_use');
    expect((out.content[0] as any).name).toBe('bash');
  });

  it('S6: Serialize CanonicalResponse to OpenAI Responses JSON', () => {
    const res: CanonicalResponse = {
      id: 'resp_obj_6',
      model: 'gpt-4o',
      created: 1731693600,
      content: [
        { type: 'text', text: 'Agent output step.' },
        {
          type: 'tool_use',
          id: 'call_agent_step',
          name: 'browse',
          input: { url: 'https://example.com' },
        },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
    };

    const out = serializeOpenAIResponse(res);
    expect(out.id).toBe('resp_obj_6');
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.output.length).toBe(2);
    expect(out.output[0].type).toBe('message');
    expect(out.output[1].type).toBe('function_call');
    expect((out.output[1] as any).name).toBe('browse');
  });

  it('S7: Serialize Anthropic multi-turn messages with tool_result into OpenAI tool messages', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'user',
        content: 'Check gitignore',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bash_01',
            name: 'Bash',
            input: { command: 'cat .gitignore' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'toolu_bash_01',
            content: 'node_modules\nlattice.exe\n',
          },
        ],
      },
    ];

    const openAIMsgs = serializeOpenAIMessages(messages);
    expect(openAIMsgs.length).toBe(3);

    // Turn 1
    expect(openAIMsgs[0].role).toBe('user');
    expect(openAIMsgs[0].content).toBe('Check gitignore');

    // Turn 2: Assistant tool call
    expect(openAIMsgs[1].role).toBe('assistant');
    expect(openAIMsgs[1].tool_calls?.length).toBe(1);
    expect(openAIMsgs[1].tool_calls[0].id).toBe('toolu_bash_01');
    expect(openAIMsgs[1].tool_calls[0].function.name).toBe('Bash');
    expect(openAIMsgs[1].tool_calls[0].function.arguments).toBe('{"command":"cat .gitignore"}');

    // Turn 3: Anthropic user tool_result converted to OpenAI tool message
    expect(openAIMsgs[2].role).toBe('tool');
    expect(openAIMsgs[2].tool_call_id).toBe('toolu_bash_01');
    expect(openAIMsgs[2].content).toBe('node_modules\nlattice.exe\n');
  });

  it('S8: Serialize user message containing both tool_result and user text', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'toolu_probe_02',
            content: '{"status":"ok"}',
          },
          {
            type: 'text',
            text: 'Here is the probe result, please continue with the analysis.',
          },
        ],
      },
    ];

    const openAIMsgs = serializeOpenAIMessages(messages);
    expect(openAIMsgs.length).toBe(2);

    // First: tool response
    expect(openAIMsgs[0].role).toBe('tool');
    expect(openAIMsgs[0].tool_call_id).toBe('toolu_probe_02');
    expect(openAIMsgs[0].content).toBe('{"status":"ok"}');

    // Second: trailing user text
    expect(openAIMsgs[1].role).toBe('user');
    expect(openAIMsgs[1].content).toBe('Here is the probe result, please continue with the analysis.');
  });
});
