import { describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
import { createOAuthSessionId, redactAccount } from '../../src/admin/admin-router';

describe('credential redaction', () => {
  const secretAccount = {
    id: 'acc_test',
    providerId: 'kilo',
    authType: 'oauth',
    status: 'active',
    errorCount: 0,
    createdAt: 1,
    updatedAt: 1,
    credentials: {
      accessToken: 'SUPER_SECRET_ACCESS_TOKEN',
      refreshToken: 'SUPER_SECRET_REFRESH_TOKEN',
      apiKey: 'SUPER_SECRET_API_KEY',
      email: 'someone@example.com',
    },
  } as any;

  test('redactAccount removes every credential field', () => {
    const redacted = redactAccount(secretAccount);
    const wire = JSON.stringify(redacted);
    expect(wire).not.toContain('SUPER_SECRET_ACCESS_TOKEN');
    expect(wire).not.toContain('SUPER_SECRET_REFRESH_TOKEN');
    expect(wire).not.toContain('SUPER_SECRET_API_KEY');
    expect(wire).not.toContain('someone@example.com');
    expect((redacted as any).credentials).toBeUndefined();
    expect(redacted.id).toBe('acc_test');
  });

  test('OAuth session ids are unguessable UUIDs, not timestamps', () => {
    const id = createOAuthSessionId('cline');
    expect(id).toMatch(/^cline_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toMatch(/^\w+_1\d{12}$/);
    expect(createOAuthSessionId('cline')).not.toBe(id);
  });

  test('GET /api/accounts returns no credential material', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const auth = { Authorization: 'Bearer admin-secret' };
    await app.request('/api/accounts', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(secretAccount),
    });

    const res = await app.request('/api/accounts', { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('SUPER_SECRET_ACCESS_TOKEN');
    expect(body).not.toContain('SUPER_SECRET_REFRESH_TOKEN');
    expect(body).not.toContain('SUPER_SECRET_API_KEY');
    const json = JSON.parse(body);
    const listed = json.accounts.find((a: any) => a.id === 'acc_test');
    expect(listed).toBeDefined();
    expect(listed.credentials).toBeUndefined();
  });

  test('POST /api/accounts does not echo submitted credentials', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret',
      },
      body: JSON.stringify(secretAccount),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('SUPER_SECRET_ACCESS_TOKEN');
    expect(body).not.toContain('SUPER_SECRET_REFRESH_TOKEN');
    expect(body).not.toContain('SUPER_SECRET_API_KEY');
  });
});
