import { normalizeOpenAIChat, normalizeAnthropicMessages, normalizeOpenAIResponses } from '../engine/dialect/normalizer';
import { serializeOpenAIChat, serializeAnthropicMessage, serializeOpenAIResponse } from '../engine/dialect/serializer';
import type { CanonicalResponse } from '../core/types/canonical';
import type { CanonicalStreamEvent } from '../core/types/canonical';
import { createOpenAISSEStream, createAnthropicSSEStream, createResponsesSSEStream } from '../engine/dialect/stream-adapter';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export type ConformanceDialect = 'openai-chat' | 'anthropic-messages' | 'openai-responses';
export type ConformanceFeature = 'plain-text' | 'tool-loop' | 'error' | 'client-abort';
export interface ConformanceFixture {
  name: string;
  dialect: ConformanceDialect;
  feature?: ConformanceFeature;
  request: unknown;
  canonicalExpect: Record<string, unknown>;
  response: CanonicalResponse;
  responseExpect: Record<string, unknown>;
  streamEvents?: CanonicalStreamEvent[];
  /** Ordered, field-level assertions against the emitted SSE events. */
  streamExpectEvents?: Array<{ type: string; fields?: Record<string, unknown> }>;
  streamContains?: string[];
  /** Abort the client after this many canonical events are consumed. */
  abortAfter?: number;
  streamStatus?: 'unsupported';
}
export interface ConformanceFailure { stage: 'canonical' | 'response' | 'stream'; path: string; expected: unknown; actual: unknown }
export interface ConformanceResult { name: string; dialect: ConformanceDialect; passed: boolean; streamStatus: 'passed' | 'not-tested' | 'unsupported'; failures: ConformanceFailure[] }

function valueAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) =>
    value != null && typeof value === 'object' ? (value as any)[key] : undefined, root);
}

interface EmittedEvent { type: string; payload: any }

/** Parse SSE frames into an ordered list. Chat emits data-only frames, so its
 *  event identity comes from the payload (`object`, or `error`); other dialects
 *  carry an explicit `event:` name. */
function parseSse(text: string): EmittedEvent[] {
  const emitted: EmittedEvent[] = [];
  for (const block of text.split(/\n\n/)) {
    const lines = block.split(/\r?\n/);
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const data = dataLine.slice(5).trim();
    if (data === '[DONE]') {
      emitted.push({ type: '[DONE]', payload: undefined });
      continue;
    }
    const payload = JSON.parse(data);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const type = eventLine
      ? eventLine.slice(6).trim()
      : payload?.object ?? (payload?.error ? 'error' : payload?.type);
    emitted.push({ type, payload });
  }
  return emitted;
}

export async function runConformanceFixture(fixture: ConformanceFixture): Promise<ConformanceResult> {
  if (!fixture?.name || !['openai-chat', 'anthropic-messages', 'openai-responses'].includes(fixture.dialect)) {
    throw new Error('Invalid conformance fixture: dialect and name are required');
  }
  if (!fixture.canonicalExpect || !fixture.responseExpect || !fixture.response) {
    throw new Error('Invalid conformance fixture: expectations and response are required');
  }
  const canonical = fixture.dialect === 'openai-chat'
    ? normalizeOpenAIChat(fixture.request, 'conformance')
    : fixture.dialect === 'anthropic-messages'
      ? normalizeAnthropicMessages(fixture.request, 'conformance')
      : normalizeOpenAIResponses(fixture.request, 'conformance');
  const response = fixture.dialect === 'openai-chat'
    ? serializeOpenAIChat(fixture.response)
    : fixture.dialect === 'anthropic-messages'
      ? serializeAnthropicMessage(fixture.response)
      : serializeOpenAIResponse(fixture.response);
  const failures: ConformanceFailure[] = [];
  for (const [stage, root, expected] of [
    ['canonical', canonical, fixture.canonicalExpect],
    ['response', response, fixture.responseExpect],
  ] as const) {
    for (const [path, wanted] of Object.entries(expected)) {
      const actual = valueAt(root, path);
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push({ stage, path, expected: wanted, actual });
    }
  }
  let streamStatus: ConformanceResult['streamStatus'] = fixture.streamStatus ?? 'not-tested';
  if (fixture.streamEvents) {
    const controller = new AbortController();
    async function* events() {
      let consumed = 0;
      for (const event of fixture.streamEvents!) {
        yield event;
        consumed++;
        if (fixture.abortAfter === consumed) controller.abort();
      }
    }
    const options = { keepaliveMs: 0, signal: controller.signal };
    const stream = fixture.dialect === 'anthropic-messages'
      ? createAnthropicSSEStream(events(), options)
      : fixture.dialect === 'openai-responses'
        ? createResponsesSSEStream(events(), options)
        : createOpenAISSEStream(events(), options);
    const text = await new Response(stream).text();
    for (const expected of fixture.streamContains ?? []) {
      if (!text.includes(expected)) failures.push({ stage: 'stream', path: 'contains', expected, actual: text });
    }
    if (fixture.streamExpectEvents) {
      const emitted = parseSse(text);
      if (emitted.length !== fixture.streamExpectEvents.length) {
        failures.push({
          stage: 'stream',
          path: 'events.length',
          expected: fixture.streamExpectEvents.length,
          actual: emitted.length,
        });
      }
      fixture.streamExpectEvents.forEach((expected, index) => {
        const actual = emitted[index];
        if (!actual) {
          failures.push({ stage: 'stream', path: `events[${index}].type`, expected: expected.type, actual: undefined });
          return;
        }
        if (actual.type !== expected.type) {
          failures.push({ stage: 'stream', path: `events[${index}].type`, expected: expected.type, actual: actual.type });
        }
        if (actual.payload && Object.prototype.hasOwnProperty.call(actual.payload, 'type')
            && actual.payload.type !== expected.type) {
          failures.push({ stage: 'stream', path: `events[${index}].payload.type`, expected: expected.type, actual: actual.payload.type });
        }
        for (const [path, wanted] of Object.entries(expected.fields ?? {})) {
          const got = valueAt(actual.payload, path);
          if (JSON.stringify(got) !== JSON.stringify(wanted)) {
            failures.push({ stage: 'stream', path: `events[${index}].${path}`, expected: wanted, actual: got });
          }
        }
      });
    }
    streamStatus = 'passed';
  }
  return { name: fixture.name, dialect: fixture.dialect, passed: failures.length === 0, streamStatus, failures };
}

export async function runConformanceDirectory(directory: string): Promise<ConformanceResult[]> {
  const files: string[] = [];
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) files.push(full);
    }
  }
  walk(directory);
  const results = await Promise.all(files.sort().map((file) =>
    runConformanceFixture(JSON.parse(readFileSync(file, 'utf8')) as ConformanceFixture)));
  return results.sort((a, b) => `${a.dialect}/${a.name}`.localeCompare(`${b.dialect}/${b.name}`));
}
