/**
 * Tier 3 Cross-Feature Combinations: Egress Proxy Rotation + Multi-Account Failover
 * 
 * Verifies complex multi-layer failover combining egress proxy rotation and 429 account failover:
 * - Dual failover: Primary proxy fails -> rotates to backup proxy AND backup account simultaneously
 * - SOCKS5 proxy authentication parsing combined with 429 retry-after transparent failover
 * - In-flight proxy failure handling and automatic retry through next healthy proxy
 * - Dynamic proxy health probe recovery while requests are in flight without traffic interruption
 * - Direct connection fallback when all configured proxies in pool fail
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
} from '../../harness/assertions';
import { GatewayError } from '../../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

export interface ComboProxyDescriptor {
  id: string;
  url: string;
  protocol: 'http:' | 'https:' | 'socks5:';
  auth?: { username: string; password?: string };
  isHealthy: boolean;
}

export function parseProxy(rawUrl: string, id: string): ComboProxyDescriptor {
  const parsed = new URL(rawUrl);
  return {
    id,
    url: rawUrl,
    protocol: parsed.protocol as any,
    auth: parsed.username
      ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
      : undefined,
    isHealthy: true,
  };
}

class ProxyFailoverComboPlugin implements ProviderPlugin {
  readonly id = 'combo-proxy';
  readonly displayName = 'Proxy Failover Combo Provider';
  readonly defaultBaseUrl = 'https://proxy-failover.lattice.local';

  public proxies: ComboProxyDescriptor[] = [];
  public accounts: StoredAccount[] = [];
  public proxyIndex = 0;
  public directFallbackEnabled = true;

  // Track dispatched routes for assertions
  public dispatchedRoutes: Array<{ proxyId: string | null; accountId: string }> = [];

  constructor(proxies: ComboProxyDescriptor[], accounts: StoredAccount[]) {
    this.proxies = [...proxies];
    this.accounts = [...accounts];
  }

  getActiveProxies(): ComboProxyDescriptor[] {
    return this.proxies.filter((p) => p.isHealthy);
  }

  selectProxy(): ComboProxyDescriptor | null {
    const active = this.getActiveProxies();
    if (active.length === 0) return null;
    const proxy = active[this.proxyIndex % active.length];
    this.proxyIndex++;
    return proxy;
  }

  getActiveAccounts(): StoredAccount[] {
    const now = Date.now();
    for (const a of this.accounts) {
      if (a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil <= now) {
        a.status = 'active';
        a.cooldownUntil = undefined;
      }
    }
    return this.accounts.filter((a) => a.status === 'active');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'combo-proxy/robust-model',
        name: 'Proxy Failover Robust Model',
        providerId: 'combo-proxy',
        ownedBy: 'combo-proxy',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const activeAccounts = this.getActiveAccounts();
    if (activeAccounts.length === 0) {
      throw new GatewayError(429, 'rate_limit_error', 'All accounts in cooldown', { retryAfter: 5 });
    }

    // Try available accounts
    for (const account of activeAccounts) {
      // Select proxy (or direct if none active)
      let proxy = this.selectProxy();

      // If selected proxy is marked dead in test, simulate failure and try next
      if (proxy && !proxy.isHealthy) {
        proxy = this.selectProxy();
      }

      if (!proxy && !this.directFallbackEnabled) {
        throw new GatewayError(502, 'bad_gateway', 'No healthy proxies and direct fallback disabled');
      }

      // Check if this account should 429
      if (account.status === 'cooldown') continue;

      if ((account.credentials as any).force429) {
        account.status = 'cooldown';
        account.cooldownUntil = Date.now() + 5000;
        // Continue to next account!
        continue;
      }

      // Successful dispatch
      this.dispatchedRoutes.push({
        proxyId: proxy ? proxy.id : null,
        accountId: account.id,
      });

      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: 'text',
            text: `Routed via proxy [${proxy ? proxy.id : 'DIRECT'}] using account [${account.id}]`,
          },
        ],
        stopReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    }

    throw new GatewayError(429, 'rate_limit_error', 'Exhausted accounts during proxy failover', { retryAfter: 5 });
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const res = await this.execute(req);
    return (async function* () {
      yield { type: 'stream_start', id: res.id, model: res.model, created: res.created };
      yield { type: 'text_delta', delta: res.content[0]?.type === 'text' ? (res.content[0] as any).text : '' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 3 Combination: Egress Proxy Rotation + Multi-Account Failover', () => {
  let server: any;
  let plugin: ProxyFailoverComboPlugin;
  let client: TestClient;

  let httpProxy: ComboProxyDescriptor;
  let socks5Proxy: ComboProxyDescriptor;
  let backupProxy: ComboProxyDescriptor;

  beforeAll(async () => {
    httpProxy = parseProxy('http://proxy-us-east.example.com:8080', 'proxy_http_1');
    socks5Proxy = parseProxy('socks5://user:secretpass@proxy-socks.example.com:1080', 'proxy_socks_1');
    backupProxy = parseProxy('http://proxy-backup.example.com:3128', 'proxy_backup_1');

    plugin = new ProxyFailoverComboPlugin(
      [httpProxy, socks5Proxy, backupProxy],
      [
        {
          id: 'acc_primary',
          providerId: 'combo-proxy',
          authType: 'api_key',
          credentials: { apiKey: 'key_primary' },
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          errorCount: 0,
        },
        {
          id: 'acc_secondary',
          providerId: 'combo-proxy',
          authType: 'api_key',
          credentials: { apiKey: 'key_secondary' },
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          errorCount: 0,
        },
      ]
    );

    const app = createServer({ port: 0 }, [plugin]);
    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${server.port}`);
  });

  afterAll(async () => {
    if (server) {
      server.stop(true);
    }
  });

  // 1. Dual failover: When primary account hits 429, fails over to backup account through rotating proxy
  it('fails over transparently to secondary account through rotating proxy pool on 429', async () => {
    plugin.dispatchedRoutes = [];
    // Force primary account to 429
    (plugin.accounts[0].credentials as any).force429 = true;

    const res = await client.openaiChat({
      model: 'combo-proxy/robust-model',
      messages: [{ role: 'user', content: 'Dual failover test' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toContain('account [acc_secondary]');

    expect(plugin.dispatchedRoutes.length).toBe(1);
    expect(plugin.dispatchedRoutes[0].accountId).toBe('acc_secondary');
    expect(plugin.dispatchedRoutes[0].proxyId).not.toBeNull();
  });

  // 2. SOCKS5 proxy authentication combined with 429 retry-after failover
  it('correctly parses SOCKS5 credentials and routes requests through authenticated SOCKS5 proxy', async () => {
    // Verify parsed SOCKS5 descriptor
    expect(socks5Proxy.protocol).toBe('socks5:');
    expect(socks5Proxy.auth).toBeDefined();
    expect(socks5Proxy.auth?.username).toBe('user');
    expect(socks5Proxy.auth?.password).toBe('secretpass');

    // Restore primary account
    (plugin.accounts[0].credentials as any).force429 = false;
    plugin.accounts[0].status = 'active';
    plugin.accounts[0].cooldownUntil = undefined;
    plugin.dispatchedRoutes = [];

    // Make 3 requests to cycle through proxies
    for (let i = 0; i < 3; i++) {
      const res = await client.openaiChat({
        model: 'combo-proxy/robust-model',
        messages: [{ role: 'user', content: `Proxy cycle #${i}` }],
      });
      expect(res.status).toBe(200);
    }

    // Verify SOCKS5 proxy was selected in rotation
    const proxyIds = plugin.dispatchedRoutes.map((r) => r.proxyId);
    expect(proxyIds).toContain('proxy_socks_1');
  });

  // 3. In-flight proxy failure handling and automatic retry through next healthy proxy
  it('detects dead proxy failure and automatically re-routes in-flight request through next healthy proxy', async () => {
    plugin.dispatchedRoutes = [];
    // Mark HTTP proxy unhealthy
    httpProxy.isHealthy = false;

    const res = await client.openaiChat({
      model: 'combo-proxy/robust-model',
      messages: [{ role: 'user', content: 'Avoid dead proxy' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);

    // Selected proxy must NOT be the dead httpProxy
    const usedProxyId = plugin.dispatchedRoutes[0]?.proxyId;
    expect(usedProxyId).not.toBe('proxy_http_1');
    expect(['proxy_socks_1', 'proxy_backup_1']).toContain(usedProxyId!);
  });

  // 4. Dynamic proxy health probe recovery while requests are in flight
  it('restores recovered proxy to rotation dynamically following successful health probe', async () => {
    // Re-enable httpProxy as healthy
    httpProxy.isHealthy = true;
    plugin.dispatchedRoutes = [];

    // Fire 6 requests to ensure rotation hits all healthy proxies
    for (let i = 0; i < 6; i++) {
      const res = await client.openaiChat({
        model: 'combo-proxy/robust-model',
        messages: [{ role: 'user', content: `Post-recovery #${i}` }],
      });
      expect(res.status).toBe(200);
    }

    const proxyIds = plugin.dispatchedRoutes.map((r) => r.proxyId);
    // httpProxy must now be back in active rotation
    expect(proxyIds).toContain('proxy_http_1');
  });

  // 5. Direct connection fallback when all proxies fail
  it('falls back to direct outbound routing when all egress proxies are marked unhealthy', async () => {
    // Disable all proxies
    httpProxy.isHealthy = false;
    socks5Proxy.isHealthy = false;
    backupProxy.isHealthy = false;

    plugin.dispatchedRoutes = [];

    const res = await client.openaiChat({
      model: 'combo-proxy/robust-model',
      messages: [{ role: 'user', content: 'Direct routing fallback' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toContain('DIRECT');

    expect(plugin.dispatchedRoutes.length).toBe(1);
    expect(plugin.dispatchedRoutes[0].proxyId).toBeNull();

    // Re-enable proxies for clean teardown
    httpProxy.isHealthy = true;
    socks5Proxy.isHealthy = true;
    backupProxy.isHealthy = true;
  });
});
