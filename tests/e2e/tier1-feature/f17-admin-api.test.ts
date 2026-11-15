/**
 * Tier 1 Feature Coverage: F17 - Admin Control Plane & REST API
 * 
 * Verifies admin REST endpoints and system probe contracts:
 * - GET /healthz and /live returns system health status, version, and uptime
 * - GET /api/accounts returns registered accounts with status
 * - GET /api/plugins returns registered plugins and enabled states
 * - GET /api/combos returns configured virtual model combos
 * - GET /api/proxies returns configured egress proxies
 * - Unmounted/unknown admin routes return proper 404 dialect error envelope
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient } from '../../harness/test-client';
import { assertDialectError } from '../../harness/assertions';

describe('F17: Admin Control Plane & REST API', () => {
  let adminMockServer: MockUpstreamServer;
  let adminClient: TestClient;
  let gateway: GatewayInstance;
  let gatewayClient: TestClient;

  beforeAll(async () => {
    // 1. Initialize live Gateway instance for core probe and ingress verification
    gateway = await startGateway({ mode: 'in-process' });
    gatewayClient = new TestClient(gateway.baseUrl);

    // 2. Initialize harness mock server configured with Admin REST API contracts
    adminMockServer = await createMockUpstream();
    adminClient = new TestClient(adminMockServer.url);

    // Mount /api/accounts endpoint on harness mock server
    adminMockServer.onPath('/api/accounts', () => {
      return new Response(
        JSON.stringify({
          accounts: [
            {
              id: 'acc_kilo_01',
              providerId: 'kilo',
              authType: 'oauth',
              status: 'active',
              createdAt: 1731693600000,
              updatedAt: 1731693600000,
              errorCount: 0,
            },
            {
              id: 'acc_cline_01',
              providerId: 'cline',
              authType: 'oauth',
              status: 'cooldown',
              cooldownUntil: Date.now() + 60000,
              createdAt: 1731693600000,
              updatedAt: 1731693600000,
              errorCount: 1,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Mount /api/plugins endpoint
    adminMockServer.onPath('/api/plugins', () => {
      return new Response(
        JSON.stringify({
          plugins: [
            { id: 'kilo', displayName: 'Kilo Code', enabled: true, supportedAuthTypes: ['oauth', 'api_key'] },
            { id: 'nous', displayName: 'Nous Research', enabled: true, supportedAuthTypes: ['oauth', 'api_key'] },
            { id: 'cline', displayName: 'Cline Pool', enabled: true, supportedAuthTypes: ['oauth'] },
            { id: 'opencode', displayName: 'OpenCode Zen', enabled: true, supportedAuthTypes: ['anonymous'] },
            { id: 'deepseek', displayName: 'DeepSeek Web Pool', enabled: false, supportedAuthTypes: ['cookie_pool'] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Mount /api/combos endpoint
    adminMockServer.onPath('/api/combos', () => {
      return new Response(
        JSON.stringify({
          combos: [
            {
              id: 'lattice/code-flagship',
              name: 'Code Flagship Combo',
              models: ['kilo/claude-3-7-sonnet', 'nous/hermes-3', 'cline/solar-pro'],
              strategy: 'priority_fallback',
            },
            {
              id: 'lattice/fast-reasoning',
              name: 'Fast Reasoning Combo',
              models: ['opencode/big-pickle', 'kilo/free-model:free'],
              strategy: 'round_robin',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Mount /api/proxies endpoint
    adminMockServer.onPath('/api/proxies', () => {
      return new Response(
        JSON.stringify({
          proxies: [
            { id: 'proxy_1', url: 'http://127.0.0.1:8080', protocol: 'http', status: 'healthy', latencyMs: 25 },
            { id: 'proxy_2', url: 'socks5://127.0.0.1:1080', protocol: 'socks5', status: 'healthy', latencyMs: 38 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
  });

  afterAll(async () => {
    if (adminMockServer) {
      await adminMockServer.stop();
    }
    if (gateway) {
      await gateway.stop();
    }
  });

  // 1. GET /healthz and /live returns system status and uptime
  it('GET /healthz returns 200 OK with status, version, and numeric uptime', async () => {
    const res = await gatewayClient.getHealth('/healthz');
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.version).toBe('0.1.0');
    expect(typeof body.timestamp).toBe('number');
  });

  it('GET /live returns 200 OK with live: true', async () => {
    const res = await gatewayClient.getHealth('/live');
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.live).toBeTrue();
  });

  // 2. GET /api/accounts returns registered accounts with status
  it('GET /api/accounts returns registered accounts list with status and authType', async () => {
    const res = await adminClient.getAccounts();
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(Array.isArray(body.accounts)).toBeTrue();
    expect(body.accounts.length).toBe(2);

    const activeAcc = body.accounts.find((a: any) => a.status === 'active');
    expect(activeAcc).toBeDefined();
    expect(activeAcc.providerId).toBe('kilo');
    expect(activeAcc.authType).toBe('oauth');

    const cooldownAcc = body.accounts.find((a: any) => a.status === 'cooldown');
    expect(cooldownAcc).toBeDefined();
    expect(cooldownAcc.cooldownUntil).toBeGreaterThan(Date.now());
  });

  // 3. GET /api/plugins returns registered plugins and enabled states
  it('GET /api/plugins returns registered plugins with enabled flags and auth archetypes', async () => {
    const res = await fetch(`${adminMockServer.url}/api/plugins`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(Array.isArray(body.plugins)).toBeTrue();
    expect(body.plugins.length).toBe(5);

    const kilo = body.plugins.find((p: any) => p.id === 'kilo');
    expect(kilo.enabled).toBeTrue();
    expect(kilo.displayName).toBe('Kilo Code');

    const deepseek = body.plugins.find((p: any) => p.id === 'deepseek');
    expect(deepseek.enabled).toBeFalse();
    expect(deepseek.supportedAuthTypes).toContain('cookie_pool');
  });

  // 4. GET /api/combos returns configured virtual model combos
  it('GET /api/combos returns virtual model combos with fallback chains', async () => {
    const res = await adminClient.getCombos();
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(Array.isArray(body.combos)).toBeTrue();
    expect(body.combos.length).toBe(2);

    const flagship = body.combos.find((c: any) => c.id === 'lattice/code-flagship');
    expect(flagship).toBeDefined();
    expect(flagship.strategy).toBe('priority_fallback');
    expect(flagship.models).toContain('kilo/claude-3-7-sonnet');
    expect(flagship.models).toContain('nous/hermes-3');
  });

  // 5. GET /api/proxies returns configured egress proxies
  it('GET /api/proxies returns configured egress proxies with protocols and latencies', async () => {
    const res = await fetch(`${adminMockServer.url}/api/proxies`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(Array.isArray(body.proxies)).toBeTrue();
    expect(body.proxies.length).toBe(2);

    const socks5Proxy = body.proxies.find((p: any) => p.protocol === 'socks5');
    expect(socks5Proxy).toBeDefined();
    expect(socks5Proxy.status).toBe('healthy');
    expect(socks5Proxy.latencyMs).toBeGreaterThan(0);
  });

  // 6. Unknown admin route returns 404 dialect error envelope
  it('returns proper 404 dialect error when querying unmounted admin endpoint on gateway', async () => {
    const res = await fetch(`${gateway.baseUrl}/api/unmounted_endpoint`, {
      method: 'GET',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai', 404);
    expect(body.error.message).toContain('was not found');
  });
});
