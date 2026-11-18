import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from '../../src/core/server';
import { loadOrCreateAuthTokens } from '../../src/core/auth-tokens';

const secureConfig = {
  gatewayToken: 'gw-test-secret',
  adminToken: 'admin-test-secret',
};

describe('control plane authentication', () => {
  test('rejects unauthenticated admin API request', async () => {
    const app = createServer(secureConfig);
    const res = await app.request('/api/accounts');
    expect(res.status).toBe(401);
  });

  test('rejects a wrong admin token', async () => {
    const app = createServer(secureConfig);
    const res = await app.request('/api/accounts', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('accepts the configured admin token', async () => {
    const app = createServer(secureConfig);
    const res = await app.request('/api/accounts', {
      headers: { Authorization: 'Bearer admin-test-secret' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects unauthenticated gateway request', async () => {
    const app = createServer(secureConfig);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'anything', messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  test('accepts the configured gateway token as Bearer', async () => {
    const app = createServer(secureConfig);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-test-secret',
      },
      body: JSON.stringify({ model: 'anything', messages: [] }),
    });
    expect(res.status).not.toBe(401);
  });

  test('health probes stay public', async () => {
    const app = createServer(secureConfig);
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/api/health')).status).toBe(200);
  });

  test('rejects a foreign Origin header', async () => {
    const app = createServer(secureConfig);
    const res = await app.request('/v1/models', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  test('generated tokens are stable across restarts and kept out of world-readable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-auth-'));
    try {
      const first = loadOrCreateAuthTokens(dir);
      const second = loadOrCreateAuthTokens(dir);
      expect(first.gatewayToken).toBe(second.gatewayToken);
      expect(first.adminToken).toBe(second.adminToken);
      expect(first.gatewayToken).not.toBe(first.adminToken);
      const stored = JSON.parse(readFileSync(join(dir, 'lattice-auth.json'), 'utf8'));
      expect(stored.gatewayToken).toBe(first.gatewayToken);
      if (process.platform !== 'win32') {
        expect(statSync(join(dir, 'lattice-auth.json')).mode & 0o077).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('allows a configured loopback Origin', async () => {
    const app = createServer({
      ...secureConfig,
      corsOrigins: ['http://127.0.0.1:4000'],
    });
    const res = await app.request('/v1/models', {
      headers: {
        Origin: 'http://127.0.0.1:4000',
        Authorization: 'Bearer gw-test-secret',
      },
    });
    expect(res.status).toBe(200);
  });
});
