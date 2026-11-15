import { describe, it, expect } from 'bun:test';
import { createAdminRouter, broadcastLog } from '../../src/admin/admin-router';

describe('Admin Mission Control Dashboard & REST Control Plane', () => {
  const router = createAdminRouter();

  it('serves dashboard HTML on GET /admin with interactive modal and wizard markup', async () => {
    const res = await router.request('/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Lattice Gateway — Mission Control');
    expect(html).toContain('modal-credentials');
    expect(html).toContain('modal-combo-wizard');
    expect(html).toContain('Real-Time Token Telemetry');
    expect(html).toContain('tab-btn-kilo');
    expect(html).toContain('tab-btn-nous');
    expect(html).toContain('tab-btn-cline');
    expect(html).toContain('tab-btn-deepseek');
    expect(html).toContain('wizard-chain-preview');
  });

  it('registers Kilo Code credentials via POST /api/accounts', async () => {
    const res = await router.request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'acc_kilo_unit_test',
        providerId: 'kilo',
        authType: 'api_key',
        status: 'active',
        credentials: { apiKey: 'sk-kilo-test-key-12345', organizationId: 'org_test' },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.account.id).toBe('acc_kilo_unit_test');
    expect(json.account.providerId).toBe('kilo');
  });

  it('registers Nous Research credentials via POST /api/accounts', async () => {
    const res = await router.request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'acc_nous_unit_test',
        providerId: 'nous',
        authType: 'api_key',
        status: 'active',
        credentials: { apiKey: 'sk-nous-test-key-67890' },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.account.providerId).toBe('nous');
  });

  it('registers Cline credentials via POST /api/accounts', async () => {
    const res = await router.request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'acc_cline_unit_test',
        providerId: 'cline',
        authType: 'oauth',
        status: 'active',
        credentials: {
          accessToken: 'Bearer eyJ_workos_token',
          refreshToken: 'refresh_test_token',
          customData: { email: 'dev@lattice.local' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.account.providerId).toBe('cline');
  });

  it('registers DeepSeek credentials via POST /api/accounts', async () => {
    const res = await router.request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'acc_deepseek_unit_test',
        providerId: 'deepseek',
        authType: 'cookie_pool',
        status: 'active',
        credentials: {
          accessToken: 'userToken=test_cookie_token',
          cookies: 'userToken=test_cookie_token; HAPO=test_hapo',
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.account.providerId).toBe('deepseek');
  });

  it('creates virtual combo via POST /api/combos', async () => {
    const res = await router.request('/api/combos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'lattice/unit-test-combo',
        name: 'Unit Test Virtual Combo',
        description: 'Auto-failover test combo',
        targets: ['kilo/code-fast:free', 'nous/hermes-3-llama3', 'cline/sonnet-agent'],
        useProxies: true,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
  });

  it('retrieves real-time token telemetry metrics via GET /api/telemetry', async () => {
    const res = await router.request('/api/telemetry');
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.telemetry.totalTokens).toBeGreaterThan(0);
    expect(json.telemetry.promptTokens).toBeGreaterThan(0);
    expect(json.telemetry.completionTokens).toBeGreaterThan(0);
    expect(typeof json.telemetry.tokensPerSec).toBe('number');
    expect(typeof json.telemetry.savedUsd).toBe('string');
  });

  it('dispatches simulated telemetry packet via POST /api/telemetry/simulate', async () => {
    const res = await router.request('/api/telemetry/simulate', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.log.promptTokens).toBeGreaterThan(0);
    expect(json.log.completionTokens).toBeGreaterThan(0);
  });

  it('hot-reloads saved account into live running plugin instances in memory', async () => {
    // Check that kilo plugin instance has acc_kilo_unit_test loaded in memory
    const { globalPluginRegistry } = await import('../../src/plugins/registry');
    const kiloPlugin = globalPluginRegistry.get('kilo') as any;
    expect(kiloPlugin).toBeDefined();
    expect(kiloPlugin.account?.id).toBe('acc_kilo_unit_test');

    const clinePlugin = globalPluginRegistry.get('cline') as any;
    expect(clinePlugin).toBeDefined();
    const hasClineAcc = clinePlugin.accounts?.some((a: any) => a.id === 'acc_cline_unit_test');
    expect(hasClineAcc).toBeTrue();

    const deepseekPlugin = globalPluginRegistry.get('deepseek') as any;
    expect(deepseekPlugin).toBeDefined();
    const hasDsAcc = deepseekPlugin.accounts?.some((a: any) => a.id === 'acc_deepseek_unit_test');
    expect(hasDsAcc).toBeTrue();
  });

  it('runs upstream healthCheck probe via POST /api/accounts/:id/test', async () => {
    const res = await router.request('/api/accounts/acc_kilo_unit_test/test', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.accountId).toBe('acc_kilo_unit_test');
    expect(json.providerId).toBe('kilo');
    expect(json.health).toBeDefined();
    expect(typeof json.health.healthy).toBe('boolean');
  });

  it('returns 404 error when testing non-existent account via POST /api/accounts/:id/test', async () => {
    const res = await router.request('/api/accounts/acc_non_existent/test', { method: 'POST' });
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.success).toBeFalse();
    expect(json.error).toContain('not found');
  });

  it('toggles plugin state via POST /api/plugins/:id/toggle', async () => {
    const res = await router.request('/api/plugins/kilo/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
    expect(json.pluginId).toBe('kilo');
    expect(json.enabled).toBeTrue();
  });

  it('cleans up created unit test accounts via DELETE /api/accounts/:id', async () => {
    for (const id of ['acc_kilo_unit_test', 'acc_nous_unit_test', 'acc_cline_unit_test', 'acc_deepseek_unit_test']) {
      const res = await router.request(`/api/accounts/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    }
  });

  it('cleans up created unit test combo via DELETE /api/combos/:id', async () => {
    const res = await router.request('/api/combos/lattice%2Funit-test-combo', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBeTrue();
  });
});
