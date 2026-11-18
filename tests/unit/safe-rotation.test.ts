import { describe, expect, test } from 'bun:test';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import { ClinePoolPlugin } from '../../src/plugins/cline';
import type { StoredAccount } from '../../src/core/types/plugin';
import type { CanonicalRequest } from '../../src/core/types/canonical';
import { createMockUpstream } from '../harness/mock-upstream';

function account(id: string, key: string): StoredAccount {
  return {
    id, providerId: 'kilo', authType: 'api_key',
    credentials: { apiKey: key }, status: 'active',
    createdAt: 1, updatedAt: 1, errorCount: 0,
  };
}

const request: CanonicalRequest = {
  id: 'req', clientDialect: 'openai-chat', model: 'kilo/model',
  messages: [{ role: 'user', content: 'hi' }], stream: false,
};

async function withPatchedFetch(run: () => Promise<void>, onCall: () => void) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    onCall();
    throw new Error('ECONNRESET secret-token-should-not-leak');
  }) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe('safe account rotation', () => {
  test('a network error fails fast without trying the second Kilo account', async () => {
    const kilo = new KiloProviderPlugin();
    const second = account('acc_b', 'key_b');
    kilo.addAccount(account('acc_a', 'key_a'));
    kilo.addAccount(second);
    let calls = 0;
    let message = '';
    await withPatchedFetch(async () => {
      try {
        await kilo.execute(request);

      } catch (err: any) {
        message = err.message ?? '';
      }
    }, () => { calls++; });
    expect(calls).toBe(1);
    expect(message.toLowerCase()).toContain('connection failed');
    expect(message).not.toContain('secret-token');
    expect(second.status).toBe('active');
  });

  test('a network error on the stream path also fails fast', async () => {
    const kilo = new KiloProviderPlugin();
    kilo.addAccount(account('acc_a', 'key_a'));
    kilo.addAccount(account('acc_b', 'key_b'));
    let calls = 0;
    await withPatchedFetch(async () => {
      await expect(kilo.executeStream({ ...request, stream: true })).rejects.toThrow(/connection failed/i);
    }, () => { calls++; });
    expect(calls).toBe(1);
  });

  test('a 429 still rotates to the next account', async () => {
    const server = await createMockUpstream();
    try {
      const kilo = new KiloProviderPlugin(server.url);
      kilo.addAccount(account('acc_429_a', 'key_429_a'));
      kilo.addAccount(account('acc_429_b', 'key_429_b'));
      let attempts = 0;
      server.onRequest((_req, _body, recorded) => {
        attempts++;
        if (recorded.headers['authorization'] === 'Bearer key_429_a') {
          return new Response('{}', { status: 429, headers: { 'Retry-After': '5' } });
        }
        return new Response(JSON.stringify({
          id: 'ok', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const res = await kilo.execute(request);
      expect((res.content[0] as any).text).toBe('ok');
      expect(attempts).toBe(2);
    } finally {
      await server.stop();
    }
  });

  test('a 401 still rotates to the next Cline account', async () => {
    const server = await createMockUpstream();
    try {
      const acc1: StoredAccount = {
        id: 'cline_401_a', providerId: 'cline', authType: 'api_key',
        credentials: { apiKey: 'bad' }, status: 'active', createdAt: 1, updatedAt: 1, errorCount: 0,
      };
      const acc2: StoredAccount = {
        id: 'cline_401_b', providerId: 'cline', authType: 'api_key',
        credentials: { apiKey: 'good' }, status: 'active', createdAt: 1, updatedAt: 1, errorCount: 0,
      };
      const cline = new ClinePoolPlugin(server.url, [acc1, acc2]);
      server.onRequest((_req, _body, recorded) => {
        if (recorded.headers['authorization'] === 'Bearer bad') return new Response('{}', { status: 401 });
        return new Response(JSON.stringify({
          id: 'ok', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const res = await cline.execute({ ...request, model: 'cline/model' });
      expect((res.content[0] as any).text).toBe('ok');
      expect(acc1.status).toBe('suspended');
    } finally {
      await server.stop();
    }
  });
});


