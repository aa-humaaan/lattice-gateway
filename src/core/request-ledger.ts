import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface LedgerEvent {
  timestamp: number;
  method: string;
  path: string;
  provider: string;
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

function parseLines(raw: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      // A half-written trailing line from a crash is ignored, not fatal.
    }
  }
  return events;
}

export function createLedger(filePath: string) {
  function readAll(): LedgerEvent[] {
    if (!existsSync(filePath)) return [];
    return parseLines(readFileSync(filePath, 'utf8'));
  }

  return {
    append(event: LedgerEvent): void {
      const dir = dirname(filePath);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    },
    readRecent(limit = 20): LedgerEvent[] {
      const all = readAll();
      return all.slice(-limit).reverse();
    },
    metrics(sinceMs = 0): LedgerMetrics {
      const metrics: LedgerMetrics = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        totalRequests: 0,
        providerTokens: {},
        providerRequests: {},
      };
      for (const event of readAll()) {
        if (event.timestamp < sinceMs) continue;
        metrics.promptTokens += event.promptTokens || 0;
        metrics.completionTokens += event.completionTokens || 0;
        metrics.totalTokens += event.totalTokens || 0;
        metrics.totalRequests += 1;
        const provider = event.provider || 'unknown';
        const slot = metrics.providerTokens[provider] || { prompt: 0, completion: 0, total: 0 };
        slot.prompt += event.promptTokens || 0;
        slot.completion += event.completionTokens || 0;
        slot.total += event.totalTokens || 0;
        metrics.providerTokens[provider] = slot;
        metrics.providerRequests[provider] = (metrics.providerRequests[provider] || 0) + 1;
      }
      return metrics;
    },
  };
}
