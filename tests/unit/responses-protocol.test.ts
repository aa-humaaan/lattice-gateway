import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runConformanceFixture } from '../../src/conformance/runner';
import type { ConformanceFixture } from '../../src/conformance/runner';

// Protocol source (fetched 2026-11-20):
// https://developers.openai.com/api/reference/resources/responses/streaming-events
// Documents response.created, response.output_text.delta (ResponseTextDeltaEvent:
// content_index/delta/item_id), response.reasoning_summary_text.delta,
// response.output_item.added/done, response.function_call_arguments.delta,
// `error` (ResponseErrorEvent: type/code/message/param) and `response.failed`
// (ResponseFailedEvent with response.status "failed"). FunctionCall.call_id is
// documented on the same page as "The unique ID of the function tool call".
const fixtureDir = join(process.cwd(), 'conformance', 'fixtures', 'openai-responses');
const load = (name: string): ConformanceFixture =>
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as ConformanceFixture;

describe('P0-2: /v1/responses event-level conformance', () => {
  it('accepts the documented tool-loop event sequence', async () => {
    const result = await runConformanceFixture(load('tool-loop-events.json'));
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('rejects a non-standard delta event name (the old response.output_stream.delta)', async () => {
    const bad = structuredClone(load('tool-loop-events.json'));
    bad.streamExpectEvents![1].type = 'response.output_stream.delta';
    const result = await runConformanceFixture(bad);
    expect(result.passed).toBe(false);
  });

  it('accepts the documented error and failure event sequence', async () => {
    const result = await runConformanceFixture(load('failure-event.json'));
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('rejects a missing failure event', async () => {
    const bad = structuredClone(load('failure-event.json'));
    bad.streamExpectEvents = bad.streamExpectEvents!.filter((e) => e.type !== 'response.failed');
    bad.streamEvents = bad.streamEvents!.filter((e) => e.type !== 'stream_error');
    const result = await runConformanceFixture(bad);
    expect(result.passed).toBe(false); // the required error event is no longer emitted
  });
});
