import { describe, it, expect } from 'bun:test';
import { DeepSeekPoolPlugin, parseDeepSeekChromeSession } from '../../src/plugins/deepseek';

function stubFetch(handler: (url: string) => Response) {
  const saved = globalThis.fetch;
  globalThis.fetch = ((input: any) => Promise.resolve(handler(String(input)))) as typeof fetch;
  return () => { globalThis.fetch = saved; };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('F-07: DeepSeek challenge failures and cooldown expiry', () => {
  it('throws when the challenge endpoint fails instead of returning a fake session token', async () => {
    const restore = stubFetch(() => new Response('nope', { status: 500 }));
    try {
      const plugin = new DeepSeekPoolPlugin('http://127.0.0.1:1');
      await expect(plugin.solveChallenge()).rejects.toThrow(/challenge/i);
    } finally {
      restore();
    }
  });

  it('throws when verify succeeds but returns no session token', async () => {
    const restore = stubFetch((url) => url.endsWith('/challenge')
      ? ok({ challenge: 'abc' })
      : ok({ success: true }));
    try {
      const plugin = new DeepSeekPoolPlugin('http://127.0.0.1:1');
      await expect(plugin.solveChallenge()).rejects.toThrow(/token/i);
    } finally {
      restore();
    }
  });

  it('reactivates an account once its cooldown has elapsed', () => {
    const plugin = new DeepSeekPoolPlugin();
    const account = parseDeepSeekChromeSession('acc_recover', { userToken: 'tok', cookies: 'c=1' });
    account.status = 'cooldown';
    account.cooldownUntil = Date.now() - 1;
    plugin.addAccount(account);

    expect(plugin.getActiveAccounts().some((a) => a.id === 'acc_recover')).toBe(true);
    expect(account.status as string).toBe('active');
    expect(account.cooldownUntil).toBeUndefined();
  });
});
