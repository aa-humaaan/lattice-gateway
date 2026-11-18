import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileSecretStore } from '../../src/core/secret-store';

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-secrets-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('file secret store', () => {
  test('round-trips a secret and reports file-fallback availability', () => {
    withDir((dir) => {
      const store = createFileSecretStore(join(dir, 'secrets.json'));
      store.set('kilo/acc_1', 'accessToken', 'super-secret');
      expect(store.get('kilo/acc_1', 'accessToken')).toBe('super-secret');
      expect(store.availability()).toBe('file-fallback');
    });
  });

  test('namespaces secrets by account and persists across restart', () => {
    withDir((dir) => {
      const file = join(dir, 'secrets.json');
      createFileSecretStore(file).set('kilo/acc_1', 'apiKey', 'key-one');
      createFileSecretStore(file).set('kilo/acc_2', 'apiKey', 'key-two');
      const restored = createFileSecretStore(file);
      expect(restored.get('kilo/acc_1', 'apiKey')).toBe('key-one');
      expect(restored.get('kilo/acc_2', 'apiKey')).toBe('key-two');
    });
  });

  test('delete removes only the named secret', () => {
    withDir((dir) => {
      const store = createFileSecretStore(join(dir, 'secrets.json'));
      store.set('kilo/acc_1', 'accessToken', 'a');
      store.set('kilo/acc_1', 'refreshToken', 'r');
      store.delete('kilo/acc_1', 'accessToken');
      expect(store.get('kilo/acc_1', 'accessToken')).toBeUndefined();
      expect(store.get('kilo/acc_1', 'refreshToken')).toBe('r');
    });
  });

  test('missing keys return undefined without throwing', () => {
    withDir((dir) => {
      const store = createFileSecretStore(join(dir, 'secrets.json'));
      expect(store.get('missing', 'accessToken')).toBeUndefined();
    });
  });

  test('corrupt file recovers to an empty store without leaking partial data', () => {
    withDir((dir) => {
      const file = join(dir, 'secrets.json');
      writeFileSync(file, '{broken');
      const store = createFileSecretStore(file);
      expect(store.get('anything', 'accessToken')).toBeUndefined();
    });
  });

  test('storage file uses restrictive permissions where the platform supports it', () => {
    withDir((dir) => {
      const file = join(dir, 'secrets.json');
      createFileSecretStore(file).set('a/b', 'k', 'v');
      const mode = require('fs').statSync(file).mode & 0o777;
      if (process.platform !== 'win32') expect(mode).toBe(0o600);
      else expect(typeof mode).toBe('number');
    });
  });
});
