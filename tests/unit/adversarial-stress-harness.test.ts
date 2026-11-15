import { describe, it, expect } from 'bun:test';
import {
  createAnthropicSSEStream,
  createOpenAISSEStream,
} from '../../src/engine/dialect/stream-adapter';
import {
  applyXMLToolInterceptor,
} from '../../src/engine/dialect/xml-tool-interceptor';
import { CanonicalStreamEvent } from '../../src/core/types/canonical';

interface ParsedAnthropicEvent {
  event: string;
  data: any;
}

async function collectAnthropicEvents(
  stream: ReadableStream<Uint8Array>
): Promise<ParsedAnthropicEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: ParsedAnthropicEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // skip comments / pings

      const lines = trimmed.split('\n');
      let eventType = '';
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataStr = line.slice(6).trim();
        }
      }

      if (eventType && dataStr) {
        events.push({
          event: eventType,
          data: JSON.parse(dataStr),
        });
      }
    }
  }

  return events;
}

async function collectOpenAIRawChunks(
  stream: ReadableStream<Uint8Array>
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) {
        chunks.push(trimmed);
      }
    }
  }

  return chunks;
}

describe('Empirical Challenger: Adversarial Stress Harness', () => {
  // =========================================================================
  // 1. Rapid Token Bursts & High-Throughput Stress Testing
  // =========================================================================
  describe('Rapid Token Bursts & High-Throughput Stress', () => {
    it('BURST-1: 5,000 rapid text deltas streamed without loss, corruption, or index drift', async () => {
      const tokenCount = 5000;
      async function* generateBurst(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_burst_5k', model: 'claude-3-7-sonnet', created: 1731693600 };
        for (let i = 0; i < tokenCount; i++) {
          yield { type: 'text_delta', delta: `t${i}_` };
        }
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const stream = createAnthropicSSEStream(generateBurst());
      const events = await collectAnthropicEvents(stream);

      // Verify sequence framing
      expect(events[0].event).toBe('message_start');
      expect(events[1].event).toBe('content_block_start');
      expect(events[1].data.index).toBe(0);
      expect(events[1].data.content_block.type).toBe('text');

      // Verify all 5000 deltas arrived at index 0
      const deltas = events.filter((e) => e.event === 'content_block_delta');
      expect(deltas.length).toBe(tokenCount);
      for (let i = 0; i < tokenCount; i++) {
        expect(deltas[i].data.index).toBe(0);
        expect(deltas[i].data.delta.type).toBe('text_delta');
      }

      // Verify closing
      expect(events[events.length - 3].event).toBe('content_block_stop');
      expect(events[events.length - 3].data.index).toBe(0);
      expect(events[events.length - 2].event).toBe('message_delta');
      expect(events[events.length - 1].event).toBe('message_stop');
    });

    it('BURST-2: Rapid alternating thinking and text deltas burst stress', async () => {
      const burstRounds = 500;
      async function* generateAlternating(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_burst_alt', model: 'claude-3-7-sonnet', created: 1731693600 };
        // Initial thinking burst (valid at index 0)
        for (let i = 0; i < 50; i++) {
          yield { type: 'thinking_delta', delta: `think_${i} ` };
        }
        // First transition to text (triggers hasNonThinkingStarted = true)
        yield { type: 'text_delta', delta: 'Initial text. ' };
        // Now rapid adversarial interleaving of thinking and text
        for (let i = 0; i < burstRounds; i++) {
          yield { type: 'thinking_delta', delta: `adv_think_${i} ` };
          yield { type: 'text_delta', delta: `text_${i} ` };
        }
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const stream = createAnthropicSSEStream(generateAlternating());
      const events = await collectAnthropicEvents(stream);

      // Invariant Check 1: EXACTLY ONE content_block_start of type 'thinking' at index 0
      const thinkingStarts = events.filter(
        (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking'
      );
      expect(thinkingStarts.length).toBe(1);
      expect(thinkingStarts[0].data.index).toBe(0);

      // Invariant Check 2: ZERO thinking_delta events emitted after block 0 closed
      const nonBlock0ThinkingDeltas = events.filter(
        (e) => e.event === 'content_block_delta' && e.data.index !== 0 && e.data.delta?.type === 'thinking_delta'
      );
      expect(nonBlock0ThinkingDeltas.length).toBe(0);

      // Invariant Check 3: All adversarial thinking deltas were converted to text_delta
      const textBlockStarts = events.filter(
        (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'text'
      );
      expect(textBlockStarts.length).toBe(1); // Since text block remained active, all merged cleanly
      expect(textBlockStarts[0].data.index).toBe(1);
    });

    it('BURST-3: 50 concurrent SSE streams executed in parallel without crosstalk', async () => {
      const concurrency = 50;
      const tasks = Array.from({ length: concurrency }, async (_, idx) => {
        async function* gen(): AsyncIterable<CanonicalStreamEvent> {
          yield { type: 'stream_start', id: `msg_conc_${idx}`, model: 'claude-3-5', created: 1731693600 };
          yield { type: 'text_delta', delta: `chunk_a_${idx}` };
          yield { type: 'text_delta', delta: `chunk_b_${idx}` };
          yield { type: 'stream_end', stopReason: 'stop' };
        }

        const events = await collectAnthropicEvents(createAnthropicSSEStream(gen()));
        expect(events[0].data.message.id).toBe(`msg_conc_${idx}`);
        expect(events[1].data.index).toBe(0);
        expect(events[2].data.delta.text).toBe(`chunk_a_${idx}`);
        expect(events[3].data.delta.text).toBe(`chunk_b_${idx}`);
        expect(events[4].data.index).toBe(0);
        expect(events[5].data.delta.stop_reason).toBe('end_turn');
        return true;
      });

      const results = await Promise.all(tasks);
      expect(results.length).toBe(concurrency);
      expect(results.every(Boolean)).toBe(true);
    });
  });

  // =========================================================================
  // 2. Out-of-Order Delta Injections & Adversarial Edge Sequences
  // =========================================================================
  describe('Out-of-Order Delta Injections & Edge Sequences', () => {
    it('EDGE-1: Orphan tool_call_delta arriving before any tool_call_start is silently ignored', async () => {
      async function* generateOrphanDelta(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_orphan_delta', model: 'claude-3-5', created: 1731693600 };
        // Malicious / orphan tool delta before start
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"unstarted":"true"}' };
        yield { type: 'text_delta', delta: 'Valid text' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generateOrphanDelta()));

      // Verify no input_json_delta was emitted without tool_use block
      const jsonDeltas = events.filter(
        (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta'
      );
      expect(jsonDeltas.length).toBe(0);

      // Block 0 should be text
      expect(events[1].event).toBe('content_block_start');
      expect(events[1].data.index).toBe(0);
      expect(events[1].data.content_block.type).toBe('text');
    });

    it('EDGE-2: Premature tool_call_stop arriving when no tool was open is handled safely', async () => {
      async function* generatePrematureStop(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_premature_stop', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'tool_call_stop', index: 99 };
        yield { type: 'text_delta', delta: 'Still alive' };
        yield { type: 'tool_call_stop', index: 99 };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generatePrematureStop()));

      const stops = events.filter((e) => e.event === 'content_block_stop');
      expect(stops.length).toBe(1); // Only the legitimate text block close
      expect(stops[0].data.index).toBe(0);
    });

    it('EDGE-3: Missing stream_start auto-synthesizes message_start without crashing', async () => {
      async function* generateMissingStart(): AsyncIterable<CanonicalStreamEvent> {
        // Direct delta without stream_start
        yield { type: 'text_delta', delta: 'Direct hello without start' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generateMissingStart()));

      expect(events[0].event).toBe('message_start');
      expect(events[0].data.message.role).toBe('assistant');
      expect(events[1].event).toBe('content_block_start');
      expect(events[1].data.content_block.type).toBe('text');
    });

    it('EDGE-4: Stream end missing stopReason gracefully maps to end_turn', async () => {
      async function* generateMissingStopReason(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_no_stop_reason', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Quick response' };
        yield { type: 'stream_end', stopReason: undefined as any };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generateMissingStopReason()));

      const msgDelta = events.find((e) => e.event === 'message_delta');
      expect(msgDelta?.data.delta.stop_reason).toBe('end_turn');
    });
  });

  // =========================================================================
  // 3. Multiple Sequential Tool Invocations & Monotonic Block Indexing
  // =========================================================================
  describe('Multiple Sequential Tool Invocations', () => {
    it('TOOLS-1: 10 consecutive tool invocations maintain strictly monotonic block indices and pairwise open/close', async () => {
      const toolCount = 10;
      async function* generate10Tools(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_10_tools', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Preparing 10 sequential tool calls.' };

        for (let i = 0; i < toolCount; i++) {
          yield { type: 'tool_call_start', index: i, id: `call_id_${i}`, name: `tool_func_${i}` };
          yield { type: 'tool_call_delta', index: i, argumentsDelta: `{"step":${i},` };
          yield { type: 'tool_call_delta', index: i, argumentsDelta: `"status":"ok"}` };
          yield { type: 'tool_call_stop', index: i };
        }

        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate10Tools()));

      const starts = events.filter((e) => e.event === 'content_block_start');
      const stops = events.filter((e) => e.event === 'content_block_stop');

      // Total blocks: 1 (text) + 10 (tools) = 11
      expect(starts.length).toBe(11);
      expect(stops.length).toBe(11);

      // Verify strictly monotonic indices 0..10
      const expectedIndices = Array.from({ length: 11 }, (_, i) => i);
      expect(starts.map((s) => s.data.index)).toEqual(expectedIndices);
      expect(stops.map((s) => s.data.index)).toEqual(expectedIndices);

      // Check types: block 0 is text, blocks 1..10 are tool_use
      expect(starts[0].data.content_block.type).toBe('text');
      for (let i = 1; i <= toolCount; i++) {
        expect(starts[i].data.content_block.type).toBe('tool_use');
        expect(starts[i].data.content_block.id).toBe(`call_id_${i - 1}`);
        expect(starts[i].data.content_block.name).toBe(`tool_func_${i - 1}`);
      }

      // Verify stop reason
      const msgDelta = events.find((e) => e.event === 'message_delta');
      expect(msgDelta?.data.delta.stop_reason).toBe('tool_use');
    });

    it('TOOLS-2: Malformed upstream emitting tool_call_start without tool_call_stop auto-closes prior block', async () => {
      async function* generateUnclosedTools(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_unclosed_tools', model: 'claude-3-5', created: 1731693600 };
        // Tool 1 start with NO stop
        yield { type: 'tool_call_start', index: 0, id: 'call_alpha', name: 'search' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"q":"alpha"}' };
        // Tool 2 starts immediately without tool_call_stop on tool 1
        yield { type: 'tool_call_start', index: 1, id: 'call_beta', name: 'calc' };
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{"x":1}' };
        yield { type: 'tool_call_stop', index: 1 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generateUnclosedTools()));

      const starts = events.filter((e) => e.event === 'content_block_start');
      const stops = events.filter((e) => e.event === 'content_block_stop');

      expect(starts.length).toBe(2);
      expect(stops.length).toBe(2);

      // Both blocks cleanly started and stopped with indices 0 and 1
      expect(starts.map((s) => s.data.index)).toEqual([0, 1]);
      expect(stops.map((s) => s.data.index)).toEqual([0, 1]);
    });

    it('TOOLS-3: Interleaved Text and Tools pattern [Text -> Tool -> Text -> Tool -> Text]', async () => {
      async function* generateInterleaved(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_interleaved', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Prefix text. ' };
        yield { type: 'tool_call_start', index: 0, id: 'tool_1', name: 'fn1' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'text_delta', delta: 'Mid text. ' };
        yield { type: 'tool_call_start', index: 1, id: 'tool_2', name: 'fn2' };
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{}' };
        yield { type: 'tool_call_stop', index: 1 };
        yield { type: 'text_delta', delta: 'Suffix text.' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generateInterleaved()));

      const starts = events.filter((e) => e.event === 'content_block_start');
      const stops = events.filter((e) => e.event === 'content_block_stop');

      // Total blocks: 5 (text, tool, text, tool, text)
      expect(starts.length).toBe(5);
      expect(stops.length).toBe(5);

      expect(starts.map((s) => s.data.index)).toEqual([0, 1, 2, 3, 4]);
      expect(stops.map((s) => s.data.index)).toEqual([0, 1, 2, 3, 4]);

      expect(starts[0].data.content_block.type).toBe('text');
      expect(starts[1].data.content_block.type).toBe('tool_use');
      expect(starts[2].data.content_block.type).toBe('text');
      expect(starts[3].data.content_block.type).toBe('tool_use');
      expect(starts[4].data.content_block.type).toBe('text');
    });
  });

  // =========================================================================
  // 4. Strict Thinking Block Invariant Verification (Zero Thinking Post Non-Thinking)
  // =========================================================================
  describe('Zero Thinking Post Non-Thinking Exhaustive Invariant Matrix', () => {
    it('THINK-1: Invariant across all 5 permutation cases', async () => {
      // Matrix of 5 permutation test cases:
      const testCases = [
        {
          name: 'Case A: Tool first, then thinking, then text',
          events: [
            { type: 'stream_start', id: 'cA', model: 'claude-3-7', created: 1731693600 },
            { type: 'tool_call_start', index: 0, id: 'c1', name: 't1' },
            { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
            { type: 'tool_call_stop', index: 0 },
            { type: 'thinking_delta', delta: 'Late thinking' },
            { type: 'text_delta', delta: 'Final text' },
            { type: 'stream_end', stopReason: 'stop' },
          ],
        },
        {
          name: 'Case B: Text first, then thinking, then tool',
          events: [
            { type: 'stream_start', id: 'cB', model: 'claude-3-7', created: 1731693600 },
            { type: 'text_delta', delta: 'Intro' },
            { type: 'thinking_delta', delta: 'Late thinking in text' },
            { type: 'tool_call_start', index: 0, id: 'c2', name: 't2' },
            { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
            { type: 'tool_call_stop', index: 0 },
            { type: 'stream_end', stopReason: 'tool_calls' },
          ],
        },
        {
          name: 'Case C: Multiple thinking deltas after tool stop',
          events: [
            { type: 'stream_start', id: 'cC', model: 'claude-3-7', created: 1731693600 },
            { type: 'tool_call_start', index: 0, id: 'c3', name: 't3' },
            { type: 'tool_call_stop', index: 0 },
            { type: 'thinking_delta', delta: 'Late think 1' },
            { type: 'thinking_delta', delta: 'Late think 2' },
            { type: 'thinking_delta', delta: 'Late think 3' },
            { type: 'stream_end', stopReason: 'stop' },
          ],
        },
        {
          name: 'Case D: Pure thinking with signature only (valid single thinking block)',
          events: [
            { type: 'stream_start', id: 'cD', model: 'claude-3-7', created: 1731693600 },
            { type: 'thinking_delta', delta: 'Only thinking', signature: 'sig_pure' },
            { type: 'stream_end', stopReason: 'stop' },
          ],
        },
        {
          name: 'Case E: Thinking delta injected while tool is active (ADV-1.5 stress)',
          events: [
            { type: 'stream_start', id: 'cE', model: 'claude-3-7', created: 1731693600 },
            { type: 'tool_call_start', index: 0, id: 'c5', name: 't5' },
            { type: 'thinking_delta', delta: 'Injected inside active tool' },
            { type: 'tool_call_delta', index: 0, argumentsDelta: '{"key":"val"}' },
            { type: 'tool_call_stop', index: 0 },
            { type: 'stream_end', stopReason: 'tool_calls' },
          ],
        },
      ];

      for (const tc of testCases) {
        const gen = async function*(): AsyncIterable<CanonicalStreamEvent> {
          for (const ev of tc.events) {
            yield ev as CanonicalStreamEvent;
          }
        };

        const events = await collectAnthropicEvents(createAnthropicSSEStream(gen()));

        // Verification Rule 1: No content_block_start with type 'thinking' can have index > 0
        const thinkingStarts = events.filter(
          (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking'
        );
        for (const ts of thinkingStarts) {
          expect(ts.data.index).toBe(0);
        }

        // Verification Rule 2: If any non-thinking block started at index 0, thinkingStarts must be empty
        const firstBlockStart = events.find((e) => e.event === 'content_block_start');
        if (firstBlockStart && firstBlockStart.data.content_block.type !== 'thinking') {
          expect(thinkingStarts.length).toBe(0);
        }

        // Verification Rule 3: No tool_use block may ever receive a text_delta or thinking_delta
        const toolUseStarts = events.filter(
          (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use'
        );
        for (const tus of toolUseStarts) {
          const toolIndex = tus.data.index;
          const toolDeltas = events.filter(
            (e) => e.event === 'content_block_delta' && e.data.index === toolIndex
          );
          for (const td of toolDeltas) {
            expect(td.data.delta.type).toBe('input_json_delta');
          }
        }
      }
    });
  });

  // =========================================================================
  // 5. End-to-End Pipeline Stress: XML Tool Interceptor -> SSE Stream Adapter
  // =========================================================================
  describe('End-to-End Pipeline: Interceptor + Stream Adapter', () => {
    it('E2E-PIPE-1: Thinking -> Intercepted XML Tool -> Late Thinking -> Final Text conforms strictly to Anthropic SSE wire spec', async () => {
      async function* rawStream(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_e2e_pipe', model: 'claude-3-7-sonnet', created: 1731693600 };
        // Valid thinking at block 0
        yield { type: 'thinking_delta', delta: 'Planning execution plan...' };
        // Model emits raw XML tool call in text_delta
        yield {
          type: 'text_delta',
          delta: '<tool_call>\n<function=web_search>\n<parameter=query>bun test</parameter>\n</tool_call>',
        };
        // Adversarial late thinking token emitted after tool call ended
        yield { type: 'thinking_delta', delta: 'Post-search reflection' };
        // Final conversational text
        yield { type: 'text_delta', delta: 'Here are the search results.' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      // Chain pipeline: rawStream -> applyXMLToolInterceptor -> createAnthropicSSEStream
      const interceptedStream = applyXMLToolInterceptor(rawStream());
      const sseStream = createAnthropicSSEStream(interceptedStream);
      const events = await collectAnthropicEvents(sseStream);

      // Verify sequence of block start types:
      // Block 0: thinking
      // Block 1: tool_use (from intercepted XML)
      // Block 2: text (from late thinking converted to text, and final text appended)
      const starts = events.filter((e) => e.event === 'content_block_start');
      expect(starts.length).toBe(3);

      expect(starts[0].data.index).toBe(0);
      expect(starts[0].data.content_block.type).toBe('thinking');

      expect(starts[1].data.index).toBe(1);
      expect(starts[1].data.content_block.type).toBe('tool_use');
      expect(starts[1].data.content_block.name).toBe('web_search');

      expect(starts[2].data.index).toBe(2);
      expect(starts[2].data.content_block.type).toBe('text');

      // Verify content_block_stops match
      const stops = events.filter((e) => e.event === 'content_block_stop');
      expect(stops.length).toBe(3);
      expect(stops.map((s) => s.data.index)).toEqual([0, 1, 2]);

      // Verify that no XML leaked to text_delta
      const textDeltas = events.filter(
        (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
      );
      for (const td of textDeltas) {
        expect(td.data.delta.text).not.toContain('<tool_call>');
      }

      // Verify final stop reason was normalized to tool_calls or preserved
      const msgDelta = events.find((e) => e.event === 'message_delta');
      expect(msgDelta?.data.delta.stop_reason).toBe('tool_use');
    });

    it('E2E-PIPE-2: OpenAI SSE streaming correctly emits reasoning_content and [DONE]', async () => {
      async function* generateOpenAI(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'chatcmpl_test', model: 'o1-preview', created: 1731693600 };
        yield { type: 'thinking_delta', delta: 'Chain of thought tokens' };
        yield { type: 'text_delta', delta: 'Direct answer' };
        yield {
          type: 'stream_end',
          stopReason: 'stop',
          usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, reasoningTokens: 12 },
        };
      }

      const stream = createOpenAISSEStream(generateOpenAI(), { includeUsage: true });
      const chunks = await collectOpenAIRawChunks(stream);

      // Verify terminal
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]');

      // Verify reasoning_content chunk exists
      const parsedChunks = chunks
        .filter((c) => c.startsWith('data: {'))
        .map((c) => JSON.parse(c.slice(6)));

      const reasoningChunk = parsedChunks.find(
        (p) => p.choices?.[0]?.delta?.reasoning_content === 'Chain of thought tokens'
      );
      expect(reasoningChunk).toBeDefined();

      // Verify text chunk exists
      const textChunk = parsedChunks.find(
        (p) => p.choices?.[0]?.delta?.content === 'Direct answer'
      );
      expect(textChunk).toBeDefined();

      // Verify usage chunk details
      const usageChunk = parsedChunks.find((p) => p.usage);
      expect(usageChunk?.usage?.prompt_tokens).toBe(50);
      expect(usageChunk?.usage?.completion_tokens).toBe(20);
      expect(usageChunk?.usage?.completion_tokens_details?.reasoning_tokens).toBe(12);
    });
  });
});
