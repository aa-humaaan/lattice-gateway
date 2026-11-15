import { describe, it, expect } from 'bun:test';
import {
  createXMLToolInterceptor,
  applyXMLToolInterceptor,
  MAX_XML_BUFFER_BYTES,
} from '../../src/engine/dialect/xml-tool-interceptor';
import { CanonicalStreamEvent } from '../../src/core/types/canonical';

async function collectEvents(
  events: AsyncIterable<CanonicalStreamEvent>
): Promise<CanonicalStreamEvent[]> {
  const result: CanonicalStreamEvent[] = [];
  for await (const ev of events) {
    result.push(ev);
  }
  return result;
}

describe('XML Tool-Calling Interceptor', () => {
  it('X1: Detects and intercepts <tool_call> XML', async () => {
    async function* generate() {
      yield {
        type: 'text_delta' as const,
        delta: '<tool_call>\n<function=run>\n<parameter=cmd>ls</parameter>\n</tool_call>',
      };
      yield { type: 'stream_end' as const, stopReason: 'stop' as const };
    }

    const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

    // Verify structured tool call events emitted and raw XML suppressed
    const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(0);

    const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0] as any).name).toBe('run');

    const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
    expect(toolDeltas.length).toBe(1);
    expect(JSON.parse((toolDeltas[0] as any).argumentsDelta)).toEqual({ cmd: 'ls' });

    const endEv = intercepted.find((e) => e.type === 'stream_end') as any;
    expect(endEv.stopReason).toBe('tool_calls');
  });

  it('X2: Detects and intercepts <invoke> XML', async () => {
    async function* generate() {
      yield {
        type: 'text_delta' as const,
        delta: '<invoke name="test"><parameters>{"a":1}</parameters></invoke>',
      };
      yield { type: 'stream_end' as const, stopReason: 'stop' as const };
    }

    const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

    const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0] as any).name).toBe('test');

    const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
    expect(toolDeltas.length).toBe(1);
    expect(JSON.parse((toolDeltas[0] as any).argumentsDelta)).toEqual({ a: 1 });
  });

  it('X3: Handles XML split across streaming chunks', async () => {
    async function* generate() {
      yield { type: 'text_delta' as const, delta: '<tool_' };
      yield { type: 'text_delta' as const, delta: 'call>\n<function=foo>\n' };
      yield { type: 'text_delta' as const, delta: '<parameter=q>search</parameter>\n</tool_call>' };
      yield { type: 'stream_end' as const, stopReason: 'stop' as const };
    }

    const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

    const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBe(0); // Zero XML leak

    const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0] as any).name).toBe('foo');

    const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
    expect(toolDeltas.length).toBe(1);
    expect(JSON.parse((toolDeltas[0] as any).argumentsDelta)).toEqual({ q: 'search' });
  });

  it('X4: Buffer overflow safety on false tags', async () => {
    // Generate text that starts with '<tool_not_a_call' and exceeds 4096 bytes
    const longFalseTag = '<tool_false_alarm_' + 'x'.repeat(MAX_XML_BUFFER_BYTES + 100);

    async function* generate() {
      yield { type: 'text_delta' as const, delta: longFalseTag };
      yield { type: 'stream_end' as const, stopReason: 'stop' as const };
    }

    const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

    const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    const totalFlushed = textDeltas.map((e: any) => e.delta).join('');
    expect(totalFlushed).toBe(longFalseTag);
  });

  it('X5: Preserves conversation text surrounding XML tool call', async () => {
    async function* generate() {
      yield { type: 'text_delta' as const, delta: 'Leading conversational text.\n' };
      yield {
        type: 'text_delta' as const,
        delta: '<tool_call>\n<function=calc>\n<parameter=n>5</parameter>\n</tool_call>',
      };
      yield { type: 'text_delta' as const, delta: '\nTrailing conversational text.' };
      yield { type: 'stream_end' as const, stopReason: 'stop' as const };
    }

    const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

    const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
    const combinedText = textDeltas.map((e: any) => e.delta).join('');

    expect(combinedText).toContain('Leading conversational text.\n');
    expect(combinedText).toContain('\nTrailing conversational text.');
    expect(combinedText).not.toContain('<tool_call>');

    const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0] as any).name).toBe('calc');
  });
});
