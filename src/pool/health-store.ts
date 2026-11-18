import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';

export type HealthStatus = 'healthy' | 'cooling' | 'halfOpen';

export interface HealthRecord {
  status: HealthStatus;
  cooldownUntil?: number;
  failures: number;
}

const VALID: HealthStatus[] = ['healthy', 'cooling', 'halfOpen'];

export interface HealthStore {
  get(accountId: string): HealthRecord | undefined;
  set(accountId: string, record: HealthRecord): void;
  flush(): void;
}

/** Persists ONLY health metadata — no credentials, emails or tokens. */
export function createHealthStore(filePath: string, debounceMs = 0): HealthStore {
  const records = new Map<string, HealthRecord>();
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, HealthRecord>;
      for (const [id, record] of Object.entries(parsed ?? {})) {
        if (record && VALID.includes(record.status)) {
          records.set(id, {
            status: record.status,
            ...(record.cooldownUntil !== undefined ? { cooldownUntil: record.cooldownUntil } : {}),
            failures: record.failures || 0,
          });
        }
      }
    } catch {
      // Corrupt file stays on disk until a real change replaces it atomically.
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush(): void {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${filePath}.tmp`;
    const payload = Object.fromEntries(
      Array.from(records.entries()).sort(([a], [b]) => a.localeCompare(b))
    );
    writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, filePath);
    try { chmodSync(filePath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
  }

  return {
    get(accountId) { return records.get(accountId); },
    set(accountId, record) {
      if (!VALID.includes(record.status)) throw new Error(`Invalid health status: ${record.status}`);
      records.set(accountId, {
        status: record.status,
        ...(record.cooldownUntil !== undefined ? { cooldownUntil: record.cooldownUntil } : {}),
        failures: record.failures || 0,
      });
      if (debounceMs > 0) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
      } else {
        flush();
      }
    },
    flush,
  };
}

export const globalHealthStore = createHealthStore(
  join(process.env.DATA_DIR || 'data', 'account-health.json'),
  250
);
