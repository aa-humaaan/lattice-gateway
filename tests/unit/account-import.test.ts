import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileSecretStore } from '../../src/core/secret-store';
import { createImportManager } from '../../src/core/account-import';
import { globalAccountPool } from '../../src/pool/account-pool';

function withFixture(run: (dir: string, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-import-'));
  const file = join(dir, 'accounts.json');
  writeFileSync(file, JSON.stringify({ accounts: [
    { provider: 'kilo', email: 'private@example.com', accessToken: 'SECRET_ACCESS_123', authType: 'oauth' },
    { provider: 'nous', email: 'other@example.com', apiKey: 'SECRET_KEY_456', authType: 'api_key' },
  ] }));
  try { run(dir, file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('consentful account import', () => {
  test('preview reveals counts and providers but no secrets, emails or raw IDs', () => {
    withFixture((dir, file) => {
      const manager = createImportManager(createFileSecretStore(join(dir, 'secrets.json')));
      const preview = manager.preview('jsonAccounts', file);
      const body = JSON.stringify(preview);
      expect(preview.count).toBe(2);
      expect(body).not.toContain('SECRET_ACCESS_123');
      expect(body).not.toContain('SECRET_KEY_456');
      expect(body).not.toContain('private@example.com');
      expect(body).not.toContain('other@example.com');
      expect(preview.providers).toEqual(['kilo', 'nous']);
    });
  });

  test('confirm writes opaque-ID accounts and stores secrets out of the preview', () => {
    withFixture((dir, file) => {
      const secrets = createFileSecretStore(join(dir, 'secrets.json'));
      const manager = createImportManager(secrets);
      const preview = manager.preview('jsonAccounts', file);
      const result = manager.confirm(preview.token);
      expect(result.count).toBe(2);
      expect(result.accountIds).toHaveLength(2);
      for (const id of result.accountIds) {
        expect(id).toMatch(/^acc_import_[a-f0-9]{12}$/);
        expect(id).not.toContain('example');
        const acc = globalAccountPool.getAccount(id);
        expect(acc).toBeDefined();
        expect(JSON.stringify(acc!.credentials)).not.toContain('SECRET_ACCESS_123');
      }
      expect(secrets.get(result.accountIds[0], 'accessToken') ?? secrets.get(result.accountIds[0], 'apiKey')).toBeTruthy();
      for (const id of result.accountIds) globalAccountPool.deleteAccount(id);
    });
  });

  test('a confirm token is single-use', () => {
    withFixture((dir, file) => {
      const manager = createImportManager(createFileSecretStore(join(dir, 'secrets.json')));
      const preview = manager.preview('jsonAccounts', file);
      manager.confirm(preview.token);
      expect(() => manager.confirm(preview.token)).toThrow(/token/);
      const ids = globalAccountPool.listAccounts().filter((a) => a.id.startsWith('acc_import_'));
      for (const acc of ids) globalAccountPool.deleteAccount(acc.id);
    });
  });

  test('a tampered token is rejected and an expired token is rejected', () => {
    withFixture((dir, file) => {
      const manager = createImportManager(createFileSecretStore(join(dir, 'secrets.json')), 0);
      const preview = manager.preview('jsonAccounts', file);
      expect(() => manager.confirm(`${preview.token}tampered`)).toThrow(/token/);
      expect(() => manager.confirm(preview.token)).toThrow(/expired/);
    });
  });

  test('unknown source and a path that was never previewed are rejected', () => {
    withFixture((dir, file) => {
      const manager = createImportManager(createFileSecretStore(join(dir, 'secrets.json')));
      expect(() => manager.preview('unknownSource' as any, file)).toThrow(/source/);
      expect(() => manager.preview('jsonAccounts', join(dir, 'does-not-exist.json'))).toThrow(/path/);
      expect(() => manager.confirm('never-issued')).toThrow(/token/);
    });
  });

  test('preview reads only operator-supplied paths, never implicit hardcoded locations', () => {
    withFixture((dir, file) => {
      const manager = createImportManager(createFileSecretStore(join(dir, 'secrets.json')));
      expect(() => manager.preview('jsonAccounts', undefined as any)).toThrow(/path/);
    });
  });
});
