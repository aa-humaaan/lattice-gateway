import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

function probe(mode: 'unknown-estimated' | 'reported'): any {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-pricing-probe-'));
  try {
    const result = spawnSync('bun', [join(import.meta.dir, '..', 'fixtures', 'pricing-ledger-probe.ts')], {
      env: {
        ...process.env,
        LATTICE_LEDGER_PATH: join(dir, 'ledger.ndjson'),
        PRICING_PROBE_MODE: mode,
      },
      encoding: 'utf8',
    });
    const line = result.stdout.split('\n').find((l) => l.startsWith('PRICING_PROBE:'));
    if (!line) throw new Error(`probe failed: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(line.slice('PRICING_PROBE:'.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
import {
  costUsd,
  costUsdForEvents,
  PRICING_EFFECTIVE_DATE,
  PRICING_SCHEMA_VERSION,
  priceForModel,
  rankRoutingCandidates,
  routingCost,
} from '../../src/core/pricing';
import type { PriceTable } from '../../src/core/pricing';

const PAID_MODEL = 'openai/gpt-4o';
const CUSTOM: PriceTable = {
  'free/model': { tier: 'free', promptUsdPerToken: 99, completionUsdPerToken: 99 },
  'paid/cheap': { tier: 'paid', promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 },
  'paid/expensive': { tier: 'paid', promptUsdPerToken: 0.00001, completionUsdPerToken: 0.00002 },
};

describe('versioned per-model pricing', () => {
  test('the price table is versioned and has an effective date', () => {
    expect(PRICING_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(PRICING_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a known model cost derives from its own prompt and completion prices', () => {
    expect(priceForModel(PAID_MODEL)).toBeDefined();
    expect(costUsd(PAID_MODEL, { promptTokens: 1_000_000, completionTokens: 100_000, estimated: false }))
      .toBe(3.5);
  });

  test('unknown and estimated usage have no cost', () => {
    expect(costUsd('unknown/model', { promptTokens: 1_000_000, completionTokens: 100_000, estimated: false }))
      .toBeNull();
    expect(costUsd(PAID_MODEL, { promptTokens: 1_000_000, completionTokens: 100_000, estimated: true }))
      .toBeNull();
  });

  test('free-tier models have no cost even when a price entry exists', () => {
    expect(costUsd('free/model', { promptTokens: 1_000_000, completionTokens: 100_000, estimated: false }, CUSTOM))
      .toBeNull();
    expect(routingCost('free/model', CUSTOM)).toBeNull();
  });

  test('cost is a routing input only for paid tiers', () => {
    const candidates = [
      { id: 'free', modelId: 'free/model' },
      { id: 'expensive', modelId: 'paid/expensive' },
      { id: 'cheap', modelId: 'paid/cheap' },
    ];
    // A free candidate disables cost-based ordering entirely.
    expect(rankRoutingCandidates(candidates, CUSTOM).map((c) => c.id))
      .toEqual(['free', 'expensive', 'cheap']);
    expect(rankRoutingCandidates(candidates.slice(1), CUSTOM).map((c) => c.id))
      .toEqual(['cheap', 'expensive']);
    expect(costUsdForEvents([
      { model: PAID_MODEL, promptTokens: 1_000_000, completionTokens: 100_000, estimated: false },
      { model: 'unknown/model', promptTokens: 5_000, completionTokens: 5_000, estimated: false },
      { model: PAID_MODEL, promptTokens: 1_000_000, completionTokens: 100_000, estimated: true },
    ])).toBe(3.5);
  });

  test('the resolver keeps a free-tier alias even when another candidate is cheaper', async () => {
    const { createModelResolver } = await import('../../src/utils/model-resolver');
    const models = [
      { id: 'lattice/1m-free', name: 'Free' },
      { id: 'auto', name: 'Auto alias' },
    ];
    const plugin = {
      id: 'stub', displayName: 'Stub', defaultBaseUrl: 'http://127.0.0.1:1',
      cachedModels: models,
      async listModels() { return models; },
      async execute() { throw new Error('not used'); },
      async executeStream() { throw new Error('not used'); },
    } as any;
    const resolver = createModelResolver(() => [plugin], {
      prices: {
        'lattice/1m-free': { tier: 'free', promptUsdPerToken: 99, completionUsdPerToken: 99 },
        'auto': { tier: 'paid', promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000001 },
      },
    });
    expect(resolver.resolveSync('auto').resolvedModel).toBe('lattice/1m-free');
  });

  test('the resolver ranks paid alias candidates by cost', async () => {
    const { createModelResolver } = await import('../../src/utils/model-resolver');
    const models = [
      { id: 'lattice/code-flagship', name: 'Flagship' },
      { id: 'claude-3-7-sonnet', name: 'Sonnet' },
    ];
    const plugin = {
      id: 'stub', displayName: 'Stub', defaultBaseUrl: 'http://127.0.0.1:1',
      cachedModels: models,
      async listModels() { return models; },
      async execute() { throw new Error('not used'); },
      async executeStream() { throw new Error('not used'); },
    } as any;
    const resolver = createModelResolver(() => [plugin], {
      prices: {
        'lattice/code-flagship': { tier: 'paid', promptUsdPerToken: 0.00001, completionUsdPerToken: 0.00001 },
        'claude-3-7-sonnet': { tier: 'paid', promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000001 },
      },
    });
    expect(resolver.resolveSync('claude-3-7-sonnet').resolvedModel).toBe('claude-3-7-sonnet');
  });

  test('telemetry reports null cost for unknown and estimated usage with an explicit label', () => {
    const { before, after, stats } = probe('unknown-estimated');
    expect(before.costUsd).toBeNull();
    expect(after.costUsd).toBeNull();
    expect(after.savedUsd).toBe('');
    expect(Object.values(after.providerCostUsd ?? {}).every((value) => value === null)).toBeTrue();
    expect(after.usageLabel).toBe('estimated');
    expect(after.pricingVersion).toBe(PRICING_SCHEMA_VERSION);
    expect(after.priceIsIllustrative).toBeFalse();
    expect(stats.totalCostUsd).toBeNull();
    expect(stats.totalCostSaved).toBeNull();
  });

  test('telemetry computes cost from reported tokens of a priced model', () => {
    const { before, after, stats } = probe('reported');
    expect(before.costUsd).toBeNull();
    expect(after.costUsd).toBeCloseTo(3.5, 6);
    expect(after.savedUsd).toBe('3.50');
    expect(Object.values(after.providerCostUsd ?? {}).some((value) => value === 3.5)).toBeTrue();
    expect(stats.totalCostUsd).toBeCloseTo(3.5, 6);
    expect(stats.totalCostSaved).toBeCloseTo(3.5, 6);
  });

  // SOURCE GUARD: the dashboard is inline script text with no importable API,
  // so its estimate label can only be verified by reading the shipped file.
  test('SOURCE GUARD: dashboard labels estimated usage', () => {
    const src = readFileSync('src/admin/dashboard-ui.ts', 'utf8');
    expect(src).toContain('id="usage-cost-label"');
    expect(src).toContain('Estimated usage');
  });
});
