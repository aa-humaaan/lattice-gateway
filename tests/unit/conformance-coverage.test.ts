import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runConformanceFixture, runConformanceDirectory } from '../../src/conformance/runner';
import type { ConformanceFixture } from '../../src/conformance/runner';

// Every supported dialect must assert ordered events with field-level payload
// checks for each major feature, not just substrings of the SSE text.
const FEATURES = ['plain-text', 'tool-loop', 'error', 'client-abort'] as const;
const DIALECTS = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
const fixtureDir = join(process.cwd(), 'conformance', 'fixtures');

function load(dialect: string, file: string): ConformanceFixture {
  return JSON.parse(readFileSync(join(fixtureDir, dialect, file), 'utf8')) as ConformanceFixture;
}

describe('P2-4 conformance coverage', () => {
  test('each dialect has an ordered, field-level fixture for every major feature', async () => {
    const all = await runConformanceDirectory(fixtureDir);
    for (const dialect of DIALECTS) {
      for (const feature of FEATURES) {
        const matches = all.filter((result) =>
          result.dialect === dialect && result.name.startsWith(`${feature}-`));
        expect(matches.length, `${dialect}/${feature}`).toBe(1);
        expect(matches[0].passed, `${dialect}/${feature}`).toBeTrue();
      }
    }
  });

  test('every shipped fixture uses ordered event assertions, not substring checks', async () => {
    const all = await runConformanceDirectory(fixtureDir);
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const result of all) {
      expect(result.streamStatus, result.name).toBe('passed');
    }
  });

  test('a client-abort fixture emits no terminal event after the abort', async () => {
    const fixture = load('openai-responses', 'client-abort.json');
    const result = await runConformanceFixture(fixture);
    expect(result.failures).toEqual([]);
    const terminal = (fixture.streamExpectEvents ?? []).filter((event) =>
      ['response.completed', 'response.failed', 'error'].includes(event.type));
    expect(terminal).toEqual([]);
  });

  test('renaming an expected event name fails the fixture', async () => {
    const fixture = structuredClone(load('openai-responses', 'basic.json'));
    fixture.streamExpectEvents![0].type = 'response.created.renamed';
    const result = await runConformanceFixture(fixture);
    expect(result.passed).toBeFalse();
  });

  test('dropping an expected payload field fails the fixture', async () => {
    const fixture = structuredClone(load('openai-responses', 'basic.json'));
    fixture.responseExpect['object'] = 'response.renamed';
    const result = await runConformanceFixture(fixture);
    expect(result.passed).toBeFalse();
  });
});
