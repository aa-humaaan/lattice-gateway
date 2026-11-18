import { createHash } from 'crypto';

export interface SessionAffinitySummary {
  sessionKey: string;
  targetModel?: string;
  accounts: Array<{ providerId: string; accountId: string }>;
  expiresAt: number;
}

export interface SessionAffinityStore {
  getTarget(sessionKey: string): string | undefined;
  pinTarget(sessionKey: string, targetModel: string): void;
  getAccount(sessionKey: string, providerId: string): string | undefined;
  pinAccount(sessionKey: string, providerId: string, accountId: string): void;
  listSummary(): SessionAffinitySummary[];
}

interface AffinityEntry {
  targetModel?: string;
  accounts: Map<string, string>;
  updatedAt: number;
}

export interface SessionAffinityOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

function headerValue(
  headers: Headers | Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

function metadataValue(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const metadata = (body as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const record = metadata as Record<string, unknown>;
  for (const key of ['session_id', 'conversation_id', 'task_id']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

export function deriveSessionKey(
  headers?: Headers | Record<string, string>,
  body?: unknown
): string | undefined {
  const raw = (headerValue(headers, 'x-lattice-session') ?? metadataValue(body))?.trim();
  if (!raw || raw.length > 512) return undefined;
  return `ses_${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

export function createSessionAffinityStore(
  options: SessionAffinityOptions = {}
): SessionAffinityStore {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, AffinityEntry>();

  function lookup(sessionKey: string, touch: boolean): AffinityEntry | undefined {
    const entry = entries.get(sessionKey);
    if (!entry) return undefined;
    const time = now();
    if (time - entry.updatedAt > ttlMs) {
      entries.delete(sessionKey);
      return undefined;
    }
    if (touch) entry.updatedAt = time;
    return entry;
  }

  function current(sessionKey: string): AffinityEntry | undefined {
    return lookup(sessionKey, true);
  }

  function createOrTouch(sessionKey: string): AffinityEntry {
    const existing = current(sessionKey);
    if (existing) return existing;
    if (entries.size >= maxEntries) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of entries) {
        if (entry.updatedAt < oldestTime) {
          oldestKey = key;
          oldestTime = entry.updatedAt;
        }
      }
      if (oldestKey) entries.delete(oldestKey);
    }
    const entry = { accounts: new Map<string, string>(), updatedAt: now() };
    entries.set(sessionKey, entry);
    return entry;
  }

  return {
    getTarget(sessionKey) {
      return current(sessionKey)?.targetModel;
    },
    pinTarget(sessionKey, targetModel) {
      createOrTouch(sessionKey).targetModel = targetModel;
    },
    getAccount(sessionKey, providerId) {
      return current(sessionKey)?.accounts.get(providerId);
    },
    pinAccount(sessionKey, providerId, accountId) {
      createOrTouch(sessionKey).accounts.set(providerId, accountId);
    },
    listSummary() {
      const summaries: SessionAffinitySummary[] = [];
      for (const sessionKey of Array.from(entries.keys())) {
        const entry = lookup(sessionKey, false);
        if (!entry) continue;
        summaries.push({
          sessionKey,
          ...(entry.targetModel ? { targetModel: entry.targetModel } : {}),
          accounts: Array.from(entry.accounts, ([providerId, accountId]) => ({ providerId, accountId }))
            .sort((a, b) => a.providerId.localeCompare(b.providerId)),
          expiresAt: entry.updatedAt + ttlMs,
        });
      }
      return summaries.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
    },
  };
}

export const globalSessionAffinityStore = createSessionAffinityStore();
