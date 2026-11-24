import { CanonicalStreamEvent } from '../../core/types/canonical';

export const MAX_XML_BUFFER_BYTES = 4096;

export interface ParsedXMLToolCall {
  name: string;
  arguments: string;
}

const ADVERTISED_TAGS = ['tool_call', 'invoke', 'function_call', 'function_calls'] as const;
type AdvertisedTag = (typeof ADVERTISED_TAGS)[number];

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** Decode named and numeric XML entities without recursive regex replacement. */
export function decodeEntities(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '&') {
      out += value[i++];
      continue;
    }
    const semi = value.indexOf(';', i + 1);
    if (semi === -1 || semi - i > 16) {
      out += value[i++];
      continue;
    }
    const body = value.slice(i + 1, semi);
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        out += String.fromCodePoint(code);
        i = semi + 1;
        continue;
      }
    } else if (ENTITIES[body] !== undefined) {
      out += ENTITIES[body];
      i = semi + 1;
      continue;
    }
    out += value[i++];
  }
  return out;
}

interface Token {
  type: 'text' | 'open' | 'close';
  name: string;
  attrs: Record<string, string>;
  raw: string;
}

/** Character scanner: no regular expressions drive tag recognition. */
function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      text += xml[i++];
      continue;
    }
    const next = xml[i + 1];
    if (!next || !(/[a-zA-Z]/.test(next) || (next === '/' && /[a-zA-Z]/.test(xml[i + 2] ?? '')))) {
      // A bare '<' (e.g. heredoc `<< 'EOF'`) is text, not a tag.
      text += xml[i++];
      continue;
    }
    const end = xml.indexOf('>', i + 1);
    if (end === -1) {
      text += xml.slice(i);
      break;
    }
    if (text) {
      tokens.push({ type: 'text', name: '', attrs: {}, raw: text });
      text = '';
    }
    const raw = xml.slice(i, end + 1);
    let inner = xml.slice(i + 1, end).trim();
    const closing = inner.startsWith('/');
    if (closing) inner = inner.slice(1).trim();
    if (inner.endsWith('/')) inner = inner.slice(0, -1).trim();

    let name = '';
    let p = 0;
    while (p < inner.length && !/[\s=/]/.test(inner[p])) name += inner[p++];
    const attrs: Record<string, string> = {};
    while (p < inner.length) {
      while (p < inner.length && /\s/.test(inner[p])) p++;
      if (p >= inner.length) break;
      let key = '';
      while (p < inner.length && !/[\s=]/.test(inner[p])) key += inner[p++];
      while (p < inner.length && /\s/.test(inner[p])) p++;
      if (inner[p] !== '=') {
        if (key) attrs[key] = 'true';
        continue;
      }
      // Legacy shape <function=name> has no attribute key.
      if (!key) key = 'value';
      p++;
      while (p < inner.length && /\s/.test(inner[p])) p++;
      const quote = inner[p] === '"' || inner[p] === "'" ? inner[p++] : '';
      let value = '';
      while (p < inner.length && (quote ? inner[p] !== quote : !/\s/.test(inner[p]))) {
        value += inner[p++];
      }
      if (quote && inner[p] === quote) p++;
      if (key) attrs[decodeEntities(key)] = decodeEntities(value);
    }
    tokens.push({
      type: closing ? 'close' : 'open',
      name: name.toLowerCase(),
      attrs,
      raw,
    });
    i = end + 1;
  }
  if (text) tokens.push({ type: 'text', name: '', attrs: {}, raw: text });
  return tokens;
}

function textBetween(tokens: Token[], start: number, end: number): string {
  let raw = '';
  // Keep nested markup verbatim inside parameter values; callers decode entities.
  for (let i = start; i < end; i++) raw += tokens[i].raw;
  return decodeEntities(raw).trim();
}

function parseObject(value: string): Record<string, unknown> | null {
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectParameters(tokens: Token[], start: number, end: number): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (token.type !== 'open' || token.name !== 'parameter') continue;
    const key = token.attrs.name ?? token.attrs.value;
    if (!key) continue;
    let close = i + 1;
    while (close < end && !(tokens[close].type === 'close' && tokens[close].name === 'parameter')) {
      close++;
    }
    if (close >= end) continue; // unclosed parameter carries no value
    const raw = textBetween(tokens, i + 1, close);
    const asObject = parseObject(raw);
    params[key] = asObject ?? (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    })();
    i = close;
  }
  return params;
}

