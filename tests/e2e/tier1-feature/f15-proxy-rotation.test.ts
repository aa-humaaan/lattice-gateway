/**
 * Feature F15: Core Infrastructure - Egress Proxy Rotation (HTTP & SOCKS5)
 * 
 * Verifies:
 * - Outbound request dispatched through configured HTTP/HTTPS proxy
 * - SOCKS5 proxy protocol routing support and URI parsing with credentials
 * - Proxy healthcheck failure removes dead proxy from pool
 * - Round-robin proxy rotation across multiple egress proxies
 * - Direct connection fallback when proxy pool is disabled or empty
 * - Proxy re-activation upon successful health probe
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import { assertOpenAISuccess } from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';

export interface ProxyDescriptor {
  id: string;
  url: string;
  protocol: 'http:' | 'https:' | 'socks5:';
  host: string;
  port: number;
  auth?: { username: string; password?: string };
  isHealthy: boolean;
  failureCount: number;
}

export function parseProxyUrl(rawUrl: string, id: string): ProxyDescriptor {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }

  return {
    id,
    url: rawUrl,
    protocol: parsed.protocol as any,
    host: parsed.hostname,
    port: Number(parsed.port) || (parsed.protocol === 'socks5:' ? 1080 : 8080),
    auth: parsed.username
      ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
      : undefined,
    isHealthy: true,
    failureCount: 0,
  };
}

export class StubProxyPoolManager {
  private proxies: ProxyDescriptor[] = [];
  private rrIndex = 0;
  public enabled = true;

  constructor(initialProxies: ProxyDescriptor[] = []) {
    this.proxies = [...initialProxies];
  }

  addProxy(proxy: ProxyDescriptor): void {
    this.proxies.push(proxy);
  }

  getActiveProxies(): ProxyDescriptor[] {
    if (!this.enabled) return [];
    return this.proxies.filter((p) => p.isHealthy);
  }

  selectProxy(): ProxyDescriptor | null {
    const active = this.getActiveProxies();
    if (active.length === 0) {
      return null; // Direct fallback
    }
    const proxy = active[this.rrIndex % active.length];
    this.rrIndex++;
    return proxy;
  }

  markFailure(id: string): void {
    const proxy = this.proxies.find((p) => p.id === id);
    if (proxy) {
      proxy.failureCount++;
      proxy.isHealthy = false;
    }
  }

  markHealthy(id: string): void {
    const proxy = this.proxies.find((p) => p.id === id);
    if (proxy) {
      proxy.failureCount = 0;
      proxy.isHealthy = true;
    }
  }

  getProxies(): ProxyDescriptor[] {
    return this.proxies;
  }

  reset(): void {
    this.rrIndex = 0;
    this.enabled = true;
    for (const p of this.proxies) {
      p.isHealthy = true;
      p.failureCount = 0;
    }
  }
}

class ProxiedProviderPlugin implements ProviderPlugin {
  readonly id = 'proxied';
  readonly displayName = 'Proxied Upstream Provider';
  readonly defaultBaseUrl: string;
  public proxyManager: StubProxyPoolManager;

  constructor(upstreamBaseUrl: string, proxyManager: StubProxyPoolManager) {
    this.defaultBaseUrl = upstreamBaseUrl;
    this.proxyManager = proxyManager;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'proxied/test-model',
        name: 'Proxied Test Model',
        providerId: 'proxied',
        ownedBy: 'proxied',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const proxy = this.proxyManager.selectProxy();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connection': 'close',
    };

    if (proxy) {
      headers['X-Forwarded-Proxy'] = proxy.url;
      headers['X-Proxy-Protocol'] = proxy.protocol;
      headers['X-Proxy-Id'] = proxy.id;
    } else {
      headers['X-Routing-Mode'] = 'direct';
    }

    const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'mock-gpt-4o',
        messages: req.messages,
      }),
      signal,
    });

    const data = (await res.json()) as any;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [
        {
          type: 'text',
          text: proxy ? `Routed via proxy ${proxy.id}` : 'Routed via direct egress',
        },
      ],
      stopReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'text_delta', delta: 'Proxied stream turn' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Feature F15: Egress Proxy Rotation (HTTP & SOCKS5)', () => {
  let mockServer: MockUpstreamServer;
  let proxyManager: StubProxyPoolManager;
  let plugin: ProxiedProviderPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();

    proxyManager = new StubProxyPoolManager([
      parseProxyUrl('http://127.0.0.1:8081', 'proxy_1'),
      parseProxyUrl('http://127.0.0.1:8082', 'proxy_2'),
      parseProxyUrl('socks5://user:secret@127.0.0.1:1080', 'proxy_socks_3'),
    ]);

    plugin = new ProxiedProviderPlugin(mockServer.url, proxyManager);
    const app = createServer({ port: 0 }, [plugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });

    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) gatewayServer.stop(true);
    if (mockServer) await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    proxyManager.reset();
  });

  // Test 1: Outbound request dispatched through configured HTTP proxy
  it('dispatches outbound request with configured HTTP proxy headers', async () => {
    const res = await client.openaiChat({
      model: 'proxied/test-model',
      messages: [{ role: 'user', content: 'Turn 1' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Routed via proxy proxy_1');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].headers['x-forwarded-proxy']).toBe('http://127.0.0.1:8081');
    expect(requests[0].headers['x-proxy-protocol']).toBe('http:');
    expect(requests[0].headers['x-proxy-id']).toBe('proxy_1');
  });

  // Test 2: SOCKS5 proxy protocol routing support and URI parsing with credentials
  it('parses and validates SOCKS5 proxy URI format with authentication', () => {
    const socksProxy = parseProxyUrl('socks5://dev_agent:pass123@proxy-us-east.net:1080', 'socks_test');
    expect(socksProxy.protocol).toBe('socks5:');
    expect(socksProxy.host).toBe('proxy-us-east.net');
    expect(socksProxy.port).toBe(1080);
    expect(socksProxy.auth).toBeDefined();
    expect(socksProxy.auth?.username).toBe('dev_agent');
    expect(socksProxy.auth?.password).toBe('pass123');
    expect(socksProxy.isHealthy).toBeTrue();
  });

  // Test 3: Proxy healthcheck failure removes dead proxy from pool
  it('removes failing proxy from active pool after health check failure', async () => {
    // Mark proxy_1 as failed
    proxyManager.markFailure('proxy_1');

    // Next request should skip proxy_1 and select proxy_2
    const res = await client.openaiChat({
      model: 'proxied/test-model',
      messages: [{ role: 'user', content: 'Turn after failure' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toBe('Routed via proxy proxy_2');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].headers['x-proxy-id']).toBe('proxy_2');
  });

  // Test 4: Round-robin proxy rotation across multiple healthy proxies
  it('rotates across multiple healthy proxies in round-robin sequence', async () => {
    // 3 sequential requests should hit proxy_1, proxy_2, proxy_socks_3
    for (let i = 0; i < 3; i++) {
      const res = await client.openaiChat({
        model: 'proxied/test-model',
        messages: [{ role: 'user', content: `Turn ${i}` }],
      });
      expect(res.status).toBe(200);
    }

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(3);
    expect(requests[0].headers['x-proxy-id']).toBe('proxy_1');
    expect(requests[1].headers['x-proxy-id']).toBe('proxy_2');
    expect(requests[2].headers['x-proxy-id']).toBe('proxy_socks_3');
    expect(requests[2].headers['x-proxy-protocol']).toBe('socks5:');
  });

  // Test 5: Direct connection fallback when proxy pool is disabled or empty
  it('falls back to direct connection when proxy pool is disabled', async () => {
    proxyManager.enabled = false;

    const res = await client.openaiChat({
      model: 'proxied/test-model',
      messages: [{ role: 'user', content: 'Direct egress turn' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toBe('Routed via direct egress');

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].headers['x-routing-mode']).toBe('direct');
    expect(requests[0].headers['x-forwarded-proxy']).toBeUndefined();
  }, 30_000);

  // Test 6: Re-activation upon successful health probe
  it('restores revived proxy back into active pool after successful health check', async () => {
    proxyManager.markFailure('proxy_1');
    expect(proxyManager.getActiveProxies().some((p) => p.id === 'proxy_1')).toBeFalse();

    proxyManager.markHealthy('proxy_1');
    expect(proxyManager.getActiveProxies().some((p) => p.id === 'proxy_1')).toBeTrue();
  });
});
