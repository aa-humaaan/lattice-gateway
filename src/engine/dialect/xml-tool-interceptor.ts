import { CanonicalStreamEvent } from '../../core/types/canonical';

export const MAX_XML_BUFFER_BYTES = 4096;

export interface ParsedXMLToolCall {
  name: string;
  arguments: string;
}

/**
 * Extracts function name and arguments from recognized XML tool formats:
 * Format 1: <tool_call><function=name><parameter=k>v</parameter></tool_call>
 * Format 2: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 * Format 3: <invoke name="..."><parameters>{"k":"v"}</parameters></invoke>
 * Format 4: <invoke name="..."><parameter name="k">v</parameter></invoke>
 */
export function parseXMLToolCall(xml: string): ParsedXMLToolCall | null {
  // Pattern 1 & 2: <tool_call>...</tool_call>
  const toolCallMatch = xml.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (toolCallMatch) {
    const inner = toolCallMatch[1].trim();

    // Check if inner is JSON
    if (inner.startsWith('{') && inner.endsWith('}')) {
      try {
        const parsed = JSON.parse(inner);
        if (parsed.name) {
          return {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments || {}),
          };
        }
      } catch {}
    }

    // Tagged parameters with <function=name> ... <parameter=k>v</parameter>
    const fnMatch = inner.match(/<function[ =]([a-zA-Z0-9_\-\.]+)>([\s\S]*)/i);
    if (fnMatch) {
      const name = fnMatch[1];
      const rest = fnMatch[2];
      const params: Record<string, unknown> = {};
      const paramRegex = /<parameter[ =]([a-zA-Z0-9_\-]+)>([\s\S]*?)<\/parameter>/gi;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = paramRegex.exec(rest)) !== null) {
        const key = pMatch[1];
        const rawVal = pMatch[2].trim();
        try {
          params[key] = JSON.parse(rawVal);
        } catch {
          params[key] = rawVal;
        }
      }
      return {
        name,
        arguments: JSON.stringify(params),
      };
    }
  }

  // Pattern 3 & 4: <invoke name="...">...</invoke>
  const invokeMatch = xml.match(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/i);
  if (invokeMatch) {
    const name = invokeMatch[1];
    const inner = invokeMatch[2].trim();

    // Check for <parameters> JSON block
    const parametersMatch = inner.match(/<parameters>([\s\S]*?)<\/parameters>/i);
    if (parametersMatch) {
      const paramStr = parametersMatch[1].trim();
      if (paramStr.startsWith('{') && paramStr.endsWith('}')) {
        return {
          name,
          arguments: paramStr,
        };
      }
    }

    // Check for <parameter name="..."> or <parameter=...>
    const params: Record<string, unknown> = {};
    const paramRegex = /<parameter(?:\s+name=["']([^"']+)["']|=([a-zA-Z0-9_\-]+))>([\s\S]*?)<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    let foundParams = false;
    while ((pMatch = paramRegex.exec(inner)) !== null) {
      foundParams = true;
      const key = pMatch[1] || pMatch[2];
      const rawVal = pMatch[3].trim();
      try {
        params[key] = JSON.parse(rawVal);
      } catch {
        params[key] = rawVal;
      }
    }

    if (foundParams) {
      return {
        name,
        arguments: JSON.stringify(params),
      };
    }

    // If inner is JSON directly
    if (inner.startsWith('{') && inner.endsWith('}')) {
      return {
        name,
        arguments: inner,
      };
    }

    return {
      name,
      arguments: '{}',
    };
  }

  return null;
}

export class XMLToolInterceptorHandler {
  private buffer = '';
  private isBuffering = false;
  private toolCallIndex = 0;
  private hasEmittedToolCalls = false;

  private static TOOL_OPEN_PREFIXES = [
    '<tool_call',
    '<invoke',
    '<function_call',
    '<function_calls',
  ];

  public handleEvent(
    event: CanonicalStreamEvent,
    emit: (event: CanonicalStreamEvent) => void
  ): void {
    if (event.type !== 'text_delta') {
      if (event.type === 'stream_end') {
        this.flushBuffer(emit);
        if (this.hasEmittedToolCalls && event.stopReason === 'stop') {
          emit({ ...event, stopReason: 'tool_calls' });
          return;
        }
      }
      emit(event);
      return;
    }

    const chunk = event.delta;
    this.buffer += chunk;

    this.processBuffer(emit);
  }

