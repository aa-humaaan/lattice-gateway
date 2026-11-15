import { describe, it, expect } from 'bun:test';
import {
  createOpenAISSEStream,
  createAnthropicSSEStream,
} from '../../src/engine/dialect/stream-adapter';
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

describe('Adversarial Stream Adapter Verification', () => {
  // =========================================================================
  // 1. Anthropic SSE Event Sequence & Block State Machine
  // =========================================================================
  describe('Anthropic SSE State Machine Invariants', () => {
    it('ADV-1.1: Strict 7-event sequence and block indexing on standard text stream', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_std', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Hello ' };
        yield { type: 'text_delta', delta: 'world!' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));

      expect(events.length).toBe(7);
      expect(events[0].event).toBe('message_start');
      expect(events[1].event).toBe('content_block_start');
      expect(events[1].data.index).toBe(0);
      expect(events[1].data.content_block.type).toBe('text');

      expect(events[2].event).toBe('content_block_delta');
      expect(events[2].data.index).toBe(0);
      expect(events[2].data.delta.text).toBe('Hello ');

      expect(events[3].event).toBe('content_block_delta');
      expect(events[3].data.index).toBe(0);
      expect(events[3].data.delta.text).toBe('world!');

      expect(events[4].event).toBe('content_block_stop');
      expect(events[4].data.index).toBe(0);

      expect(events[5].event).toBe('message_delta');
      expect(events[5].data.delta.stop_reason).toBe('end_turn');

      expect(events[6].event).toBe('message_stop');
    });

    it('ADV-1.2: Strict sequential indexing when thinking transitions to text', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_thk', model: 'claude-3-7-sonnet', created: 1731693600 };
        yield { type: 'thinking_delta', delta: 'Let me think...', signature: 'sig_123' };
        yield { type: 'text_delta', delta: 'The answer is 42.' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));
      const eventTypes = events.map((e) => e.event);

      // Invariant: thinking (index 0) MUST stop before text (index 1) starts
      expect(eventTypes).toEqual([
        'message_start',
        'content_block_start', // index 0, thinking
        'content_block_delta', // index 0, thinking_delta
        'content_block_delta', // index 0, signature_delta
        'content_block_stop',  // index 0
        'content_block_start', // index 1, text
        'content_block_delta', // index 1, text_delta
        'content_block_stop',  // index 1
        'message_delta',
        'message_stop',
      ]);

      expect(events[1].data.index).toBe(0);
      expect(events[1].data.content_block.type).toBe('thinking');
      expect(events[4].data.index).toBe(0);

      expect(events[5].data.index).toBe(1);
      expect(events[5].data.content_block.type).toBe('text');
      expect(events[7].data.index).toBe(1);
    });

    it('ADV-1.3: Thinking blocks are NEVER emitted after a text block has begun', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_late', model: 'claude-3-7-sonnet', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Answer part 1. ' };
        // Malicious / late upstream thinking token after text already emitted
        yield { type: 'thinking_delta', delta: 'Wait, let me rethink... ' };
        yield { type: 'text_delta', delta: 'Answer part 2.' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));

      // Check all content_block_start events
      const starts = events.filter((e) => e.event === 'content_block_start');
      for (const start of starts) {
        expect(start.data.content_block.type).not.toBe('thinking');
      }

      // Thinking delta should NOT be emitted as thinking_delta
      const thinkingDeltas = events.filter(
        (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
      );
      expect(thinkingDeltas.length).toBe(0);
    });

    it('ADV-1.4: Late thinking arriving after a tool block closed must NOT emit a new thinking block', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_adv_tool', model: 'claude-3-7-sonnet', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Calling tool now.' };
        yield { type: 'tool_call_start', index: 0, id: 'call_1', name: 'search' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"q":"test"}' };
        yield { type: 'tool_call_stop', index: 0 };
        // Malicious / late thinking event after tool call stopped
        yield { type: 'thinking_delta', delta: 'Late thinking after tool stopped.' };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));

      // Check if any thinking block was started after tool call
      const thinkingStarts = events.filter(
        (e) => e.event === 'content_block_start' && e.data.content_block.type === 'thinking'
      );
      // SPEC REQUIREMENT: "Verify that thinking blocks are never emitted after a text block has begun"
      expect(thinkingStarts.length).toBe(0);
    });

    it('ADV-1.5: Late thinking arriving during active tool block must NOT emit text_delta inside tool_use block', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_adv_tool_mid', model: 'claude-3-7-sonnet', created: 1731693600 };
        yield { type: 'tool_call_start', index: 0, id: 'call_1', name: 'search' };
        // Thinking event while tool_use block is active
        yield { type: 'thinking_delta', delta: 'Evaluating query...' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"q":"foo"}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));

      // Content block 0 is tool_use. Its deltas MUST NOT be text_delta
      const block0Deltas = events.filter(
        (e) => e.event === 'content_block_delta' && e.data.index === 0
      );
      for (const d of block0Deltas) {
        expect(d.data.delta.type).not.toBe('text_delta');
      }
    });

    it('ADV-1.6: Multiple sequential tool calls have monotonically strictly incrementing block indices', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_multi_tools', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Calling two tools.' };
        // Tool 1
        yield { type: 'tool_call_start', index: 0, id: 'call_1', name: 'search' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"q":"a"}' };
        yield { type: 'tool_call_stop', index: 0 };
        // Tool 2
        yield { type: 'tool_call_start', index: 1, id: 'call_2', name: 'calc' };
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{"expr":"1+1"}' };
        yield { type: 'tool_call_stop', index: 1 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));

      const starts = events.filter((e) => e.event === 'content_block_start');
      const stops = events.filter((e) => e.event === 'content_block_stop');

      expect(starts.length).toBe(3); // text (0), tool 1 (1), tool 2 (2)
      expect(stops.length).toBe(3);

      expect(starts.map((s) => s.data.index)).toEqual([0, 1, 2]);
      expect(stops.map((s) => s.data.index)).toEqual([0, 1, 2]);
    });

    it('ADV-1.7: Stream error event closes active block and emits dialect error cleanly', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_err', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Partial output...' };
        yield { type: 'stream_error', error: { message: 'Upstream connection reset', type: 'upstream_error', code: '502', status: 502 } };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));
      const eventTypes = events.map((e) => e.event);

      expect(eventTypes).toContain('content_block_start');
      expect(eventTypes).toContain('content_block_stop');
      expect(eventTypes).toContain('error');

      const errEvent = events.find((e) => e.event === 'error');
      expect(errEvent?.data.error.message).toBe('Upstream connection reset');
    });

    it('ADV-1.8: Empty stream (zero deltas) emits message_start -> message_delta -> message_stop', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_empty', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const events = await collectAnthropicEvents(createAnthropicSSEStream(generate()));
      const eventTypes = events.map((e) => e.event);

      expect(eventTypes).toEqual(['message_start', 'message_delta', 'message_stop']);
    });
  });

  // =========================================================================
  // 2. OpenAI SSE Stream Completion & Dialect Conformance
  // =========================================================================
  describe('OpenAI SSE Dialect Conformance & [DONE] Terminal Marker', () => {
    it('ADV-2.1: Terminal chunk is strictly data: [DONE]', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'chunk_done', model: 'gpt-4', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Sample response' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const chunks = await collectOpenAIRawChunks(createOpenAISSEStream(generate()));

      expect(chunks.length).toBeGreaterThan(0);
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk).toBe('data: [DONE]');
    });

    it('ADV-2.2: Terminal data: [DONE] emitted on thinking response and tool calls', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'chunk_thk_done', model: 'o1', created: 1731693600 };
        yield { type: 'thinking_delta', delta: 'Deep thought' };
        yield { type: 'tool_call_start', index: 0, id: 'call_1', name: 'search' };
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"q":"done"}' };
        yield { type: 'tool_call_stop', index: 0 };
        yield { type: 'stream_end', stopReason: 'tool_calls' };
      }

      const chunks = await collectOpenAIRawChunks(createOpenAISSEStream(generate()));
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]');
    });

    it('ADV-2.3: includeUsage option emits usage chunk before [DONE]', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'chunk_usage', model: 'gpt-4', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Tokens counted.' };
        yield {
          type: 'stream_end',
          stopReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 2 },
        };
      }

      const chunks = await collectOpenAIRawChunks(
        createOpenAISSEStream(generate(), { includeUsage: true })
      );

      expect(chunks[chunks.length - 1]).toBe('data: [DONE]');
      const usageChunkStr = chunks[chunks.length - 2];
      const parsed = JSON.parse(usageChunkStr.replace(/^data:\s*/, ''));

      expect(parsed.usage).toBeDefined();
      expect(parsed.usage.prompt_tokens).toBe(10);
      expect(parsed.usage.completion_tokens).toBe(5);
      expect(parsed.usage.total_tokens).toBe(15);
      expect(parsed.usage.completion_tokens_details?.reasoning_tokens).toBe(2);
      expect(parsed.choices).toEqual([]);
    });

    it('ADV-2.4: Empty OpenAI stream cleanly emits terminal [DONE]', async () => {
      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'chunk_empty', model: 'gpt-4', created: 1731693600 };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const chunks = await collectOpenAIRawChunks(createOpenAISSEStream(generate()));
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]');
    });
  });

  // =========================================================================
  // 3. Keepalive Ping Intervals & Activity Resets
  // =========================================================================
  describe('Keepalive Ping Heartbeat & Activity Resets', () => {
    it('ADV-3.1: Emits keepalive pings (: ping\\n\\n) during idle upstream pauses', async () => {
      let continueStream: () => void = () => {};
      const pausePromise = new Promise<void>((resolve) => {
        continueStream = resolve;
      });

      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_ping', model: 'claude-3-5', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Before pause.' };
        await pausePromise;
        yield { type: 'text_delta', delta: 'After pause.' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const stream = createAnthropicSSEStream(generate(), { keepaliveMs: 25 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let rawOutput = '';

      // Read initial chunks
      const { value: v1 } = await reader.read();
      rawOutput += decoder.decode(v1!);

      // Wait 70ms so at least 2 pings fire at 25ms intervals
      await new Promise((r) => setTimeout(r, 70));

      continueStream();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          rawOutput += decoder.decode(value);
        }
      }

      const pingMatches = rawOutput.match(/: ping\n\n/g);
      expect(pingMatches).not.toBeNull();
      expect(pingMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it('ADV-3.2: Keepalive timer resets on active token delivery (no pings emitted)', async () => {
      async function* generateFast(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_fast', model: 'claude-3-5', created: 1731693600 };
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 10)); // Faster than 35ms keepalive
          yield { type: 'text_delta', delta: `word_${i} ` };
        }
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const stream = createAnthropicSSEStream(generateFast(), { keepaliveMs: 35 });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let rawOutput = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          rawOutput += decoder.decode(value);
        }
      }

      // No keepalive ping should have fired because chunks reset the timer every 10ms
      expect(rawOutput).not.toContain(': ping\n\n');
    });
  });

  // =========================================================================
  // 4. Stream Cancellation, Backpressure & Resource Cleanup
  // =========================================================================
  describe('Stream Cancellation & Resource Cleanup', () => {
    it('ADV-4.1: Pre-aborted signal stops stream immediately', async () => {
      const abortController = new AbortController();
      abortController.abort();

      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'stream_start', id: 'msg_pre_abort', model: 'gpt-4', created: 1731693600 };
        yield { type: 'text_delta', delta: 'Should not reach' };
        yield { type: 'stream_end', stopReason: 'stop' };
      }

      const stream = createOpenAISSEStream(generate(), { signal: abortController.signal });
      const chunks = await collectOpenAIRawChunks(stream);

      expect(chunks.some((c) => c.includes('Should not reach'))).toBe(false);
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]');
    });

    it('ADV-4.2: AbortSignal triggered mid-stream halts iteration and cleanly finishes', async () => {
      const abortController = new AbortController();
      let generatorCleanedUp = false;

      async function* generate(): AsyncIterable<CanonicalStreamEvent> {
        try {
          yield { type: 'stream_start', id: 'msg_mid_abort', model: 'gpt-4', created: 1731693600 };
          yield { type: 'text_delta', delta: 'First chunk.' };
          yield { type: 'text_delta', delta: 'Second chunk.' };
          abortController.abort();
          yield { type: 'text_delta', delta: 'Third chunk.' };
          yield { type: 'stream_end', stopReason: 'stop' };
        } finally {
          generatorCleanedUp = true;
        }
      }

      const stream = createOpenAISSEStream(generate(), { signal: abortController.signal });
      const chunks = await collectOpenAIRawChunks(stream);

      expect(chunks.some((c) => c.includes('Third chunk.'))).toBe(false);
      expect(generatorCleanedUp).toBe(true);
    });

    it('ADV-4.3: reader.cancel() closes stream and releases reader without unhandled errors', async () => {
      async function* generateInfinite(): AsyncIterable<CanonicalStreamEvent> {
        let i = 0;
        while (true) {
          yield { type: 'text_delta', delta: `chunk_${i++}` };
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      const stream = createAnthropicSSEStream(generateInfinite());
      const reader = stream.getReader();

      const { value } = await reader.read();
      expect(value).toBeDefined();

      await reader.cancel('Client disconnected');
      expect(reader.closed).toBeDefined();
    });
  });
});
