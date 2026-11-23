import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { basename, dirname, join } from 'path';

export interface LedgerEvent {
  requestId?: string;
  timestamp: number;
  method: string;
  path: string;
  provider: string;
  accountId?: string;
  model: string;
  status: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
}

export interface LedgerMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalRequests: number;
  providerTokens: Record<string, { prompt: number; completion: number; total: number }>;
  providerRequests: Record<string, number>;
}

export interface LedgerOptions {
  /** Drop records older than this on load/append. Default: 7 days. */
  retentionMs?: number;
  /** Rotate the active file after it grows past this. Default: 10 MiB. */
  maxFileBytes?: number;
  /** Rotate after this much wall time since the active file was opened. Default: 24h. */
  rotateEveryMs?: number;
  /** How many recent events are cached for readRecent(). Default: 10 000. */
  recentCacheSize?: number;
  now?: () => number;
}

const DEFAULT_OPTIONS: Required<LedgerOptions> = {
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxFileBytes: 10 * 1024 * 1024,
  rotateEveryMs: 24 * 60 * 60 * 1000,
  recentCacheSize: 10_000,
  now: () => Date.now(),
};

interface Point {
  timestamp: number;
  dPrompt: number;
  dCompletion: number;
  dTotal: number;
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cumulativeRequests: number;
}

function emptyPoint(timestamp: number): Point {
  return {
    timestamp,
    dPrompt: 0,
    dCompletion: 0,
    dTotal: 0,
    requests: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cumulativeRequests: 0,
  };
}

function addPoint(points: Point[], timestamp: number, prompt: number, completion: number, total: number): void {
  const last = points[points.length - 1];
  if (last && timestamp < last.timestamp) {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].timestamp < timestamp) lo = mid + 1;
      else hi = mid;
    }
    points.splice(lo, 0, {
      ...emptyPoint(timestamp),
      dPrompt: prompt,
      dCompletion: completion,
      dTotal: total,
      requests: 1,
    });
    // Recompute cumulative values from the insertion point onward.
    const previous = lo > 0 ? points[lo - 1] : emptyPoint(-Infinity);
    let p = previous.prompt;
    let c = previous.completion;
    let t = previous.total;
    let r = previous.cumulativeRequests;
    for (let i = lo; i < points.length; i++) {
      p += points[i].dPrompt;
      c += points[i].dCompletion;
      t += points[i].dTotal;
      r += points[i].requests;
      points[i].prompt = p;
      points[i].completion = c;
      points[i].total = t;
      points[i].cumulativeRequests = r;
    }
    return;
  }
  points.push({
    ...emptyPoint(timestamp),
    dPrompt: prompt,
    dCompletion: completion,
    dTotal: total,
    requests: 1,
    prompt: (last?.prompt ?? 0) + prompt,
    completion: (last?.completion ?? 0) + completion,
    total: (last?.total ?? 0) + total,
    cumulativeRequests: (last?.cumulativeRequests ?? 0) + 1,
  });
}

/** Locate the first point at or after `sinceMs`. */
function lowerBound(points: Point[], sinceMs: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].timestamp < sinceMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function totalsAt(points: Point[], sinceMs: number) {
  const idx = lowerBound(points, sinceMs);
  const before = idx > 0 ? points[idx - 1] : emptyPoint(0);
  const atEnd = points[points.length - 1] ?? emptyPoint(0);
  return {
    prompt: atEnd.prompt - before.prompt,
    completion: atEnd.completion - before.completion,
    total: atEnd.total - before.total,
    requests: atEnd.cumulativeRequests - before.cumulativeRequests,
  };
}

function parseLines(raw: string): { events: LedgerEvent[]; validLength: number } {
  const events: LedgerEvent[] = [];
  const lines = raw.split('\n');
  let offset = 0;
  let validLength = 0;
  let lastInvalidAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const end = offset + line.length + 1;
    if (!line.trim()) {
      offset = end;
      if (i < lines.length - 1) validLength = end;
      continue;
    }
    try {
      events.push(JSON.parse(line) as LedgerEvent);
      validLength = end;
    } catch {
      // A corrupt line in the middle is skipped; only a truncated tail is
      // repaired by truncating the file to its valid prefix.
      lastInvalidAt = end;
    }
    offset = end;
  }
  return { events, validLength: lastInvalidAt >= validLength ? validLength : raw.length };
}

function rotatedFilePath(activePath: string, stamp: string): string {
  return join(dirname(activePath), `${basename(activePath, '.ndjson')}.${stamp}.ndjson`);
}

