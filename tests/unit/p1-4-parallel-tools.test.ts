import { describe, expect, test } from 'bun:test';
import { createAnthropicSSEStream } from '../../src/engine/dialect/stream-adapter';
import type { CanonicalStreamEvent } from '../../src/core/types/canonical';

function parseSSE(text: string): Array<{ event: string; data: any }> {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const event = /event: ([^\n]+)/.exec(chunk)?.[1] ?? '';
      const raw = /data: ([^\n]+)/.exec(chunk)?.[1] ?? '{}';
      return { event, data: JSON.parse(raw) };
    });
}

async function* parallelToolEvents(): AsyncIterable<CanonicalStreamEvent> {
  yield { type: 'stream_start', id: 'msg_parallel', model: 'test', created: 1 };
  yield { type: 'tool_call_start', index: 0, id: 'call_a', name: 'get_weather' };
  yield { type: 'tool_call_start', index: 1, id: 'call_b', name: 'search' };
  yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city":' };
  yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{"query":' };
  yield { type: 'tool_call_delta', index: 0, argumentsDelta: '"Paris"}' };
  yield { type: 'tool_call_delta', index: 1, argumentsDelta: '"lattice"}' };
  yield { type: 'tool_call_stop', index: 0 };
  yield { type: 'tool_call_stop', index: 1 };
  yield { type: 'stream_end', stopReason: 'tool_calls' };
}

describe('P1-4 Anthropic parallel tool blocks', () => {
  test('interleaved tool deltas stay in their own block and parse as two valid JSON arguments', async () => {
    const stream = createAnthropicSSEStream(parallelToolEvents());
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    const events = parseSSE(raw);
    const starts = events.filter((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    expect(starts.length).toBe(2);
    const indexes = starts.map((e) => e.data.index);
    expect(new Set(indexes).size).toBe(2);
    expect(starts.map((e) => e.data.content_block.name).sort()).toEqual(['get_weather', 'search']);

    const partials = new Map<number, string>();
    for (const event of events.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')) {
      partials.set(event.data.index, (partials.get(event.data.index) ?? '') + event.data.delta.partial_json);
    }
    expect(partials.size).toBe(2);
    const parsed = Array.from(partials.values()).map((json) => JSON.parse(json));
    expect(parsed).toEqual([{ city: 'Paris' }, { query: 'lattice' }]);

    const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
    expect(stops.sort()).toEqual([...indexes].sort());
  });
});
