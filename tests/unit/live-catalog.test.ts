import { describe, expect, test } from 'bun:test';
import { buildLiveFreeCatalog } from '../../src/admin/live-catalog';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalAccountPool } from '../../src/pool/account-pool';
import type { ProviderPlugin, StoredAccount, ModelDescriptor } from '../../src/core/types/plugin';

function account(providerId: string): StoredAccount {
  return {
    id: `acc_${providerId}_live`, providerId, authType: 'api_key', status: 'active',
    credentials: { apiKey: 'k' }, createdAt: 1, updatedAt: 1, errorCount: 0,
  };
}

function fakeProvider(id: string, models: ModelDescriptor[], syncThrows = false): ProviderPlugin {
  return {
    id, displayName: id, defaultBaseUrl: 'http://localhost',
    async listModels() { return models; },
    async syncModels() { if (syncThrows) throw new Error('upstream down'); return models; },
    async execute() { throw new Error('unused'); },
    async executeStream() { return (async function* () {})(); },
  } as any;
}

function clearState() {
  for (const a of globalAccountPool.listAccounts()) globalAccountPool.deleteAccount(a.id);
  for (const id of ['kilo', 'nous']) {
    if (globalPluginRegistry.has(id)) globalPluginRegistry.unregister(id);
  }
}

describe('live free catalog', () => {
  test('zero accounts means zero models and no sync calls', async () => {
    clearState();
    let syncCalls = 0;
    const plugin = fakeProvider('kilo', [{ id: 'kilo/x:free', name: 'X', isFree: true }]);
    (plugin as any).syncModels = async () => { syncCalls++; return []; };
    globalPluginRegistry.register(plugin);
    try {
      const models = await buildLiveFreeCatalog();
      expect(models).toEqual([]);
      expect(syncCalls).toBe(0);
    } finally { clearState(); }
  });

  test('fetches live models only for connected providers and only free ones', async () => {
    clearState();
    globalPluginRegistry.register(fakeProvider('kilo', [
      { id: 'kilo/free:free', name: 'Free', isFree: true },
      { id: 'kilo/paid', name: 'Paid', isFree: false },
    ]));
    globalAccountPool.addAccount(account('kilo'));
    try {
      const models = await buildLiveFreeCatalog();
      expect(models.map((m) => m.id)).toEqual(['kilo/free:free']);
      expect(models[0].available).toBeTrue();
    } finally { clearState(); }
  });

  test('a failing provider does not break others', async () => {
    clearState();
    globalPluginRegistry.register(fakeProvider('kilo', [], true));
    globalPluginRegistry.register(fakeProvider('nous', [{ id: 'nous/free', name: 'Free', isFree: true }]));
    globalAccountPool.addAccount(account('kilo'));
    globalAccountPool.addAccount(account('nous'));
    try {
      const models = await buildLiveFreeCatalog();
      expect(models.map((m) => m.id)).toEqual(['nous/free']);
    } finally { clearState(); }
  });

  test('never returns a paid model even if plugin cachedModels contains one', async () => {
    clearState();
    const plugin = fakeProvider('kilo', [{ id: 'kilo/paid', name: 'Paid', isFree: false }]);
    (plugin as any).cachedModels = [{ id: 'kilo/paid', name: 'Paid', isFree: false }];
    globalPluginRegistry.register(plugin);
    globalAccountPool.addAccount(account('kilo'));
    try {
      const models = await buildLiveFreeCatalog();
      expect(models).toEqual([]);
    } finally { clearState(); }
  });
});