function parseCalls(xml: string): ParsedXMLToolCall[] {
  const tokens = tokenize(xml);
  const calls: ParsedXMLToolCall[] = [];

  const parseBlock = (start: number, end: number, declaredName?: string): void => {
    const directText = textBetween(tokens, start, end);
    const asObject = parseObject(directText);
    if (asObject && typeof asObject.name === 'string') {
      calls.push({
        name: asObject.name,
        arguments:
          typeof asObject.arguments === 'string'
            ? asObject.arguments
            : JSON.stringify(asObject.arguments ?? {}),
      });
      return;
    }

    let name = declaredName ?? '';
    let bodyStart = start;
    for (let i = start; i < end; i++) {
      const token = tokens[i];
      if (token.type === 'open' && (token.name === 'function' || token.name === 'function_call')) {
        name = token.attrs.name ?? token.attrs.value ?? name;
        bodyStart = i + 1;
        break;
      }
    }

    const nested = collectParameters(tokens, bodyStart, end);
    const parametersTag = tokens.findIndex(
      (token, idx) =>
        idx >= bodyStart && idx < end && token.type === 'open' && token.name === 'parameters'
    );
    if (parametersTag !== -1) {
      let close = parametersTag + 1;
      while (close < end && !(tokens[close].type === 'close' && tokens[close].name === 'parameters')) {
        close++;
      }
      const json = textBetween(tokens, parametersTag + 1, close);
      if (parseObject(json)) {
        calls.push({ name, arguments: json });
        return;
      }
    }
    calls.push({ name, arguments: JSON.stringify(nested) });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'open' || !ADVERTISED_TAGS.includes(token.name as AdvertisedTag)) continue;
    let close = i + 1;
    let depth = 1;
    while (close < tokens.length && depth > 0) {
      if (tokens[close].type === 'open' && tokens[close].name === token.name) depth++;
      if (tokens[close].type === 'close' && tokens[close].name === token.name) depth--;
      if (depth > 0) close++;
    }

    if (token.name === 'function_calls') {
      for (let j = i + 1; j < close; j++) {
        if (tokens[j].type === 'open' && tokens[j].name === 'function_call') {
          let childClose = j + 1;
          let childDepth = 1;
          while (
            childClose < close &&
            childDepth > 0
          ) {
            if (tokens[childClose].type === 'open' && tokens[childClose].name === 'function_call') childDepth++;
            if (tokens[childClose].type === 'close' && tokens[childClose].name === 'function_call') childDepth--;
            if (childDepth > 0) childClose++;
          }
          parseBlock(j + 1, childClose, tokens[j].attrs.name);
          j = childClose;
        }
      }
    } else {
      parseBlock(i + 1, close, token.attrs.name);
    }
    i = close;
  }
  return calls.filter((call) => call.name.length > 0);
}

export function parseXMLToolCall(xml: string): ParsedXMLToolCall | null {
  return parseCalls(xml)[0] ?? null;
}

/** True when the buffer starts with an advertised tag, or a partial one. */
function advertisedPrefix(buffer: string): { tag: AdvertisedTag | null; partial: boolean } {
  const lower = buffer.toLowerCase();
  for (const tag of ADVERTISED_TAGS) {
    const open = `<${tag}`;
    if (lower === open || lower.startsWith(`${open}>`) || lower.startsWith(`${open} `) || lower.startsWith(`${open}/`)) {
      return { tag, partial: false };
    }
    if (open.startsWith(lower) && lower.length >= 1) return { tag: null, partial: true };
  }
  return { tag: null, partial: false };
}

function closingTag(tag: AdvertisedTag): string {
  return `</${tag}>`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Clip text to a byte budget without splitting a UTF-8 code point. */
function clipBytes(value: string, limit: number): string {
  let out = '';
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > limit) break;
    out += char;
    used += size;
  }
  return out;
}

export class XMLToolInterceptorHandler {
  private buffer = '';
  private isBuffering = false;
  private activeTag: AdvertisedTag | null = null;
  private toolCallIndex = 0;
  private hasEmittedToolCalls = false;

