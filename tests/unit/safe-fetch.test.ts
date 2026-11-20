import { describe, expect, it } from 'bun:test';
import { createSafeFetch, safeFetch } from '../../src/core/safe-fetch';

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

  it('refuses an HTTPS-to-HTTP downgrade on redirect', async () => {
    const stub = (() => Promise.resolve(new Response('go', {
      status: 302,
      headers: { Location: 'http://example.com/downgraded' },
    }))) as unknown as typeof fetch;
    const guarded = createSafeFetch(stub);
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
    await createSafeFetch(stub)('https://example.com/');
    expect(seen?.redirect).toBe('manual');
  });
});