export function createLedger(filePath: string, options: LedgerOptions = {}) {
  const opts: Required<LedgerOptions> = { ...DEFAULT_OPTIONS, ...options };
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  let timeline: Point[] = [];
  const providerTimelines = new Map<string, Point[]>();
  let recent: LedgerEvent[] = [];
  let rotatedFiles: string[] = [];
  let openedAt = opts.now();

  function files(): string[] {
    return [filePath, ...rotatedFiles].filter((f) => existsSync(f));
  }

  function rebuild(): void {
    const all: LedgerEvent[] = [];
    for (const file of files()) {
      const raw = readFileSync(file, 'utf8');
      const { events, validLength } = parseLines(raw);
      if (validLength < raw.length) writeFileSync(file, raw.slice(0, validLength), 'utf8');
      for (const event of events) all.push(event);
    }
    // Retention is applied by prune()/rotation, not by load: older records are
    // still readable until maintenance runs.
    const fresh = all;

    timeline = [];
    providerTimelines.clear();
    // Build aggregates in timestamp order: each point is then a constant-time
    // append instead of an O(n) insertion into an already-built timeline.
    const sorted = [...fresh].sort((a, b) => a.timestamp - b.timestamp);
    for (const event of sorted) {
      const prompt = event.promptTokens || 0;
      const completion = event.completionTokens || 0;
      const total = event.totalTokens || 0;
      addPoint(timeline, event.timestamp, prompt, completion, total);
      const provider = event.provider || 'unknown';
      const points = providerTimelines.get(provider) ?? [];
      addPoint(points, event.timestamp, prompt, completion, total);
      providerTimelines.set(provider, points);
    }
    recent = fresh.slice(-opts.recentCacheSize);
  }

  function rotate(): void {
    if (!existsSync(filePath)) return;
    const stamp = `${opts.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const target = rotatedFilePath(filePath, stamp);
    renameSync(filePath, target);
    rotatedFiles.push(target);
    openedAt = opts.now();
  }

  function maybeRotate(): void {
    if (!existsSync(filePath)) return;
    const size = statSync(filePath).size;
    if (size >= opts.maxFileBytes || opts.now() - openedAt >= opts.rotateEveryMs) rotate();
  }

  rotatedFiles = readdirSync(dir)
    .filter((f) => f.startsWith(`${basename(filePath, '.ndjson')}.`) && f.endsWith('.ndjson'))
    .map((f) => join(dir, f))
    .filter((f) => f !== filePath)
    .sort();
  rebuild();

  return {
    append(event: LedgerEvent): void {
      maybeRotate();
      appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
      const prompt = event.promptTokens || 0;
      const completion = event.completionTokens || 0;
      const total = event.totalTokens || 0;
      addPoint(timeline, event.timestamp, prompt, completion, total);
      const provider = event.provider || 'unknown';
      const points = providerTimelines.get(provider) ?? [];
      addPoint(points, event.timestamp, prompt, completion, total);
      providerTimelines.set(provider, points);
      recent.push(event);
      if (recent.length > opts.recentCacheSize) recent.shift();
    },

    readRecent(limit = 20): LedgerEvent[] {
      return recent.slice(-limit).reverse();
    },

    metrics(sinceMs = 0): LedgerMetrics {
      const overall = totalsAt(timeline, sinceMs);
      // Null-prototype objects: a provider literally named "__proto__" is data,
      // not an assignment to Object.prototype.
      const providerTokens: Record<string, { prompt: number; completion: number; total: number }> =
        Object.create(null);
      const providerRequests: Record<string, number> = Object.create(null);
      for (const [provider, points] of providerTimelines) {
        const totals = totalsAt(points, sinceMs);
        if (totals.requests === 0) continue;
        providerTokens[provider] = {
          prompt: totals.prompt,
          completion: totals.completion,
          total: totals.total,
        };
        providerRequests[provider] = totals.requests;
      }
      return {
        promptTokens: overall.prompt,
        completionTokens: overall.completion,
        totalTokens: overall.total,
        totalRequests: overall.requests,
        providerTokens,
        providerRequests,
      };
    },

    /** Remove records outside the retention window and rebuild aggregates. */
    prune(): number {
      const cutoff = opts.now() - opts.retentionMs;
      let removed = 0;
      for (const file of files()) {
        const raw = readFileSync(file, 'utf8');
        const { events, validLength } = parseLines(raw);
        const kept = events.filter((event) => event.timestamp >= cutoff);
        removed += events.length - kept.length;
        const content = kept.map((event) => `${JSON.stringify(event)}\n`).join('');
        if (content !== raw.slice(0, validLength)) writeFileSync(file, content, 'utf8');
      }
      rebuild();
      return removed;
    },

    /** Manually rotate the active file. */
    rotate(): void {
      rotate();
      rebuild();
    },

    load(): void {
      rebuild();
    },

    stats(): {
      activeFile: string;
      rotatedFiles: number;
      cachedEvents: number;
      aggregatePoints: number;
    } {
      return {
        activeFile: filePath,
        rotatedFiles: rotatedFiles.length,
        cachedEvents: recent.length,
        aggregatePoints: timeline.length,
      };
    },
  };
}