  public handleEvent(
    event: CanonicalStreamEvent,
    emit: (event: CanonicalStreamEvent) => void
  ): void {
    if (event.type !== 'text_delta') {
      if (event.type === 'tool_call_start' || event.type === 'tool_call_delta') {
        this.hasEmittedToolCalls = true;
      }
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

    this.buffer += event.delta;
    this.processBuffer(emit);
  }

  private emitCalls(calls: ParsedXMLToolCall[], emit: (event: CanonicalStreamEvent) => void): void {
    for (const call of calls) {
      const callId = `call_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      emit({
        type: 'tool_call_start',
        index: this.toolCallIndex,
        id: callId,
        name: call.name,
      });
      emit({
        type: 'tool_call_delta',
        index: this.toolCallIndex,
        argumentsDelta: call.arguments,
      });
      emit({ type: 'tool_call_stop', index: this.toolCallIndex });
      this.toolCallIndex++;
      this.hasEmittedToolCalls = true;
    }
  }

  private processBuffer(emit: (event: CanonicalStreamEvent) => void): void {
    while (this.buffer.length > 0) {
      if (!this.isBuffering) {
        const tagIndex = this.buffer.indexOf('<');
        if (tagIndex === -1) {
          this.emitText(this.buffer, emit);
          this.buffer = '';
          return;
        }
        if (tagIndex > 0) {
          this.emitText(this.buffer.slice(0, tagIndex), emit);
          this.buffer = this.buffer.slice(tagIndex);
        }

        const { tag, partial } = advertisedPrefix(this.buffer);
        if (tag) {
          this.isBuffering = true;
          this.activeTag = tag;
        } else if (partial && byteLength(this.buffer) <= MAX_XML_BUFFER_BYTES) {
          return;
        } else {
          // A false tag: preserve the existing behaviour of flushing it verbatim.
          this.emitText(this.buffer.slice(0, 1), emit);
          this.buffer = this.buffer.slice(1);
        }
      }

      if (!this.isBuffering) continue;

      // Check the byte budget before consuming a close tag: a complete but
      // oversized XML payload must not be parsed into a tool call.
      if (byteLength(this.buffer) > MAX_XML_BUFFER_BYTES) {
        // Keep the human-readable payload as text, clipped to the byte cap,
        // but never hand markup itself to the client.
        const openEnd = this.buffer.indexOf('>');
        const closeStart = this.buffer.toLowerCase().indexOf(closingTag(this.activeTag!));
        const whole = this.buffer;
        this.buffer = '';
        this.isBuffering = false;
        this.activeTag = null;
        if (closeStart === -1) {
          // No closing tag: it is not (yet) evidence of a tool call, so keep
          // the text verbatim rather than swallowing real conversation.
          this.emitText(whole, emit);
        } else {
          const payload = whole.slice(openEnd + 1, closeStart);
          this.emitText(clipBytes(decodeEntities(payload), MAX_XML_BUFFER_BYTES), emit);
        }
        return;
      }

      const close = this.buffer.toLowerCase().indexOf(closingTag(this.activeTag!), 1);
      if (close !== -1) {
        const endIndex = close + closingTag(this.activeTag!).length;
        const fullXml = this.buffer.slice(0, endIndex);
        this.buffer = this.buffer.slice(endIndex);
        this.isBuffering = false;
        this.activeTag = null;
        // Malformed advertised XML is dropped, never leaked as text.
        this.emitCalls(parseCalls(fullXml), emit);
        continue;
      }

      if (byteLength(this.buffer) > MAX_XML_BUFFER_BYTES) {
        // Over-budget advertised XML is discarded; preceding plain text has
        // already been flushed. No raw markup reaches the client.
        this.buffer = '';
        this.isBuffering = false;
        this.activeTag = null;
        return;
      }
      return;
    }
  }

  private emitText(delta: string, emit: (event: CanonicalStreamEvent) => void): void {
    if (delta) emit({ type: 'text_delta', delta });
  }

  public flush(emit: (event: CanonicalStreamEvent) => void): void {
    this.flushBuffer(emit);
  }

  private flushBuffer(emit: (event: CanonicalStreamEvent) => void): void {
    if (!this.buffer) return;
    if (this.isBuffering) {
      const parsed = parseCalls(this.buffer);
      const unfinished = this.buffer;
      this.buffer = '';
      this.isBuffering = false;
      this.activeTag = null;
      if (parsed.length > 0) this.emitCalls(parsed, emit);
      else this.emitText(unfinished, emit);
      return;
    }
    this.emitText(this.buffer, emit);
    this.buffer = '';
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
    for (const q of queue) yield q;
  }
  const flushQueue: CanonicalStreamEvent[] = [];
  handler.flush((out) => flushQueue.push(out));
  for (const q of flushQueue) yield q;
}

export interface XMLToolInterceptorInstance extends TransformStream<CanonicalStreamEvent, CanonicalStreamEvent> {
  transform(events: AsyncIterable<CanonicalStreamEvent>): AsyncIterable<CanonicalStreamEvent>;
}

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
