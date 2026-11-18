import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLedger, type LedgerEvent } from '../../src/core/request-ledger';
import { buildReceipt, findLedgerEvent } from '../../src/core/receipt';

const event: LedgerEvent = {
  requestId: 'req_lat_abc123def456',
  timestamp: 1700000000000,
  method: 'POST',
  path: '/v1/chat/completions',
  provider: 'kilo',
  model: 'kilo/model',
  status: 200,
  latencyMs: 145,
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  estimated: false,
};

function withFile(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-receipt-'));
  try { run(join(dir, 'ledger.ndjson')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('receipts', () => {
  test('finds an event by full request id and by prefix', () => {
    withFile((file) => {
      const ledger = createLedger(file);
      ledger.append(event);
      expect(findLedgerEvent(ledger, 'req_lat_abc123def456')?.provider).toBe('kilo');
      expect(findLedgerEvent(ledger, 'abc123')?.provider).toBe('kilo');
    });
  });

  test('returns undefined for an unknown id', () => {
    withFile((file) => {
      const ledger = createLedger(file);
      ledger.append(event);
      expect(findLedgerEvent(ledger, 'nope')).toBeUndefined();
    });
  });

  test('buildReceipt states the real outcome and flags estimates', () => {
    const receipt = buildReceipt(event);
    expect(receipt.requestId).toBe('req_lat_abc123def456');
    expect(receipt.provider).toBe('kilo');
    expect(receipt.model).toBe('kilo/model');
    expect(receipt.status).toBe(200);
    expect(receipt.latencyMs).toBe(145);
    expect(receipt.totalTokens).toBe(150);
    expect(receipt.estimated).toBeFalse();
    expect(receipt.lines.join('\n')).toContain('200');
  });

  test('a failed receipt says so explicitly', () => {
    const receipt = buildReceipt({ ...event, status: 502 });
    expect(receipt.lines.join('\n')).toContain('failed');
  });

  test('a corrupt ledger line does not break a lookup', () => {
    withFile((file) => {
      writeFileSync(file, '{broken\n' + JSON.stringify(event) + '\n');
      const ledger = createLedger(file);
      expect(findLedgerEvent(ledger, 'abc123')?.model).toBe('kilo/model');
    });
  });
});
