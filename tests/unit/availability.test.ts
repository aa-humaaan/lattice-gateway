import { describe, expect, test } from 'bun:test';
import { getEnrichedModelsCatalog } from '../../src/admin/models-catalog';
import { globalAccountPool } from '../../src/pool/account-pool';
import { globalPluginRegistry } from '../../src/plugins/registry';
import type { StoredAccount } from '../../src/core/types/plugin';
import type { EnrichedModelCatalogItem } from '../../src/admin/models-catalog';

function activeAccount(id: string, providerId: string): StoredAccount {
  return {
    id, providerId, authType: 'api_key', status: 'active',
    credentials: { apiKey: 'key' }, createdAt: 1, updatedAt: 1, errorCount: 0,
  };
}

function clearAccounts() {
  for (const account of globalAccountPool.listAccounts()) globalAccountPool.deleteAccount(account.id);
}

describe('catalog availability', () => {
  test('a provider with no active accounts contributes no available models', () => {
    clearAccounts();
    const models = getEnrichedModelsCatalog();
    const kilo = models.filter((m) => m.providerId === 'kilo');
    expect(kilo.length).toBeGreaterThan(0);
    expect(kilo.every((m) => m.available === false)).toBeTrue();
    expect(kilo[0].unavailableReason).toMatch(/account/i);
  });

  test('an active account makes that provider models available', () => {
    clearAccounts();
    globalAccountPool.addAccount(activeAccount('acc_kilo_available', 'kilo'));
    try {
      const models = getEnrichedModelsCatalog();
      const kilo = models.filter((m) => m.providerId === 'kilo');
      expect(kilo.some((m) => m.available === true)).toBeTrue();
    } finally {
      clearAccounts();
    }
  });

  test('keyless backends stay available without accounts', () => {
    clearAccounts();
    const models = getEnrichedModelsCatalog();
    for (const provider of ['opencode', 'freellmapi']) {
      const providerModels = models.filter((m) => m.providerId === provider);
      expect(providerModels.length).toBeGreaterThan(0);
      expect(providerModels.some((m) => m.available === true)).toBeTrue();
    }
  });

  test('disabled providers contribute no available models', () => {
    clearAccounts();
    globalPluginRegistry.setEnabled('kilo', false);
    try {
      const models = getEnrichedModelsCatalog();
      expect(models.filter((m) => m.providerId === 'kilo').every((m) => m.available === false)).toBeTrue();
    } finally {
      globalPluginRegistry.setEnabled('kilo', true);
    }
  });

  test('a combo is available when a keyless target is configured', () => {
    clearAccounts();
    const combos = getEnrichedModelsCatalog().filter((m) => m.providerId === 'lattice');
    expect(combos.length).toBeGreaterThan(0);
    expect(combos.some((m) => m.available === true)).toBeTrue();
  });

  test('a combo with no configured targets is unavailable', () => {
    clearAccounts();
    const makeStub = (id: string) => ({
      id, displayName: id, defaultBaseUrl: 'http://localhost',
      async listModels() { return []; },
      async execute() { throw new Error('unused'); },
      async executeStream() { return (async function* () {})(); },
    }) as any;
    for (const id of ['opencode', 'freellmapi']) {
      if (!globalPluginRegistry.has(id)) globalPluginRegistry.register(makeStub(id));
      globalPluginRegistry.setEnabled(id, false);
    }
    try {
      const combos = getEnrichedModelsCatalog().filter((m) => m.providerId === 'lattice');
      expect(combos.length).toBeGreaterThan(0);
      expect(combos.every((m) => m.available === false)).toBeTrue();
      expect(combos[0].unavailableReason).toMatch(/combo/i);
    } finally {
      globalPluginRegistry.setEnabled('opencode', true);
      globalPluginRegistry.setEnabled('freellmapi', true);
    }
  });
});
