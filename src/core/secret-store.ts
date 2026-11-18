import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';

export type SecretAvailability = 'file-fallback' | 'keychain' | 'os-dpapi';
export type SecretBackend = SecretAvailability;

export interface SecretStore {
  get(accountId: string, key: string): string | undefined;
  set(accountId: string, key: string, value: string): void;
  delete(accountId: string, key: string): void;
  availability(): SecretAvailability;
}

export interface CommandResult { stdout: string; exitCode: number }
export type CommandRunner = (cmd: string, args: string[], input?: string) => CommandResult;

function namespaced(accountId: string, key: string): string {
  return `${accountId}::${key}`;
}

const defaultCommandRunner: CommandRunner = (cmd, args, input) => {
  try {
    const stdout = execFileSync(cmd, args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err?.stdout?.toString?.() ?? '', exitCode: err?.status ?? 1 };
  }
};

export function createFileSecretStore(filePath: string): SecretStore {
  const secrets = new Map<string, string>();
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (typeof value === 'string') secrets.set(key, value);
      }
    } catch {
      // Corrupt secret files start empty; they are never trusted half-parsed.
    }
  }

  function persist(): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${filePath}.tmp`;
    const payload = Object.fromEntries(Array.from(secrets.entries()).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, filePath);
    try { chmodSync(filePath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
  }

  return {
    get(accountId, key) { return secrets.get(namespaced(accountId, key)); },
    set(accountId, key, value) { secrets.set(namespaced(accountId, key), value); persist(); },
    delete(accountId, key) { secrets.delete(namespaced(accountId, key)); persist(); },
    availability() { return 'file-fallback'; },
  };
}

// ---------------------------------------------------------------------------
// Windows DPAPI backend (PowerShell ProtectedData, CurrentUser scope)
// ---------------------------------------------------------------------------

const DPAPI_PROTECT =
  'Add-Type -AssemblyName System.Security; $d=[Console]::In.ReadToEnd(); ' +
  '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(' +
  '[Text.Encoding]::UTF8.GetBytes($d), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))';

const DPAPI_UNPROTECT =
  'Add-Type -AssemblyName System.Security; $d=[Console]::In.ReadToEnd(); ' +
  '$p=[Security.Cryptography.ProtectedData]::Unprotect(' +
  '[Convert]::FromBase64String($d), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
  '[Convert]::ToBase64String($p)';

function createDpapiStore(filePath: string, runner: CommandRunner, alreadyProbed?: boolean): SecretStore {
  const secrets = new Map<string, string>();
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (typeof value === 'string') secrets.set(key, value);
      }
    } catch { /* corrupt store starts empty */ }
  }

  function persist(): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${filePath}.tmp`;
    const payload = Object.fromEntries(Array.from(secrets.entries()).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, filePath);
    try { chmodSync(filePath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
  }

  let probed: boolean | undefined = alreadyProbed;
  function roundTrips(): boolean {
    if (probed !== undefined) return probed;
    try {
      const plaintext = Buffer.from('lattice-keychain-probe').toString('base64');
      const sealed = runner('powershell.exe', ['-NoProfile', '-Command', DPAPI_PROTECT], plaintext);
      if (sealed.exitCode !== 0) return (probed = false);
      const restored = runner('powershell.exe', ['-NoProfile', '-Command', DPAPI_UNPROTECT], sealed.stdout.trim());
      return (probed = restored.exitCode === 0 &&
        Buffer.from(restored.stdout.trim(), 'base64').toString('utf8') === plaintext);
    } catch {
      return (probed = false);
    }
  }

  return {
    get(accountId, key) {
      const cipher = secrets.get(namespaced(accountId, key));
      if (!cipher) return undefined;
      try {
        const result = runner('powershell.exe', ['-NoProfile', '-Command', DPAPI_UNPROTECT], cipher);
        if (result.exitCode !== 0) return undefined;
        const encoded = Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
        return Buffer.from(encoded, 'base64').toString('utf8');
      } catch {
        return undefined;
      }
    },
    set(accountId, key, value) {
      const plaintext = Buffer.from(value).toString('base64');
      const result = runner('powershell.exe', ['-NoProfile', '-Command', DPAPI_PROTECT], plaintext);
      if (result.exitCode !== 0) throw new Error('OS secret backend rejected a write');
      secrets.set(namespaced(accountId, key), result.stdout.trim());
      persist();
    },
    delete(accountId, key) { secrets.delete(namespaced(accountId, key)); persist(); },
    availability() { return roundTrips() ? 'os-dpapi' : 'file-fallback'; },
  };
}

