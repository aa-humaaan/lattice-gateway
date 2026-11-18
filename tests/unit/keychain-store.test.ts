import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createKeychainStore,
  detectSecretBackend,
  globalSecretStore,
  type CommandRunner,
  type SecretBackend,
} from '../../src/core/secret-store';

const fakeRunner = (handler: (cmd: string, args: string[], input?: string) => { stdout: string; exitCode: number }): CommandRunner =>
  ((cmd: string, args: string[], input?: string) => handler(cmd, args, input));

describe('secret backend detection', () => {
  test('windows selects dpapi when the probe succeeds', () => {
    const runner = fakeRunner((_cmd, args, input = '') => {
      const script = args[args.length - 1] || '';
      if (script.includes('Unprotect(')) {
        return { stdout: Buffer.from(Buffer.from(input, 'base64').toString().replace(/^enc:/, '')).toString('base64'), exitCode: 0 };
      }
      if (script.includes('Protect(')) {
        return { stdout: Buffer.from(`enc:${input}`).toString('base64'), exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    });
    expect(detectSecretBackend('win32', runner)).toBe('os-dpapi');
  });

  test('macos selects the security CLI when available', () => {
    const runner = fakeRunner(() => ({ stdout: '', exitCode: 0 }));
    expect(detectSecretBackend('darwin', runner)).toBe('keychain');
  });

  test('linux selects secret-tool when available', () => {
    const runner = fakeRunner(() => ({ stdout: '', exitCode: 0 }));
    expect(detectSecretBackend('linux', runner)).toBe('keychain');
  });

  test('an unavailable tool falls back to file storage', () => {
    const runner = fakeRunner(() => ({ stdout: '', exitCode: 127 }));
    expect(detectSecretBackend('darwin', runner)).toBe('file-fallback');
    expect(detectSecretBackend('linux', runner)).toBe('file-fallback');
  });

  test('an unknown platform falls back', () => {
    expect(detectSecretBackend('freebsd', fakeRunner(() => ({ stdout: '', exitCode: 0 })))).toBe('file-fallback');
  });
});

describe('keychain store', () => {
  test('windows dpapi round-trips a secret through an injected runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-keychain-'));
    try {
      const runner = fakeRunner((_cmd, args, input = '') => {
        const script = args[args.length - 1] || '';
        if (script.includes('Unprotect(')) {
          return { stdout: Buffer.from(Buffer.from(input, 'base64').toString().replace(/^enc:/, '')).toString('base64'), exitCode: 0 };
        }
        if (script.includes('Protect(')) {
          return { stdout: Buffer.from(`enc:${input}`).toString('base64'), exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      });
      const store = createKeychainStore({ platform: 'win32', runner, dataDir: dir });
      store.set('acc_import_1', 'apiKey', 'OS_SECRET');
      expect(store.get('acc_import_1', 'apiKey')).toBe('OS_SECRET');
      expect(store.availability()).toBe('os-dpapi');
      store.delete('acc_import_1', 'apiKey');
      expect(store.get('acc_import_1', 'apiKey')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed probe reports file fallback, not keychain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-keychain-'));
    try {
      const runner = fakeRunner(() => ({ stdout: '', exitCode: 127 }));
      const store = createKeychainStore({ platform: 'darwin', runner, dataDir: dir });
      expect(store.availability()).toBe('file-fallback');
      store.set('acc_import_1', 'apiKey', 'fallback-secret');
      expect(store.get('acc_import_1', 'apiKey')).toBe('fallback-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an explicit backend override selects keychain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-keychain-'));
    try {
      const runner = fakeRunner(() => ({ stdout: '', exitCode: 0 }));
      const store = createKeychainStore({ backend: 'keychain' as SecretBackend, platform: 'linux', runner, dataDir: dir });
      expect(store.availability()).toBe('keychain');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the DPAPI availability probe is cached, not repeated per call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-keychain-'));
    try {
      let calls = 0;
      const runner = fakeRunner((_cmd, args, input = '') => {
        calls++;
        const script = args[args.length - 1] || '';
        if (script.includes('Unprotect(')) {
          return { stdout: Buffer.from(Buffer.from(input, 'base64').toString().replace(/^enc:/, '')).toString('base64'), exitCode: 0 };
        }
        if (script.includes('Protect(')) {
          return { stdout: Buffer.from(`enc:${input}`).toString('base64'), exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      });
      const store = createKeychainStore({ platform: 'win32', runner, dataDir: dir });
      expect(store.availability()).toBe('os-dpapi');
      expect(store.availability()).toBe('os-dpapi');
      expect(calls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the default global facade stays file fallback', () => {
    expect(globalSecretStore.availability()).toBe('file-fallback');
  });
});

