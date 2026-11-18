import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLedger, type LedgerEvent } from '../../src/core/request-ledger';

function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    timestamp: Date.now(),
    method: 'POST',
    path: '/v1/chat/completions',
    provider: 'kilo',
    model: 'kilo/test',
    status: 200,
    latencyMs: 120,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimated: false,
    ...overrides,
  };
}

describe('request ledger', () => {
  test('a fresh ledger reports zero, not seeded numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-ledger-'));
    try {
      const ledger = createLedger(join(dir, 'ledger.ndjson'));
      const metrics = ledger.metrics();
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.promptTokens).toBe(0);
      expect(metrics.completionTokens).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appended events are persisted and counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-ledger-'));
    try {
      const path = join(dir, 'ledger.ndjson');
      const first = createLedger(path);
      first.append(event());
      first.append(event({ provider: 'nous', promptTokens: 40, completionTokens: 10, totalTokens: 50, status: 500 }));
      const second = createLedger(path);
      const metrics = second.metrics();
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.totalTokens).toBe(200);
      expect(metrics.promptTokens).toBe(140);
      expect(metrics.completionTokens).toBe(60);
      expect(metrics.providerTokens.kilo.total).toBe(150);
      expect(metrics.providerTokens.nous.total).toBe(50);
      expect(metrics.providerRequests.kilo).toBe(1);
      expect(metrics.providerRequests.nous).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('metrics can be scoped to a time window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-ledger-'));
    try {
      const ledger = createLedger(join(dir, 'ledger.ndjson'));
      ledger.append(event({ timestamp: Date.now() - 10 * 24 * 3600 * 1000 }));
      ledger.append(event({ timestamp: Date.now() }));
      expect(ledger.metrics().totalRequests).toBe(2);
      expect(ledger.metrics(Date.now() - 24 * 3600 * 1000).totalRequests).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readRecent returns newest events first and honours the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-ledger-'));
    try {
      const ledger = createLedger(join(dir, 'ledger.ndjson'));
      ledger.append(event({ model: 'first' }));
      ledger.append(event({ model: 'second' }));
      ledger.append(event({ model: 'third' }));
      const recent = ledger.readRecent(2);
      expect(recent.map((e) => e.model)).toEqual(['third', 'second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a truncated or corrupt final line does not break the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-ledger-'));
    try {
      const path = join(dir, 'ledger.ndjson');
      const ledger = createLedger(path);
      ledger.append(event());
      const { appendFileSync } = require('fs');
      appendFileSync(path, '{"partial":');
      expect(ledger.readRecent(10)).toHaveLength(1);
      expect(ledger.metrics().totalRequests).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
