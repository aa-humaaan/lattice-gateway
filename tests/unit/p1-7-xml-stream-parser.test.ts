import { describe, expect, test } from 'bun:test';
import {
  applyXMLToolInterceptor,
  MAX_XML_BUFFER_BYTES,
} from '../../src/engine/dialect/xml-tool-interceptor';
import type { CanonicalStreamEvent } from '../../src/core/types/canonical';

async function collect(chunks: string[]): Promise<CanonicalStreamEvent[]> {
  async function* generate(): AsyncIterable<CanonicalStreamEvent> {
    for (const chunk of chunks) yield { type: 'text_delta', delta: chunk };
    yield { type: 'stream_end', stopReason: 'stop' };
  }
  const out: CanonicalStreamEvent[] = [];
  for await (const event of applyXMLToolInterceptor(generate())) out.push(event);
  return out;
}

function tools(events: CanonicalStreamEvent[]) {
  return events
    .filter((e) => e.type === 'tool_call_start')
    .map((start: any) => {
      const delta = events.find(
        (e) => e.type === 'tool_call_delta' && (e as any).index === start.index
      ) as any;
      return { name: start.name, args: JSON.parse(delta?.argumentsDelta ?? '{}') };
    });
}

function text(events: CanonicalStreamEvent[]): string {
  return events
    .filter((e) => e.type === 'text_delta')
    .map((e: any) => e.delta)
    .join('');
}

describe('P1-7 streaming XML tool parser', () => {
  test('every advertised prefix produces tool events', async () => {
    const shapes: Array<[string, string, string, Record<string, unknown>]> = [
      ['tool_call', '<tool_call><function=run><parameter=cmd>ls</parameter></tool_call>', 'run', { cmd: 'ls' }],
      ['invoke', '<invoke name="search"><parameters>{"q":"lattice"}</parameters></invoke>', 'search', { q: 'lattice' }],
      [
        'function_call',
        '<function_call name="calc"><parameter name="n">5</parameter></function_call>',
        'calc',
        { n: 5 },
      ],
      [
        'function_calls',
        '<function_calls><function_call name="a"><parameter name="x">1</parameter></function_call><function_call name="b"><parameter name="y">2</parameter></function_call></function_calls>',
        'a',
        { x: 1 },
      ],
    ];
    for (const [prefix, xml, name, args] of shapes) {
      const events = await collect([`before ${xml} after`]);
      expect(text(events)).not.toContain(`<${prefix}`);
      const parsed = tools(events);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].name).toBe(name);
      expect(parsed[0].args).toEqual(args);
      expect(text(events)).toContain('before ');
      expect(text(events)).toContain(' after');
    }
    const wrapped = await collect([
      '<function_calls><function_call name="a"><parameter name="x">1</parameter></function_call><function_call name="b"><parameter name="y">2</parameter></function_call></function_calls>',
    ]);
    expect(tools(wrapped).map((t) => t.name).sort()).toEqual(['a', 'b']);
  });

  test('XML entities are decoded in tool arguments', async () => {
    const events = await collect([
      '<invoke name="run"><parameter name="cmd">echo &quot;x&quot; &amp; &lt;y&gt; &nbsp; &#65; &#x1F600;</parameter></invoke>',
    ]);
    expect(tools(events)[0].args).toEqual({ cmd: 'echo "x" & <y> \u00a0 A \u{1F600}' });
  });

  test('a malformed advertised tag never leaks raw XML as content', async () => {
    const events = await collect([
      'hello <tool_call><function=run><parameter=cmd>ls</tool_call> world',
    ]);
    expect(text(events)).not.toContain('<tool_call');
    expect(text(events)).not.toContain('<parameter');
    expect(text(events)).toContain('hello ');
    expect(text(events)).toContain(' world');
  });

  test('buffer cap is enforced in bytes, not UTF-16 code units', async () => {
    const emoji = '\u{1F600}'.repeat(2000); // 8000 bytes, 4000 code units
    const events = await collect([`<invoke name="flood"><parameters>${emoji}</parameters></invoke>`]);
    const flushed = Array.from(text(events)).join('');
    expect(Buffer.byteLength(flushed, 'utf8')).toBeLessThanOrEqual(MAX_XML_BUFFER_BYTES);
    expect(flushed).not.toContain('<invoke');
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(false);
  });
});
