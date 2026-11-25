import { describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';

describe('P2-2 admin/gateway privilege separation', () => {
  test('a gateway token does not unlock admin APIs when no admin token is configured', async () => {
    const app = createServer({ gatewayToken: 'gateway-only' });
    const res = await app.request('/api/accounts', {
      headers: { Authorization: 'Bearer gateway-only' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message.toLowerCase()).toContain('admin token');
  });

  test('an unconfigured loopback origin is rejected on admin APIs', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const res = await app.request('/api/accounts', {
      headers: {
        Authorization: 'Bearer admin-secret',
        Origin: 'http://127.0.0.1:4001',
      },
    });
    expect(res.status).toBe(403);
  });

  test('an unlisted loopback origin is rejected on gateway APIs too', async () => {
    const app = createServer({ gatewayToken: 'gateway-secret' });
    const res = await app.request('/v1/models', {
      headers: {
        Authorization: 'Bearer gateway-secret',
        Origin: 'http://127.0.0.1:4001',
      },
    });
    expect(res.status).toBe(403);
  });

  test('explicitly configured admin origin and gateway token keep working', async () => {
    const app = createServer({
      gatewayToken: 'gateway-secret',
      adminToken: 'admin-secret',
      corsOrigins: ['http://127.0.0.1:4555'],
    });
    const admin = await app.request('/api/accounts', {
      headers: { Authorization: 'Bearer admin-secret', Origin: 'http://127.0.0.1:4555' },
    });
    expect(admin.status).toBe(200);
    const gateway = await app.request('/v1/models', {
      headers: { Authorization: 'Bearer gateway-secret' },
    });
    expect(gateway.status).toBe(200);
  });
});
