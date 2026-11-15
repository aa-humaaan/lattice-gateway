export interface ParsedSSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Resilient SSE Line Buffer handling partial chunks, CRLF/LF line splits,
 * multi-line data concatenation, and comment filtering.
 */
export class SSELineBuffer {
  private buffer = '';

  public feed(chunk: string): ParsedSSEEvent[] {
    this.buffer += chunk;
    const events: ParsedSSEEvent[] = [];

    while (true) {
      const boundaryMatch = this.buffer.match(/\r?\n\r?\n/);
      if (!boundaryMatch || boundaryMatch.index === undefined) {
        break;
      }

      const rawEvent = this.buffer.slice(0, boundaryMatch.index);
      this.buffer = this.buffer.slice(boundaryMatch.index + boundaryMatch[0].length);

      const parsed = this.parseRawEvent(rawEvent);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  public flush(): ParsedSSEEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const raw = this.buffer;
    this.buffer = '';
    const parsed = this.parseRawEvent(raw);
    return parsed ? [parsed] : [];
  }

  private parseRawEvent(raw: string): ParsedSSEEvent | null {
    const lines = raw.split(/\r?\n/);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    let id: string | undefined;
    let retry: number | undefined;

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        // Comment line (e.g. ": ping") or empty line
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        const field = line.trim();
        if (field === 'data') dataLines.push('');
        continue;
      }

      const field = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }

      if (field === 'event') {
        eventName = value;
      } else if (field === 'data') {
        dataLines.push(value);
      } else if (field === 'id') {
        id = value;
      } else if (field === 'retry') {
        const parsedRetry = parseInt(value, 10);
        if (!isNaN(parsedRetry)) retry = parsedRetry;
      }
    }

    if (dataLines.length === 0 && !eventName && !id) {
      return null;
    }

    return {
      event: eventName,
      data: dataLines.join('\n'),
      id,
      retry,
    };
  }
}

/**
 * Parses an upstream ReadableStream<Uint8Array> into an AsyncIterable of ParsedSSEEvents.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<ParsedSSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const buffer = new SSELineBuffer();

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        const events = buffer.feed(text);
        for (const event of events) {
          yield event;
        }
      }
    }
    const finalEvents = buffer.flush();
    for (const event of finalEvents) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
