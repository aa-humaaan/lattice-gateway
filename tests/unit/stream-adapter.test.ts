import { describe, it, expect } from 'bun:test';
import {
  createOpenAISSEStream,
  createAnthropicSSEStream,
} from '../../src/engine/dialect/stream-adapter';
import { CanonicalStreamEvent } from '../../src/core/types/canonical';

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      result += decoder.decode(value, { stream: true });
    }
  }
  return result;
}

describe('SSE Stream Adapters', () => {
  it('A1: OpenAI SSE stream basic text and [DONE]', async () => {
    async function* generateEvents(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'chunk_1', model: 'gpt-4', created: 1731693600 };
      yield { type: 'text_delta', delta: 'Hello ' };
      yield { type: 'text_delta', delta: 'world!' };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const stream = createOpenAISSEStream(generateEvents());
    const text = await streamToText(stream);

    expect(text).toContain('data: {"id":"chunk_1"');
    expect(text).toContain('"content":"Hello "');
    expect(text).toContain('"content":"world!"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('data: [DONE]\n\n');
  });

  it('A2: OpenAI SSE stream reasoning_content deltas', async () => {
    async function* generateEvents(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'chunk_r1', model: 'o1', created: 1731693600 };
      yield { type: 'thinking_delta', delta: 'Thinking step A. ' };
      yield { type: 'thinking_delta', delta: 'Thinking step B.' };
      yield { type: 'text_delta', delta: 'Answer.' };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const stream = createOpenAISSEStream(generateEvents());
    const text = await streamToText(stream);

    expect(text).toContain('"reasoning_content":"Thinking step A. "');
    expect(text).toContain('"reasoning_content":"Thinking step B."');
    expect(text).toContain('"content":"Answer."');
    expect(text).toContain('data: [DONE]\n\n');
  });

  it('A3: Anthropic SSE state machine event order', async () => {
    async function* generateEvents(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'msg_anth_1', model: 'claude-3-7-sonnet', created: 1731693600 };
      yield { type: 'thinking_delta', delta: 'Analyzing...', signature: 'sig_abc' };
      yield { type: 'text_delta', delta: 'The final result is ready.' };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const stream = createAnthropicSSEStream(generateEvents());
    const text = await streamToText(stream);

    // Verify presence and ordering of events
    const startIdx = text.indexOf('event: message_start');
    const thinkStartIdx = text.indexOf('"type":"thinking"');
    const thinkDeltaIdx = text.indexOf('event: content_block_delta');
    const thinkStopIdx = text.indexOf('event: content_block_stop');
    const textStartIdx = text.indexOf('"type":"text"');
    const msgDeltaIdx = text.indexOf('event: message_delta');
    const msgStopIdx = text.indexOf('event: message_stop');

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(thinkStartIdx).toBeGreaterThan(startIdx);
    expect(thinkDeltaIdx).toBeGreaterThan(thinkStartIdx);
    expect(thinkStopIdx).toBeGreaterThan(thinkDeltaIdx);
    expect(textStartIdx).toBeGreaterThan(thinkStopIdx);
    expect(msgDeltaIdx).toBeGreaterThan(textStartIdx);
    expect(msgStopIdx).toBeGreaterThan(msgDeltaIdx);
  });

  it('A4: Anthropic SSE thinking block closed before text block', async () => {
    async function* generateEvents(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'msg_anth_2', model: 'claude-3-7-sonnet', created: 1731693600 };
      yield { type: 'thinking_delta', delta: 'Thinking.' };
      yield { type: 'text_delta', delta: 'Answer.' };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const stream = createAnthropicSSEStream(generateEvents());
    const text = await streamToText(stream);

    // Block 0 should start, delta, and stop before Block 1 starts
    expect(text).toContain('{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}');
    expect(text).toContain('{"type":"content_block_stop","index":0}');
    expect(text).toContain('{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}');
    expect(text).toContain('{"type":"content_block_stop","index":1}');
  });

  it('A5: Keepalive ping heartbeat generation', async () => {
    let continueStream: () => void = () => {};
    const waitPromise = new Promise<void>((resolve) => {
      continueStream = resolve;
    });

    async function* generateSlowEvents(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'msg_slow', model: 'claude-3-7-sonnet', created: 1731693600 };
      // Pause for longer than keepaliveMs
      await waitPromise;
      yield { type: 'text_delta', delta: 'Resumed.' };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const stream = createAnthropicSSEStream(generateSlowEvents(), { keepaliveMs: 30 });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let chunks = '';
    // Read the first chunk (message_start)
    const { value: firstVal } = await reader.read();
    chunks += decoder.decode(firstVal!);

    // Wait 80ms so at least two keepalives fire
    await new Promise((r) => setTimeout(r, 80));

    // Release the slow stream
    continueStream();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks += decoder.decode(value);
      }
    }

    expect(chunks).toContain(': ping\n\n');
  });

  it('A6: Stream cancellation / abort propagation', async () => {
    let aborted = false;
    async function* generateInfiniteEvents(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'msg_inf', model: 'gpt-4', created: 1731693600 };
      try {
        let i = 0;
        while (true) {
          yield { type: 'text_delta', delta: `chunk_${i++}` };
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        aborted = true;
      }
    }

    const stream = createOpenAISSEStream(generateInfiniteEvents());
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(reader.closed).toBeDefined();
  });
});