  private processBuffer(emit: (event: CanonicalStreamEvent) => void): void {
    while (this.buffer.length > 0) {
      if (!this.isBuffering) {
        const tagIndex = this.buffer.indexOf('<');
        if (tagIndex === -1) {
          // No '<' in buffer, flush all as text
          emit({ type: 'text_delta', delta: this.buffer });
          this.buffer = '';
          return;
        }

        if (tagIndex > 0) {
          // Emit leading text before '<'
          emit({ type: 'text_delta', delta: this.buffer.slice(0, tagIndex) });
          this.buffer = this.buffer.slice(tagIndex);
        }

        // Buffer now starts with '<'
        const candidate = this.buffer.toLowerCase();
        const matchesAnyPrefix = XMLToolInterceptorHandler.TOOL_OPEN_PREFIXES.some(
          (p) => p.startsWith(candidate) || candidate.startsWith(p)
        );

        if (!matchesAnyPrefix) {
          // Not a tool tag, flush the '<' and continue
          emit({ type: 'text_delta', delta: this.buffer.slice(0, 1) });
          this.buffer = this.buffer.slice(1);
          continue;
        }

        // Confirm full opening tag
        const isFullOpen = candidate.startsWith('<tool_call') ||
                           candidate.startsWith('<invoke') ||
                           candidate.startsWith('<function_call');

        if (isFullOpen) {
          this.isBuffering = true;
        } else {
          // Partial tag prefix (<t, <to, <tool) — await next chunk if short
          if (this.buffer.length < 20) {
            return;
          }
          // Exceeded prefix length without match, flush
          emit({ type: 'text_delta', delta: this.buffer });
          this.buffer = '';
          return;
        }
      }

      if (this.isBuffering) {
        // Look for closing tag: </tool_call> or </invoke>
        const closeMatch = this.buffer.match(/<\/(tool_call|invoke|function_call|function_calls)>/i);
        if (closeMatch && closeMatch.index !== undefined) {
          const endIndex = closeMatch.index + closeMatch[0].length;
          const fullXml = this.buffer.slice(0, endIndex);
          this.buffer = this.buffer.slice(endIndex);
          this.isBuffering = false;

          const parsed = parseXMLToolCall(fullXml);
          if (parsed) {
            const callId = `call_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
            emit({
              type: 'tool_call_start',
              index: this.toolCallIndex,
              id: callId,
              name: parsed.name,
            });
            emit({
              type: 'tool_call_delta',
              index: this.toolCallIndex,
              argumentsDelta: parsed.arguments,
            });
            emit({
              type: 'tool_call_stop',
              index: this.toolCallIndex,
            });
            this.toolCallIndex++;
            this.hasEmittedToolCalls = true;
          } else {
            // Failed to parse, flush as text
            emit({ type: 'text_delta', delta: fullXml });
          }
          continue;
        }

        // Safety threshold: if buffer exceeds 4KB without closing tag, fail-safe flush
        if (this.buffer.length > MAX_XML_BUFFER_BYTES) {
          emit({ type: 'text_delta', delta: this.buffer });
          this.buffer = '';
          this.isBuffering = false;
          return;
        }

        // Await next chunks to close tag
        return;
      }
    }
  }

  public flush(emit: (event: CanonicalStreamEvent) => void): void {
    this.flushBuffer(emit);
  }

  private flushBuffer(emit: (event: CanonicalStreamEvent) => void): void {
    if (this.buffer.length > 0) {
      if (this.isBuffering) {
        // Attempt partial parse on unclosed tool call
        const parsed = parseXMLToolCall(this.buffer + '</tool_call>');
        if (parsed) {
          const callId = `call_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
          emit({
            type: 'tool_call_start',
            index: this.toolCallIndex,
            id: callId,
            name: parsed.name,
          });
          emit({
            type: 'tool_call_delta',
            index: this.toolCallIndex,
            argumentsDelta: parsed.arguments,
          });
          emit({
            type: 'tool_call_stop',
            index: this.toolCallIndex,
          });
          this.toolCallIndex++;
          this.hasEmittedToolCalls = true;
          this.buffer = '';
          this.isBuffering = false;
          return;
        }
      }

      emit({ type: 'text_delta', delta: this.buffer });
      this.buffer = '';
      this.isBuffering = false;
    }
  }
}

/**
 * AsyncGenerator wrapper for stream pipelines.
 */
export async function* applyXMLToolInterceptor(
  events: AsyncIterable<CanonicalStreamEvent>
): AsyncGenerator<CanonicalStreamEvent> {
  const handler = new XMLToolInterceptorHandler();
  for await (const event of events) {
    const queue: CanonicalStreamEvent[] = [];
    handler.handleEvent(event, (out) => queue.push(out));
    for (const q of queue) {
      yield q;
    }
  }
  const flushQueue: CanonicalStreamEvent[] = [];
  handler.flush((out) => flushQueue.push(out));
  for (const q of flushQueue) {
    yield q;
  }
}

export interface XMLToolInterceptorInstance extends TransformStream<CanonicalStreamEvent, CanonicalStreamEvent> {
  transform(events: AsyncIterable<CanonicalStreamEvent>): AsyncIterable<CanonicalStreamEvent>;
}

/**
 * Creates Web Standard TransformStream with helper .transform() method for XML tool call interception.
 */
export function createXMLToolInterceptor(): XMLToolInterceptorInstance {
  const handler = new XMLToolInterceptorHandler();
  const stream = new TransformStream<CanonicalStreamEvent, CanonicalStreamEvent>({
    transform(chunk, controller) {
      handler.handleEvent(chunk, (event) => controller.enqueue(event));
    },
    flush(controller) {
      handler.flush((event) => controller.enqueue(event));
    },
  }) as XMLToolInterceptorInstance;

  stream.transform = (events: AsyncIterable<CanonicalStreamEvent>) => applyXMLToolInterceptor(events);
  return stream;
}
