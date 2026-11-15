/**
 * Tier 3 Cross-Feature Combinations: Streaming + Tool Calling
 * 
 * Verifies complex interactions between SSE streaming and function tool calling:
 * - Streaming completions with function tools defined and multi-turn tool execution loop
 * - Streaming with both conversational text content and tool calls in same response
 * - Multiple parallel tool calls in a single streaming response (indices 0 and 1)
 * - Tool calling with arguments spanning dozens of tiny streaming deltas
 * - Tool results submission following streaming tool calls in Anthropic dialect
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertToolCallsEmitted,
  assertStreamDone,
  assertAnthropicSuccess,
} from '../../harness/assertions';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class StreamingToolsMockPlugin implements ProviderPlugin {
  readonly id = 'combo-tools';
  readonly displayName = 'Streaming Tools Mock Provider';
  readonly defaultBaseUrl = 'https://combo-tools.lattice.local';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'combo-tools/agent-model',
        name: 'Combo Agent Model',
        providerId: 'combo-tools',
        ownedBy: 'combo-tools',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'Non-streaming response' }],
      stopReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const lastMsg = req.messages[req.messages.length - 1];
    const userPrompt = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : (Array.isArray(lastMsg?.content) ? (lastMsg.content[0] as any)?.text : '');

    const hasToolResult = req.messages.some((m) => m.role === 'tool');

    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };

      if (hasToolResult) {
        // Multi-turn Turn 2: Received tool result, now stream final answer
        yield { type: 'text_delta', delta: 'Based on the tool result, ' };
        yield { type: 'text_delta', delta: 'the current weather in Tokyo is sunny, 18°C.' };
        yield { type: 'usage', usage: { promptTokens: 45, completionTokens: 18, totalTokens: 63 } };
        yield { type: 'stream_end', stopReason: 'stop' };
      } else if (userPrompt.includes('both text and tool')) {
        // Text preceding tool call in same turn
        yield { type: 'text_delta', delta: 'Let me search the files for your query.\n' };
        yield { type: 'tool_call_start', index: 0, id: 'call_search_99', name: 'search_files' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"query": "config"}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      } else if (userPrompt.includes('parallel tool calls')) {
        // Multiple parallel tool calls: index 0 and 1
        yield { type: 'text_delta', delta: 'Invoking two tools simultaneously.\n' };
        // Tool 1
        yield { type: 'tool_call_start', index: 0, id: 'call_par_1', name: 'read_file' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path": "package.json"}' };
        yield { type: 'tool_call_stop', index: 0 };
        // Tool 2
        yield { type: 'tool_call_start', index: 1, id: 'call_par_2', name: 'read_file' };
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{"path": "tsconfig.json"}' };
        yield { type: 'tool_call_stop', index: 1 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      } else if (userPrompt.includes('fragmented args')) {
        // Arguments split into 30 tiny deltas
        const fullJson = JSON.stringify({
          database: 'production',
          query: 'SELECT id, name, email FROM users WHERE active = 1 ORDER BY id DESC',
          limit: 100,
        });
        yield { type: 'tool_call_start', index: 0, id: 'call_frag_1', name: 'query_db' };

        // Slice into 4-character chunks
        for (let i = 0; i < fullJson.length; i += 4) {
          if (signal?.aborted) return;
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: fullJson.slice(i, i + 4) };
        }
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      } else {
        // Turn 1: Default tool call
        yield { type: 'tool_call_start', index: 0, id: 'call_weather_tokyo', name: 'get_weather' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city": "Tokyo"}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }
    })();
  }
}

describe('Tier 3 Combination: Streaming + Function Tool Calling', () => {
  let server: any;
  let plugin: StreamingToolsMockPlugin;
  let client: TestClient;

  beforeAll(async () => {
    plugin = new StreamingToolsMockPlugin();
    const app = createServer({ port: 0 }, [plugin]);
    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${server.port}`);
  });

  afterAll(async () => {
    if (server) {
      server.stop(true);
    }
  });

  // 1. Streaming completions with function tools defined and multi-turn tool execution
  it('completes a full two-turn agent loop: streaming tool call -> client tool execution -> streaming text response', async () => {
    // Turn 1: User request triggering tool call
    const turn1Stream = client.openaiChatStream({
      model: 'combo-tools/agent-model',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });

    const turn1Chunks = await TestClient.collect(turn1Stream);
    assertStreamDone(turn1Chunks);

    const toolCalls = assertToolCallsEmitted(turn1Chunks, 'get_weather');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('get_weather');
    expect(toolCalls[0].arguments).toEqual({ city: 'Tokyo' });

    // Extract tool call id from stream chunks
    const chunkWithId = turn1Chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id);
    const callId = chunkWithId?.choices[0].delta.tool_calls?.[0]?.id || 'call_weather_tokyo';

    // Turn 2: Provide assistant tool call message + tool result message
    const turn2Stream = client.openaiChatStream({
      model: 'combo-tools/agent-model',
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city": "Tokyo"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ temperature: 18, condition: 'sunny' }),
        },
      ],
    });

    const turn2Chunks = await TestClient.collect(turn2Stream);
    assertStreamDone(turn2Chunks);

    const fullAnswer = turn2Chunks
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');

    expect(fullAnswer).toContain('sunny, 18°C');
    const lastChunk = turn2Chunks[turn2Chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('stop');
  });

  // 2. Streaming with both conversational text content and tool calls in same response
  it('streams conversational explanation text preceding tool call in the same response without interference', async () => {
    const stream = client.openaiChatStream({
      model: 'combo-tools/agent-model',
      messages: [{ role: 'user', content: 'both text and tool in one go' }],
      tools: [
        {
          type: 'function',
          function: { name: 'search_files', parameters: { type: 'object' } },
        },
      ],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Verify text content was received
    const textPieces = chunks
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');
    expect(textPieces).toContain('Let me search the files for your query.');

    // Verify tool call was received in same stream
    const toolCalls = assertToolCallsEmitted(chunks, 'search_files');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].arguments).toEqual({ query: 'config' });

    // Verify final finish_reason is tool_calls
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('tool_calls');
  });

  // 3. Multiple parallel tool calls in a single streaming response
  it('streams multiple parallel tool calls and correctly correlates indices 0 and 1', async () => {
    const stream = client.openaiChatStream({
      model: 'combo-tools/agent-model',
      messages: [{ role: 'user', content: 'parallel tool calls please' }],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object' } },
        },
      ],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Accumulate tool calls by index
    const toolMap = new Map<number, { name: string; args: string }>();
    for (const chunk of chunks) {
      const toolDeltas = chunk.choices[0]?.delta?.tool_calls || [];
      for (const td of toolDeltas) {
        if (!toolMap.has(td.index)) {
          toolMap.set(td.index, { name: td.function?.name || '', args: '' });
        }
        const cur = toolMap.get(td.index)!;
        if (td.function?.name) cur.name = td.function.name;
        if (td.function?.arguments) cur.args += td.function.arguments;
      }
    }

    expect(toolMap.size).toBe(2);
    expect(toolMap.get(0)?.name).toBe('read_file');
    expect(JSON.parse(toolMap.get(0)?.args || '{}')).toEqual({ path: 'package.json' });

    expect(toolMap.get(1)?.name).toBe('read_file');
    expect(JSON.parse(toolMap.get(1)?.args || '{}')).toEqual({ path: 'tsconfig.json' });
  });

  // 4. Tool calling with arguments spanning dozens of streaming deltas
  it('reassembles large structured tool arguments fragmented across dozens of SSE delta chunks', async () => {
    const stream = client.openaiChatStream({
      model: 'combo-tools/agent-model',
      messages: [{ role: 'user', content: 'fragmented args test' }],
      tools: [
        {
          type: 'function',
          function: { name: 'query_db', parameters: { type: 'object' } },
        },
      ],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Verify arguments reassembled accurately
    const toolCalls = assertToolCallsEmitted(chunks, 'query_db');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('query_db');
    expect(toolCalls[0].arguments).toEqual({
      database: 'production',
      query: 'SELECT id, name, email FROM users WHERE active = 1 ORDER BY id DESC',
      limit: 100,
    });
  });

  // 5. Tool execution in Anthropic dialect with tool_use and tool_result blocks
  it('executes tool calling workflow seamlessly using Anthropic dialect', async () => {
    // Anthropic tool execution turn
    const res = await client.anthropicMessages({
      model: 'combo-tools/agent-model',
      messages: [
        { role: 'user', content: 'What is Tokyo weather?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_call_tokyo_1',
              name: 'get_weather',
              input: { city: 'Tokyo' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_call_tokyo_1',
              content: '{"temp": 18, "condition": "sunny"}',
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);
    expect(body.role).toBe('assistant');
  });
});
