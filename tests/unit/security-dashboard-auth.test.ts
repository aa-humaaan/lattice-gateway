import { describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
import { getDashboardHtml } from '../../src/admin/dashboard-ui';

describe('admin dashboard authentication', () => {
  test('dashboard HTML loads without a token while its APIs stay locked', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    expect((await app.request('/admin')).status).toBe(200);
    expect((await app.request('/api/accounts')).status).toBe(401);
  });

  test('shipped dashboard attaches the operator token to every API fetch', async () => {
    const html = getDashboardHtml();
    const start = html.indexOf('// ADMIN_TOKEN_BOOTSTRAP_START');
    const end = html.indexOf('// ADMIN_TOKEN_BOOTSTRAP_END', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const bootstrap = html.slice(start, end);

    const savedWindow = (globalThis as any).window;
    const savedStorage = (globalThis as any).sessionStorage;
    const store = new Map<string, string>();
    let captured: any;
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    (globalThis as any).window = {
      prompt: () => 'admin-token-from-operator',
      fetch: (_input: any, init: any) => {
        captured = init;
        return Promise.resolve({ ok: true });
      },
    };
    try {
      new Function(bootstrap)();
      await (globalThis as any).window.fetch('/api/accounts', { method: 'GET' });
      expect(store.get('lattice-admin-token')).toBe('admin-token-from-operator');
      expect(captured.headers.get('Authorization')).toBe('Bearer admin-token-from-operator');
    } finally {
      (globalThis as any).window = savedWindow;
      (globalThis as any).sessionStorage = savedStorage;
    }
  });

  test('a loopback origin on an unlisted port is rejected', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const res = await app.request('/v1/models', {
      headers: { Origin: 'http://127.0.0.1:4001' },
    });
    expect(res.status).toBe(403);
  });

  test('the default dashboard origin keeps working with a configured admin token', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const html = await app.request('/admin', {
      headers: { Origin: 'http://127.0.0.1:4000' },
    });
    expect(html.status).toBe(200);
    const api = await app.request('/api/accounts', {
      headers: {
        Origin: 'http://127.0.0.1:4000',
        Authorization: 'Bearer admin-secret',
      },
    });
    expect(api.status).toBe(200);
  });
});
