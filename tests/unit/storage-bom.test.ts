import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LatticeStorage } from '../../src/pool/storage';
import { globalAccountPool } from '../../src/pool/account-pool';

describe('storage loader', () => {
  test('a BOM-prefixed store still loads its accounts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-bom-'));
    const file = join(dir, 'lattice-store.json');
    const acc = {
      id: 'acc_bom_loaded', providerId: 'kilo', authType: 'api_key', status: 'active',
      credentials: { apiKey: 'k' }, createdAt: 1, updatedAt: 1, errorCount: 0,
    };
    writeFileSync(file, `\ufeff${JSON.stringify({ accounts: [acc], combos: [], proxies: [], updatedAt: 1 })}`, 'utf8');
    try {
      const storage = new LatticeStorage(dir);
      storage.load();
      expect(globalAccountPool.getAccount('acc_bom_loaded')?.providerId).toBe('kilo');
    } finally {
      globalAccountPool.deleteAccount('acc_bom_loaded');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
