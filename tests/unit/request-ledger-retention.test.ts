import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLedger, type LedgerEvent } from '../../src/core/request-ledger';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lattice-ledger-p16-'));
}

function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    timestamp: 1_000_000,
    method: 'POST',
    path: '/v1/chat/completions',
    provider: 'kilo',
    model: 'kilo/model',
    status: 200,
    latencyMs: 10,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    ...overrides,
  };
}

describe('P1-6 request ledger', () => {
  test('a provider named __proto__ cannot pollute the metrics object', () => {
    const dir = tempDir();
    try {
      const ledger = createLedger(join(dir, 'ledger.ndjson'), { now: () => 1_000_000 });
      ledger.append(event({ provider: '__proto__', promptTokens: 3, totalTokens: 3 }));
      const metrics = ledger.metrics();
      expect(({} as any).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(metrics.providerTokens, '__proto__')).toBe(true);
      expect(metrics.providerTokens['__proto__'].total).toBe(3);
      expect(metrics.providerRequests['__proto__']).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a truncated last line is repaired on load, not fatal', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'ledger.ndjson');
      const valid = event({ requestId: 'valid' });
      writeFileSync(path, `${JSON.stringify(valid)}\n{"requestId":"cut off"`);
      const ledger = createLedger(path, { now: () => 1_000_000 });
      expect(readFileSync(path, 'utf8')).not.toContain('cut off');
      expect(ledger.metrics().totalRequests).toBe(1);
      expect(ledger.readRecent(5)[0].requestId).toBe('valid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('records older than the retention TTL are removed', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'ledger.ndjson');
      let now = 995_000;
      const ledger = createLedger(path, { retentionMs: 1000, now: () => now });
      ledger.append(event({ requestId: 'old', timestamp: now }));
      now = 1_000_000;
      ledger.append(event({ requestId: 'fresh', timestamp: now }));
      expect(ledger.prune()).toBe(1);
      expect(readFileSync(path, 'utf8')).not.toContain('old');
      expect(readFileSync(path, 'utf8')).toContain('fresh');
      expect(ledger.metrics().totalRequests).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the active file rotates once it exceeds the size limit', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'ledger.ndjson');
      const ledger = createLedger(path, { maxFileBytes: 300, now: () => 1_000_000 });
      for (let i = 0; i < 20; i++) {
        ledger.append(event({ requestId: `req-${i}`, model: 'kilo/a-model-with-a-long-name' }));
      }
      expect(ledger.stats().rotatedFiles).toBeGreaterThan(0);
      expect(existsSync(path)).toBe(true);
      expect(readdirSync(dir).some((f) => f !== 'ledger.ndjson')).toBe(true);
      expect(ledger.metrics().totalRequests).toBe(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('metrics query time is independent of ledger size (10k vs 1M rows)', () => {
    const dir = tempDir();
    try {
      const sizes = [10_000, 1_000_000];
      const timings: number[] = [];
      for (const rows of sizes) {
        const path = join(dir, `ledger-${rows}.ndjson`);
        const line = `${JSON.stringify(event({ timestamp: 1_000_000 }))}\n`;
        writeFileSync(path, line.repeat(rows));
        const ledger = createLedger(path, { now: () => 1_000_000 });
        const started = performance.now();
        for (let i = 0; i < 5; i++) ledger.metrics(999_000);
        timings.push(performance.now() - started);
        expect(ledger.metrics().totalRequests).toBe(rows);
      }
      console.log('P1-6 metrics ms (10k, 1M):', timings.map((t) => t.toFixed(2)));
      expect(timings[1]).toBeLessThan(timings[0] * 3 + 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