// ---------------------------------------------------------------------------
// macOS Keychain / Linux libsecret backends (CLI driven)
// ---------------------------------------------------------------------------

function createCliSecretStore(kind: 'keychain' | 'linux', runner: CommandRunner): SecretStore {
  const service = (key: string) => `lattice.${Buffer.from(key).toString('base64url')}`;

  function write(key: string, value: string): boolean {
    if (kind === 'keychain') {
      return runner('security', ['add-generic-password', '-a', 'lattice', '-s', service(key), '-w', value, '-U']).exitCode === 0;
    }
    return runner('secret-tool', ['store', '--label=lattice', 'service', 'lattice', 'key', service(key)], value).exitCode === 0;
  }

  function read(key: string): string | undefined {
    const result = kind === 'keychain'
      ? runner('security', ['find-generic-password', '-a', 'lattice', '-s', service(key), '-w'])
      : runner('secret-tool', ['lookup', 'service', 'lattice', 'key', service(key)]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  function remove(key: string): void {
    if (kind === 'keychain') {
      runner('security', ['delete-generic-password', '-a', 'lattice', '-s', service(key)]);
    } else {
      runner('secret-tool', ['clear', 'service', 'lattice', 'key', service(key)]);
    }
  }

  return {
    get(accountId, key) { return read(namespaced(accountId, key)); },
    set(accountId, key, value) {
      if (!write(namespaced(accountId, key), value)) throw new Error('OS secret backend rejected a write');
    },
    delete(accountId, key) { remove(namespaced(accountId, key)); },
    availability() {
      const tool = kind === 'keychain' ? 'security' : 'secret-tool';
      return runner('which', [tool]).exitCode === 0 ? 'keychain' : 'file-fallback';
    },
  };
}

// ---------------------------------------------------------------------------
// Backend selection — lazy, probe-gated, and injectable
// ---------------------------------------------------------------------------

export function detectSecretBackend(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultCommandRunner,
  dataDir = join(process.env.DATA_DIR || 'data')
): SecretBackend {
  if (platform === 'win32') {
    return createDpapiStore(join(dataDir, 'lattice-keychain.json'), runner).availability();
  }
  if (platform === 'darwin') {
    return runner('which', ['security']).exitCode === 0 ? 'keychain' : 'file-fallback';
  }
  if (platform === 'linux') {
    return runner('which', ['secret-tool']).exitCode === 0 ? 'keychain' : 'file-fallback';
  }
  return 'file-fallback';
}

export interface KeychainStoreOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  dataDir?: string;
  backend?: SecretBackend;
}

export function createKeychainStore(options: KeychainStoreOptions = {}): SecretStore {
  const runner = options.runner ?? defaultCommandRunner;
  const platform = options.platform ?? process.platform;
  const dataDir = options.dataDir ?? join(process.env.DATA_DIR || 'data');
  const backend = options.backend ?? detectSecretBackend(platform, runner, dataDir);

  if (backend === 'file-fallback') {
    return createFileSecretStore(join(dataDir, 'lattice-secrets.json'));
  }
  if (backend === 'os-dpapi') {
    return createDpapiStore(
      join(dataDir, 'lattice-keychain.json'),
      runner,
      options.backend === undefined // detection already probed successfully
    );
  }
  return createCliSecretStore(platform === 'darwin' ? 'keychain' : 'linux', runner);
}

// The shipped default stays file-backed. Operators opt into an OS backend with
// LATTICE_SECRET_BACKEND=keychain; selection happens on first use, never at import.
let activeSecretStore: SecretStore | undefined;
function activeSecretStoreInstance(): SecretStore {
  if (!activeSecretStore) {
    activeSecretStore = process.env.LATTICE_SECRET_BACKEND === 'keychain'
      ? createKeychainStore()
      : createFileSecretStore(join(process.env.DATA_DIR || 'data', 'lattice-secrets.json'));
  }
  return activeSecretStore;
}

export const globalSecretStore: SecretStore = {
  get(accountId, key) { return activeSecretStoreInstance().get(accountId, key); },
  set(accountId, key, value) { activeSecretStoreInstance().set(accountId, key, value); },
  delete(accountId, key) { activeSecretStoreInstance().delete(accountId, key); },
  availability() { return activeSecretStoreInstance().availability(); },
};
