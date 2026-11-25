import { describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
import {
  GatewayError,
  toOpenAIError,
  toAnthropicError,
  toResponsesError,
  serializeDialectError,
} from '../../src/core/types/errors';
import { Logger } from '../../src/utils/logger';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalAccountPool } from '../../src/pool/account-pool';

const PROBE = 'api_key=SECRET-CRED-4321';

describe('SEC-13: error bodies never carry upstream credentials', () => {
  test('upstream API key in a GatewayError is redacted from OpenAI bodies', () => {
    const err = new GatewayError(502, 'upstream_error', `upstream failed with ${PROBE}`);
    const { payload } = toOpenAIError(err);

    expect(payload.error.message).not.toContain('SECRET-CRED-4321');
    expect(payload.error.message).toContain('api_key=[REDACTED]');
  });

  test('a raw Error carrying a bearer token and cookie is redacted', () => {
    const err = new Error('upstream failed: Authorization: Bearer tok-live-9999; Cookie: session=abc123secret');
    const body = JSON.stringify(serializeDialectError(err, 'openai'));

    expect(body).not.toContain('tok-live-9999');
    expect(body).not.toContain('abc123secret');
    expect(body).toContain('[REDACTED]');
  });

  test('query-string secrets are redacted in every dialect', () => {
    const err = new GatewayError(
      502,
      'upstream_error',
      `fetch https://upstream.example/v1?api_key=SECRET-CRED-4321&access_token=AT-LIVE-777 failed`
    );
    const bodies = [
      JSON.stringify(toOpenAIError(err).payload),
      JSON.stringify(toAnthropicError(err).payload),
      JSON.stringify(toResponsesError(err).payload),
    ];

    for (const body of bodies) {
      expect(body).not.toContain('SECRET-CRED-4321');
      expect(body).not.toContain('AT-LIVE-777');
      expect(body).toContain('[REDACTED]');
    }
  });

  test('server global error handler redacts upstream credentials from the body', async () => {
    const app = createServer();
    app.get('/probe/leak', () => {
      throw new Error(`upstream failed with ${PROBE}`);
    });

    const res = await app.request('/probe/leak');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('SECRET-CRED-4321');
    expect(body).toContain('[REDACTED]');
  });

  test('admin API error bodies redact upstream credentials', async () => {
    const plugin = {
      id: 'redaction-probe',
      displayName: 'Redaction Probe',
      healthCheck: async () => {
        throw new Error(`upstream failed with ${PROBE}`);
      },
    } as any;
    globalPluginRegistry.register(plugin);
    const app = createServer({ adminToken: 'admin-secret' });
    const headers = { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' };
    try {
      const created = await app.request('/api/accounts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'acc_redaction_probe',
          providerId: plugin.id,
          authType: 'api_key',
          credentials: { apiKey: 'probe-key' },
        }),
      });
      expect(created.status).toBe(200);

      const res = await app.request('/api/accounts/acc_redaction_probe/test', {
        method: 'POST',
        headers,
      });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain('SECRET-CRED-4321');
      expect(body).toContain('[REDACTED]');
    } finally {
      globalPluginRegistry.unregister(plugin.id);
      globalAccountPool.deleteAccount('acc_redaction_probe');
    }
  });

  test('logger redacts credentials in messages and metadata', () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }) as typeof console.error;
    try {
      new Logger('probe').error(`upstream failed with ${PROBE}`, {
        header: 'Cookie: session=leak-cookie-555',
      });
    } finally {
      console.error = original;
    }

    const out = lines.join('\n');
    expect(out).not.toContain('SECRET-CRED-4321');
    expect(out).not.toContain('leak-cookie-555');
    expect(out).toContain('[REDACTED]');
  });

  test('logger redacts credential-shaped keys in JSON metadata', () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }) as typeof console.error;
    try {
      new Logger('probe').error('upstream failed', {
        body: { api_key: 'SECRET-CRED-4321', Authorization: 'Bearer tok-json-777' },
      });
    } finally {
      console.error = original;
    }

    const out = lines.join('\n');
    expect(out).not.toContain('SECRET-CRED-4321');
    expect(out).not.toContain('tok-json-777');
    expect(out).toContain('[REDACTED]');
  });
});
