import { describe, expect, it } from 'bun:test';
import { createSafeFetch, safeFetch } from '../../src/core/safe-fetch';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import type { StoredAccount } from '../../src/core/types/plugin';

describe('P0-7: safeFetch redirect validation', () => {
  it('refuses a 302 redirect to a link-local metadata address', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('redirecting', {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    });
    try {
      await expect(safeFetch(`http://127.0.0.1:${server.port}/start`)).rejects.toThrow(/unsafe|refus|private|link-local/i);
    } finally {
      server.stop(true);
    }
  });

  const publicResolve = async (_hostname: string) => ['93.184.216.34'];

  it('refuses an HTTPS-to-HTTP downgrade on redirect', async () => {
    const stub = (() => Promise.resolve(new Response('go', {
      status: 302,
      headers: { Location: 'http://example.com/downgraded' },
    }))) as unknown as typeof fetch;
    const guarded = createSafeFetch(stub, publicResolve);
    await expect(guarded('https://example.com/start')).rejects.toThrow(/downgrade|unsafe|http/i);
  });

  it('follows an allowed redirect and returns the final response', async () => {
    let calls = 0;
    const stub = ((input: any) => {
      calls++;
      if (calls === 1) return Promise.resolve(new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1:9/final' },
      }));
      return Promise.resolve(new Response('final body', { status: 200 }));
    }) as unknown as typeof fetch;
    const guarded = createSafeFetch(stub);
    const res = await guarded('http://127.0.0.1:8/start');
    expect(calls).toBe(2);
    expect(await res.text()).toBe('final body');
  });

  it('sends redirect: manual so callers cannot silently follow a hop', async () => {
    let seen: RequestInit | undefined;
    const stub = ((_input: any, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;
    await createSafeFetch(stub, publicResolve)('https://example.com/');
    expect(seen?.redirect).toBe('manual');
  });
});

describe('P0-7b: safeFetch DNS resolution guard', () => {
  const stub = (() => Promise.resolve(new Response('ok'))) as unknown as typeof fetch;

  it('refuses a public-looking host that resolves into private space', async () => {
    let calls = 0;
    const counting = ((input: any) => { calls++; return Promise.resolve(new Response('ok')); }) as unknown as typeof fetch;
    const guarded = createSafeFetch(counting, async () => ['10.0.0.5']);
    await expect(guarded('https://metadata.example.com/v1')).rejects.toThrow(/private|refus/i);
    expect(calls).toBe(0);
  });

  it('refuses a host whose DNS lookup fails', async () => {
    const guarded = createSafeFetch(stub, async () => { throw new Error('ENOTFOUND'); });
    await expect(guarded('https://gone.example.com/')).rejects.toThrow(/unresolvable|DNS/i);
  });

  it('refuses a host with no DNS records', async () => {
    const guarded = createSafeFetch(stub, async () => []);
    await expect(guarded('https://empty.example.com/')).rejects.toThrow(/no DNS records/i);
  });

  it('allows a host that resolves to public addresses', async () => {
    const guarded = createSafeFetch(stub, async () => ['93.184.216.34', '2606:4700::1111']);
    const res = await guarded('https://public.example.com/');
    expect(res.status).toBe(200);
  });
});

// Behavioral kill: the module is also exercised through a real plugin, so a
// regression in redirect validation fails an observable outcome, not an import.
describe('behavioral: plugin egress refuses unsafe redirects', () => {
  it('a Kilo health probe refuses a 302 into link-local metadata and never issues the hop', async () => {
    let targetHits = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).hostname === '169.254.169.254') {
          targetHits++;
          return new Response('metadata leaked');
        }
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        });
      },
    });
    const account: StoredAccount = {
      id: 'safe-fetch-probe',
      providerId: 'kilo',
      authType: 'api_key',
      status: 'active',
      credentials: { apiKey: 'sk-probe' },
      createdAt: 1,
      updatedAt: 1,
      errorCount: 0,
    };
    try {
      const plugin = new KiloProviderPlugin(`http://127.0.0.1:${server.port}/v1`, account);
      const result = await plugin.healthCheck(account);
      expect(result.healthy).toBe(false);
      expect(result.message).toMatch(/unsafe|refus/i);
      expect(targetHits).toBe(0);
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
