import { describe, it, expect } from 'bun:test';
import { SSELineBuffer } from '../../src/utils/sse-parser';

describe('SSE Line Buffer & Parser', () => {
  it('P1: Parse complete single SSE event', () => {
    const buffer = new SSELineBuffer();
    const events = buffer.feed('data: {"foo":"bar"}\n\n');
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('{"foo":"bar"}');
    expect(events[0].event).toBeUndefined();
  });

  it('P2: Parse multi-event chunk', () => {
    const buffer = new SSELineBuffer();
    const raw = 'event: start\ndata: {}\n\nevent: delta\ndata: {"t":"a"}\n\n';
    const events = buffer.feed(raw);
    expect(events.length).toBe(2);
    expect(events[0].event).toBe('start');
    expect(events[0].data).toBe('{}');
    expect(events[1].event).toBe('delta');
    expect(events[1].data).toBe('{"t":"a"}');
  });

  it('P3: Handle chunk fragmented across TCP packets', () => {
    const buffer = new SSELineBuffer();
    const chunk1 = 'data: {"val": ';
    const chunk2 = '"hello"}\n\n';

    const events1 = buffer.feed(chunk1);
    expect(events1.length).toBe(0); // Incomplete chunk

    const events2 = buffer.feed(chunk2);
    expect(events2.length).toBe(1);
    expect(events2[0].data).toBe('{"val": "hello"}');
  });

  it('P4: Handle CRLF line delimiters', () => {
    const buffer = new SSELineBuffer();
    const events = buffer.feed('data: {"a":1}\r\n\r\n');
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('{"a":1}');
  });

  it('P5: Ignore comment lines', () => {
    const buffer = new SSELineBuffer();
    const events = buffer.feed(': ping\n\ndata: {"ok":true}\n\n');
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('{"ok":true}');
  });
});
