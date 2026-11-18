import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from '../../src/core/server';
import { globalAccountPool } from '../../src/pool/account-pool';
import { globalCredentialResolver } from '../../src/core/credential-resolver';
import { LatticeStorage } from '../../src/pool/storage';

describe('SEC-04: store permissions and manual credential handling', () => {
  it('writes lattice-store.json with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-mode-'));
    try {
      const storage = new LatticeStorage(dir);
      storage.save();
      const file = join(dir, 'lattice-store.json');
      expect(existsSync(file)).toBe(true);
      expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      } else {
        const src = readFileSync('src/pool/storage.ts', 'utf8');
        expect(src).toContain('mode: 0o600');
        expect(src).toContain('chmodSync');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores manually added credentials in SecretStore, not the account record', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const id = 'acc_manual_secret_test';
    const secret = 'MANUAL_SECRET_API_KEY_XYZ';
    try {
      const res = await app.request('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
        body: JSON.stringify({
          id,
          providerId: 'kilo',
          authType: 'api_key',
          credentials: { apiKey: secret, email: 'operator@example.com' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(secret);

      const account = globalAccountPool.getAccount(id);
      expect(account).toBeDefined();
      expect(JSON.stringify(account!.credentials)).not.toContain(secret);

      const creds = globalCredentialResolver.credentialsFor(account);
      expect(creds.apiKey).toBe(secret);
      expect(creds.email).toBe('operator@example.com');
    } finally {
      globalAccountPool.deleteAccount(id);
    }
  });
});
