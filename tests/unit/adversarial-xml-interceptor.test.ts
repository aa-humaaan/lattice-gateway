import { describe, it, expect } from 'bun:test';
import {
  XMLToolInterceptorHandler,
  parseXMLToolCall,
  applyXMLToolInterceptor,
} from '../../src/engine/dialect/xml-tool-interceptor';
import { CanonicalStreamEvent } from '../../src/core/types/canonical';

describe('Adversarial XML Tool Interceptor Verification', () => {
  it('ADV-X1: Multiple XML tool calls in a single chunk are both parsed and indexed sequentially', async () => {
    async function* generate(): AsyncIterable<CanonicalStreamEvent> {
      yield {
        type: 'text_delta',
        delta: '<tool_call><function=tool1><parameter=a>1</parameter></tool_call><tool_call><function=tool2><parameter=b>2</parameter></tool_call>',
      };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const outputEvents: CanonicalStreamEvent[] = [];
    for await (const ev of applyXMLToolInterceptor(generate())) {
      outputEvents.push(ev);
    }

    const starts = outputEvents.filter((e) => e.type === 'tool_call_start');
    const deltas = outputEvents.filter((e) => e.type === 'tool_call_delta');
    const stops = outputEvents.filter((e) => e.type === 'tool_call_stop');
    const end = outputEvents.find((e) => e.type === 'stream_end');

    expect(starts.length).toBe(2);
    expect(starts[0].name).toBe('tool1');
    expect(starts[0].index).toBe(0);
    expect(starts[1].name).toBe('tool2');
    expect(starts[1].index).toBe(1);

    expect(deltas.length).toBe(2);
    expect(JSON.parse(deltas[0].argumentsDelta)).toEqual({ a: 1 });
    expect(JSON.parse(deltas[1].argumentsDelta)).toEqual({ b: 2 });

    expect(stops.length).toBe(2);
    expect(end?.stopReason).toBe('tool_calls'); // Stop reason rewritten
  });

  it('ADV-X2: Stream buffer overflow (>4KB) fails safe to text without dropping content', async () => {
    const hugeText = '<tool_call> ' + 'A'.repeat(5000); // 5000 chars without closing tag
    async function* generate(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'text_delta', delta: hugeText };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const outputEvents: CanonicalStreamEvent[] = [];
    for await (const ev of applyXMLToolInterceptor(generate())) {
      outputEvents.push(ev);
    }

    const texts = outputEvents.filter((e) => e.type === 'text_delta');
    const totalFlushedText = texts.map((t) => t.delta).join('');

    expect(totalFlushedText).toContain('AAAA');
    expect(totalFlushedText.length).toBe(hugeText.length);
  });

  it('ADV-X3: 1-byte incremental chunks reassemble cleanly across tool call boundaries', async () => {
    const rawXml = 'Prefix text <tool_call><function=byte_by_byte><parameter=k>"val"</parameter></tool_call> Suffix text';
    async function* generate(): AsyncIterable<CanonicalStreamEvent> {
      for (const char of rawXml) {
        yield { type: 'text_delta', delta: char };
      }
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const outputEvents: CanonicalStreamEvent[] = [];
    for await (const ev of applyXMLToolInterceptor(generate())) {
      outputEvents.push(ev);
    }

    const starts = outputEvents.filter((e) => e.type === 'tool_call_start');
    const texts = outputEvents.filter((e) => e.type === 'text_delta');
    const combinedText = texts.map((t) => t.delta).join('');

    expect(starts.length).toBe(1);
    expect(starts[0].name).toBe('byte_by_byte');
    expect(combinedText).toBe('Prefix text  Suffix text');
  });

  it('ADV-X4: Invoke format with JSON parameters containing escaped quotes and nested structures', () => {
    const xml = `<invoke name="execute_query">
      <parameters>{"query":"SELECT * FROM users WHERE name = \\"Aditya\\"", "nested":{"flag":true}}</parameters>
    </invoke>`;

    const parsed = parseXMLToolCall(xml);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('execute_query');
    const args = JSON.parse(parsed!.arguments);
    expect(args.nested.flag).toBe(true);
    expect(args.query).toContain('Aditya');
  });
});
