/**
 * Tier 3 Cross-Feature Combinations: Thinking Tokens + Tool Calling
 * 
 * Verifies complex interactions when both reasoning/thinking models and tool use are combined:
 * - Anthropic dialect with extended thinking enabled (thinking.budget_tokens) AND tool definitions
 * - Chronological ordering: thinking_delta events arrive strictly before tool_use content blocks
 * - Tri-phase streaming: Thinking block -> conversational text block -> tool_use block
 * - OpenAI reasoning_content stream deltas combined with delta.tool_calls in OpenAI dialect
 * - Preservation of thinking blocks in assistant history across multi-turn conversation turns
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertThinkingContent,
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

class ThinkingToolsMockPlugin implements ProviderPlugin {
  readonly id = 'combo-thinking';
  readonly displayName = 'Thinking & Tools Mock Provider';
  readonly defaultBaseUrl = 'https://thinking-tools.lattice.local';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'combo-thinking/hybrid-model',
        name: 'Hybrid Thinking Tools Model',
        providerId: 'combo-thinking',
        ownedBy: 'combo-thinking',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const hasHistoryThinking = req.messages.some(
      (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'thinking')
    );

    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [
        { type: 'thinking', thinking: 'Analyzing prior thinking context thoroughly.', signature: 'sig_mock_history' },
        { type: 'text', text: hasHistoryThinking ? 'History thinking preserved successfully!' : 'Fresh thinking response' },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 30, completionTokens: 25, totalTokens: 55, reasoningTokens: 15 },
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

    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };

      if (userPrompt.includes('tri-phase')) {
        // Phase 1: Thinking block
        yield { type: 'thinking_delta', delta: 'Phase 1: Deep reasoning about code architecture... ' };
        yield { type: 'thinking_delta', delta: 'Deciding which tool to invoke.', signature: 'sig_tri_phase' };
        // Phase 2: Conversational text block
        yield { type: 'text_delta', delta: 'Phase 2: I am now calling the linting tool.\n' };
        // Phase 3: Tool use block
        yield { type: 'tool_call_start', index: 0, id: 'call_lint_1', name: 'run_linter' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"fix": true}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      } else if (userPrompt.includes('openai-reasoning-tools')) {
        // OpenAI dialect stream with reasoning_content and tool_calls
        yield { type: 'thinking_delta', delta: 'Step 1: Calculate parameters mathematically. ' };
        yield { type: 'thinking_delta', delta: 'Step 2: Format JSON tool arguments.' };
        yield { type: 'tool_call_start', index: 0, id: 'call_math_1', name: 'compute_factorial' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"n": 10}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      } else {
        // Standard thinking + tool use
        yield { type: 'thinking_delta', delta: 'First, I will think about how to search the docs. ' };
        yield { type: 'thinking_delta', delta: 'Search query should be "hybrid streaming".' };
        yield { type: 'tool_call_start', index: 0, id: 'call_doc_search_1', name: 'search_docs' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"query": "hybrid streaming"}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }
    })();
  }
}

describe('Tier 3 Combination: Thinking Tokens + Function Tools', () => {
  let server: any;
  let plugin: ThinkingToolsMockPlugin;
  let client: TestClient;

  beforeAll(async () => {
    plugin = new ThinkingToolsMockPlugin();
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

  // 1. Anthropic dialect with extended thinking enabled AND tool definitions
  it('streams both thinking blocks and tool_use blocks in Anthropic dialect when thinking is enabled', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'combo-thinking/hybrid-model',
      messages: [{ role: 'user', content: 'Search docs with extended thinking' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      tools: [
        {
          name: 'search_docs',
          description: 'Search documentation',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    });

    const events = await TestClient.collect(stream);
    expect(events.length).toBeGreaterThan(0);

    // Verify thinking block was emitted
    const thinkingDeltas = events
      .filter((e) => e.data.type === 'content_block_delta' && e.data.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta?.thinking)
      .join('');
    expect(thinkingDeltas).toContain('First, I will think about how to search the docs.');

    // Verify tool_use block was emitted
    const toolBlockStart = events.find(
      (e) => e.data.type === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    );
    expect(toolBlockStart).toBeDefined();
    expect(toolBlockStart?.data.content_block?.name).toBe('search_docs');
  });

  // 2. Chronological ordering: thinking_delta events arrive strictly before tool_use content blocks
  it('guarantees that all thinking content blocks strictly precede tool_use blocks in the event stream', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'combo-thinking/hybrid-model',
      messages: [{ role: 'user', content: 'Verify chronological event sequence' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: [{ name: 'search_docs', input_schema: { type: 'object' } }],
    });

    const events = await TestClient.collect(stream);

    let lastThinkingEventIndex = -1;
    let firstToolUseEventIndex = -1;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.data.type === 'content_block_delta' && ev.data.delta?.type === 'thinking_delta') {
        lastThinkingEventIndex = i;
      }
      if (ev.data.type === 'content_block_start' && ev.data.content_block?.type === 'tool_use') {
        if (firstToolUseEventIndex === -1) {
          firstToolUseEventIndex = i;
        }
      }
    }

    expect(lastThinkingEventIndex).toBeGreaterThan(-1);
    expect(firstToolUseEventIndex).toBeGreaterThan(-1);
    // Strict order: thinking MUST complete before tool_use begins
    expect(lastThinkingEventIndex).toBeLessThan(firstToolUseEventIndex);
  });

  // 3. Tri-phase streaming: Thinking block -> conversational text block -> tool_use block
  it('handles tri-phase streaming: thinking reasoning followed by conversational text followed by tool call', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'combo-thinking/hybrid-model',
      messages: [{ role: 'user', content: 'tri-phase execution please' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: [{ name: 'run_linter', input_schema: { type: 'object' } }],
    });

    const events = await TestClient.collect(stream);

    // Phase 1: Thinking
    const thinkingPieces = events
      .filter((e) => e.data.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta?.thinking)
      .join('');
    expect(thinkingPieces).toContain('Phase 1: Deep reasoning');

    // Phase 2: Text
    const textPieces = events
      .filter((e) => e.data.delta?.type === 'text_delta')
      .map((e) => e.data.delta?.text)
      .join('');
    expect(textPieces).toContain('Phase 2: I am now calling the linting tool.');

    // Phase 3: Tool Use
    const toolStart = events.find(
      (e) => e.data.type === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeDefined();
    expect(toolStart?.data.content_block?.name).toBe('run_linter');
  });

  // 4. OpenAI reasoning_content stream deltas combined with delta.tool_calls in OpenAI dialect
  it('streams both reasoning_content and tool_calls in OpenAI dialect without field collisions', async () => {
    const stream = client.openaiChatStream({
      model: 'combo-thinking/hybrid-model',
      messages: [{ role: 'user', content: 'openai-reasoning-tools stream test' }],
      tools: [
        {
          type: 'function',
          function: { name: 'compute_factorial', parameters: { type: 'object' } },
        },
      ],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Verify thinking content via domain matcher
    const thinkingText = assertThinkingContent(chunks);
    expect(thinkingText).toContain('Step 1: Calculate parameters mathematically.');
    expect(thinkingText).toContain('Step 2: Format JSON tool arguments.');

    // Verify tool calls via domain matcher
    const tools = assertToolCallsEmitted(chunks, 'compute_factorial');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('compute_factorial');
    expect(tools[0].arguments).toEqual({ n: 10 });

    // Verify finish_reason is tool_calls
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('tool_calls');
  });

  // 5. Thinking token preservation across multi-turn conversation turns
  it('preserves past assistant thinking blocks across multi-turn requests in Anthropic dialect', async () => {
    const res = await client.anthropicMessages({
      model: 'combo-thinking/hybrid-model',
      messages: [
        { role: 'user', content: 'Initial question' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Past turn reasoning history preserved here.',
              signature: 'sig_past_turn',
            } as any,
            {
              type: 'text',
              text: 'Initial answer from past turn.',
            },
          ],
        },
        { role: 'user', content: 'Follow-up question with history' },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);

    const textContent = body.content.find((b: any) => b.type === 'text');
    expect(textContent?.text).toContain('History thinking preserved successfully!');
  });
});
