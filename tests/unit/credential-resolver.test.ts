import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileSecretStore } from '../../src/core/secret-store';
import { createCredentialResolver } from '../../src/core/credential-resolver';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import { globalAccountPool } from '../../src/pool/account-pool';
import { createMockUpstream } from '../harness/mock-upstream';
import type { StoredAccount } from '../../src/core/types/plugin';

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-creds-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('credential resolver', () => {
  test('secret-store values override account values without mutating the account', () => {
    withDir((dir) => {
      const store = createFileSecretStore(join(dir, 'secrets.json'));
      store.set('acc_import_1', 'accessToken', 'from-store');
      const account: StoredAccount = {
        id: 'acc_import_1', providerId: 'kilo', authType: 'oauth', status: 'active',
        credentials: { accessToken: 'from-account' }, createdAt: 1, updatedAt: 1, errorCount: 0,
      };
      const resolver = createCredentialResolver(store);
      const creds = resolver.credentialsFor(account);
      expect(creds.accessToken).toBe('from-store');
      expect(account.credentials.accessToken).toBe('from-account');
    });
  });

  test('missing secret falls back to the account credential', () => {
    withDir((dir) => {
      const resolver = createCredentialResolver(createFileSecretStore(join(dir, 'secrets.json')));
      const creds = resolver.credentialsFor({
        id: 'acc_import_2', providerId: 'kilo', authType: 'oauth', status: 'active',
        credentials: { apiKey: 'account-key' }, createdAt: 1, updatedAt: 1, errorCount: 0,
      });
      expect(creds.apiKey).toBe('account-key');
    });
  });

  test('string cookies pass through the merged credentials', () => {
    withDir((dir) => {
      const store = createFileSecretStore(join(dir, 'secrets.json'));
      store.set('acc_import_3', 'cookies', 'sid=abc; token=xyz');
      const resolver = createCredentialResolver(store);
      const creds = resolver.credentialsFor({
        id: 'acc_import_3', providerId: 'deepseek', authType: 'cookie_pool', status: 'active',
        credentials: {}, createdAt: 1, updatedAt: 1, errorCount: 0,
      });
      expect(creds.cookies).toBe('sid=abc; token=xyz');
    });
  });
});

describe('imported account can serve a request', () => {
  test('a secret-store apiKey reaches the outbound Authorization header', async () => {
    const server = await createMockUpstream();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'lattice-creds-e2e-'));
      try {
        const store = createFileSecretStore(join(dir, 'secrets.json'));
        store.set('acc_import_e2e', 'apiKey', 'IMPORTED_SECRET_KEY');
        const account: StoredAccount = {
          id: 'acc_import_e2e', providerId: 'kilo', authType: 'api_key', status: 'active',
          credentials: {}, createdAt: 1, updatedAt: 1, errorCount: 0,
        };
        const kilo = new KiloProviderPlugin(
          server.url, undefined, undefined, createCredentialResolver(store)
        );
        kilo.addAccount(account);
        let authorization = '';
        server.onRequest((_req, _body, recorded) => {
          authorization = recorded.headers['authorization'] || '';
          return new Response(JSON.stringify({
            id: 'ok', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        await kilo.execute({
          id: 'req', clientDialect: 'openai-chat', model: 'kilo/model',
          messages: [{ role: 'user', content: 'hi' }], stream: false,
        });
        expect(authorization).toBe('Bearer IMPORTED_SECRET_KEY');
        expect(JSON.stringify(account.credentials)).not.toContain('IMPORTED_SECRET_KEY');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await server.stop();
    }
  });
});
