import { describe, expect, test } from 'bun:test';
import { createAdminRouter } from '../../src/admin/admin-router';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalAccountPool } from '../../src/pool/account-pool';
import type { ProviderPlugin, ModelDescriptor } from '../../src/core/types/plugin';

function clearAccounts() {
  for (const a of globalAccountPool.listAccounts()) globalAccountPool.deleteAccount(a.id);
}

function fakeOpenCode(): ProviderPlugin {
  const models: ModelDescriptor[] = [
    { id: 'opencode/free:free', name: 'OpenCode Free', providerId: 'opencode', isFree: true },
    { id: 'opencode/paid', name: 'OpenCode Paid', providerId: 'opencode', isFree: false },
  ];
  return {
    id: 'opencode',
    displayName: 'OpenCode Zen',
    defaultBaseUrl: 'https://opencode.ai/inference/openai/v1',
    supportedAuthTypes: ['anonymous', 'api_key'],
    setAccount() {},
    async listModels() { return models; },
    async syncModels() { return models; },
    async execute() { throw new Error('unused'); },
    async executeStream() { return (async function* () {})(); },
  } as any;
}

describe('OpenCode keyless connect', () => {
  test('anonymous account registers active and makes free models appear', async () => {
    clearAccounts();
    if (globalPluginRegistry.has('opencode')) globalPluginRegistry.unregister('opencode');
    globalPluginRegistry.register(fakeOpenCode());
    const router = createAdminRouter();
    try {
      const addRes = await router.request('/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'acc_opencode_keyless_test',
          providerId: 'opencode',
          authType: 'anonymous',
          status: 'active',
          credentials: {},
        }),
      });
      expect(addRes.status).toBe(200);
      expect(globalAccountPool.getAccount('acc_opencode_keyless_test')?.status).toBe('active');

      const modelsRes = await router.request('/api/models');
      const json = (await modelsRes.json()) as any;
      const oc = json.models.filter((m: any) => m.providerId === 'opencode');
      expect(oc.map((m: any) => m.id)).toEqual(['opencode/free:free']);
    } finally {
      clearAccounts();
      globalPluginRegistry.unregister('opencode');
    }
  });

  test('deleting then reconnecting restores the account', async () => {
    clearAccounts();
    if (globalPluginRegistry.has('opencode')) globalPluginRegistry.unregister('opencode');
    globalPluginRegistry.register(fakeOpenCode());
    const router = createAdminRouter();
    const payload = (id: string) => JSON.stringify({
      id, providerId: 'opencode', authType: 'anonymous', status: 'active', credentials: {},
    });
    const post = (body: string) => router.request('/api/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    try {
      await post(payload('acc_oc_reconnect'));
      expect(globalAccountPool.getAccount('acc_oc_reconnect')).toBeDefined();
      await router.request('/api/accounts/acc_oc_reconnect', { method: 'DELETE' });
      expect(globalAccountPool.getAccount('acc_oc_reconnect')).toBeUndefined();
      await post(payload('acc_oc_reconnect'));
      expect(globalAccountPool.getAccount('acc_oc_reconnect')?.status).toBe('active');
    } finally {
      clearAccounts();
      globalPluginRegistry.unregister('opencode');
    }
  });
});
