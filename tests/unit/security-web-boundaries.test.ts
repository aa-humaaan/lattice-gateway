import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { createServer } from '../../src/core/server';
import { isSafeUpstreamBaseUrl } from '../../src/core/config';

describe('upstream base URL allow-list', () => {
  test('allows public HTTPS endpoints', () => {
    expect(isSafeUpstreamBaseUrl('https://api.example.com/v1')).toBe(true);
  });

  test('allows explicit loopback for local engines', () => {
    expect(isSafeUpstreamBaseUrl('http://127.0.0.1:31415/v1')).toBe(true);
    expect(isSafeUpstreamBaseUrl('http://localhost:4000/v1')).toBe(true);
  });

  test('rejects cloud metadata and private network addresses', () => {
    expect(isSafeUpstreamBaseUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeUpstreamBaseUrl('http://10.0.0.5/v1')).toBe(false);
    expect(isSafeUpstreamBaseUrl('http://192.168.1.1/v1')).toBe(false);
    expect(isSafeUpstreamBaseUrl('http://172.16.0.1/v1')).toBe(false);
  });

  test('rejects non-HTTP schemes and malformed URLs', () => {
    expect(isSafeUpstreamBaseUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUpstreamBaseUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUpstreamBaseUrl('not a url')).toBe(false);
  });

  test('consentful import never carries an operator-supplied baseUrl into credentials', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { createImportManager } = await import('../../src/core/account-import');
    const { createFileSecretStore } = await import('../../src/core/secret-store');
    const { globalAccountPool } = await import('../../src/pool/account-pool');
    const dir = mkdtempSync(join(tmpdir(), 'lattice-ssrf-import-'));
    const file = join(dir, 'accounts.json');
    writeFileSync(file, JSON.stringify({ accounts: [
      { provider: 'opencode', baseUrl: 'http://169.254.169.254/latest/meta-data', apiKey: 'x' },
    ] }));
    try {
      const manager = createImportManager(createFileSecretStore(join(dir, 'secrets.json')));
      const result = manager.confirm(manager.preview('jsonAccounts', file).token);
      const account = globalAccountPool.getAccount(result.accountIds[0]);
      expect(account?.credentials.baseUrl).toBeUndefined();
      expect(JSON.stringify(account?.credentials)).not.toContain('169.254.169.254');
      for (const id of result.accountIds) globalAccountPool.deleteAccount(id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('account creation rejects an unsafe baseUrl', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
      },
      body: JSON.stringify({
        id: 'acc_ssrf',
        providerId: 'opencode',
        credentials: { apiKey: 'x', baseUrl: 'http://169.254.169.254/latest/meta-data' },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('dashboard output escaping', () => {
  const src = readFileSync('src/admin/dashboard-ui.ts', 'utf8');

  test('the shipped escapeHtml escapes quotes and angle brackets', () => {
    const start = src.indexOf('function escapeHtml(str) {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n    }', start);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end + '\n    }'.length);
    const escapeHtml = new Function(`return (${fn})`)() as (v: string) => string;
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('x" onmouseover="alert(1)')).toContain('&quot;');
    expect(escapeHtml("it's")).toContain('&#39;');
  });

  test('account fields and OAuth email are passed through escapeHtml', () => {
    expect(src).toMatch(/escapeHtml\(a\.id\)/);
    expect(src).toMatch(/escapeHtml\(a\.providerId\)/);
    expect(src).toMatch(/escapeHtml\(json\.email/);
  });

  test('quota cards escape account and item fields', () => {
    for (const pattern of [
      /escapeHtml\(card\.name\)/,
      /escapeHtml\(card\.email\)/,
      /escapeHtml\(card\.authType\)/,
      /escapeHtml\(card\.accountId\)/,
      /escapeHtml\(card\.status\)/,
      /escapeHtml\(item\.name\)/,
      /escapeHtml\(item\.resetFormatted\)/,
    ]) {
      expect(src).toMatch(pattern);
    }
  });
});
