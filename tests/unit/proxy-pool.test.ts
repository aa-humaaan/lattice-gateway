import { describe, expect, test } from 'bun:test';
import { ProxyPoolManager } from '../../src/pool/proxy-pool';

describe('ProxyPoolManager', () => {
  test('a new pool has no proxies and no next proxy', () => {
    const pool = new ProxyPoolManager();
    expect(pool.listProxies()).toEqual([]);
    expect(pool.getNextProxy()).toBeUndefined();
  });

  test('addProxy records url, type and active state', () => {
    const pool = new ProxyPoolManager();
    const proxy = pool.addProxy('http://127.0.0.1:8080', 'http');
    expect(proxy.url).toBe('http://127.0.0.1:8080');
    expect(proxy.type).toBe('http');
    expect(proxy.active).toBeTrue();
    expect(proxy.errorCount).toBe(0);
    expect(pool.listProxies()).toEqual([proxy]);
  });

  test('getActiveProxies hides inactive proxies', () => {
    const pool = new ProxyPoolManager();
    const first = pool.addProxy('socks5://127.0.0.1:1080');
    const second = pool.addProxy('socks5://127.0.0.1:1081');
    second.active = false;
    expect(pool.getActiveProxies()).toEqual([first]);
  });

  test('getNextProxy rotates across active proxies and stamps lastUsedAt', () => {
    const pool = new ProxyPoolManager();
    const first = pool.addProxy('socks5://127.0.0.1:1080');
    const second = pool.addProxy('socks5://127.0.0.1:1081');
    const before = Date.now();
    const picked = [pool.getNextProxy(), pool.getNextProxy(), pool.getNextProxy()];
    expect(new Set(picked.map((p) => p!.id))).toEqual(new Set([first.id, second.id]));
    for (const proxy of picked) {
      expect(proxy!.lastUsedAt).toBeGreaterThanOrEqual(before);
    }
  });

  test('deleteProxy removes an existing proxy and reports misses', () => {
    const pool = new ProxyPoolManager();
    const proxy = pool.addProxy('socks5://127.0.0.1:1080');
    expect(pool.deleteProxy(proxy.id)).toBeTrue();
    expect(pool.listProxies()).toEqual([]);
    expect(pool.deleteProxy(proxy.id)).toBeFalse();
  });
});
