import { logger } from '../utils/logger';

export interface EgressProxy {
  id: string;
  url: string;        // e.g. "socks5://127.0.0.1:1080" or "http://proxy.host:8080"
  type: 'socks5' | 'http';
  active: boolean;
  errorCount: number;
  lastUsedAt?: number;
}

export class ProxyPoolManager {
  private proxies: EgressProxy[] = [];
  private currentIndex = 0;

  addProxy(url: string, type: 'socks5' | 'http' = 'socks5'): EgressProxy {
    const id = `proxy_${crypto.randomUUID().slice(0, 8)}`;
    const proxy: EgressProxy = {
      id,
      url,
      type,
      active: true,
      errorCount: 0,
    };
    this.proxies.push(proxy);
    logger.info(`[ProxyPool] Added egress proxy: ${url} (${type})`);
    return proxy;
  }

  listProxies(): EgressProxy[] {
    return this.proxies;
  }

  getActiveProxies(): EgressProxy[] {
    return this.proxies.filter((p) => p.active);
  }

  getNextProxy(): EgressProxy | undefined {
    const active = this.getActiveProxies();
    if (active.length === 0) return undefined;
    this.currentIndex = (this.currentIndex + 1) % active.length;
    const proxy = active[this.currentIndex];
    proxy.lastUsedAt = Date.now();
    return proxy;
  }

  deleteProxy(id: string): boolean {
    const initial = this.proxies.length;
    this.proxies = this.proxies.filter((p) => p.id !== id);
    return this.proxies.length < initial;
  }
}

export const globalProxyPool = new ProxyPoolManager();
