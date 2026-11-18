import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('no fabricated telemetry ships', () => {
  const router = readFileSync('src/admin/admin-router.ts', 'utf8');
  const catalog = readFileSync('src/admin/models-catalog.ts', 'utf8');

  test('no seeded counters, multipliers or fake log rows', () => {
    expect(router).not.toContain('524300');
    expect(router).not.toContain('813700');
    expect(router).not.toContain('let multiplier');
    expect(router).not.toContain('effectiveLogs = [');
    expect(router).not.toContain('/api/telemetry/simulate');
  });

  test('no random measurements', () => {
    expect(catalog).not.toContain('Math.random');
    expect(router).not.toContain('Math.random');
  });

  test('README does not advertise proxy rotation or uTLS', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).not.toContain('Egress Proxy Manager');
    expect(readme).not.toContain('uTLS Bun ClientHello');
    expect(readme).not.toContain('(uTLS Bun / 0$)');
    expect(readme).not.toContain('egress proxy rotation');
  });

  test('telemetry and usage endpoints derive from the ledger', () => {
    expect(router).toContain('requestLedger.metrics()');
    expect(router).toContain('requestLedger.readRecent(');
  });
});
