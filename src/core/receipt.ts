import { redactSecrets } from '../utils/redact';
import type { LedgerEvent } from './request-ledger';

export interface Receipt {
  requestId?: string;
  provider: string;
  accountId?: string;
  model: string;
  status: number;
  latencyMs: number;
  totalTokens: number;
  estimated: boolean;
  lines: string[];
}

export function findLedgerEvent(
  ledger: { readRecent(limit?: number): LedgerEvent[] },
  id: string
): LedgerEvent | undefined {
  if (!id) return undefined;
  const all = ledger.readRecent(100000);
  return all.find((event) => event.requestId === id || event.requestId?.includes(id));
}

export function buildReceipt(event: LedgerEvent): Receipt {
  const outcome = event.status >= 200 && event.status < 300 ? 'completed' : `failed (HTTP ${event.status})`;
  const lines = [
    `Request ${event.requestId ?? '(no id)'}: ${event.method} ${event.path}`,
    `Outcome: HTTP ${event.status} ${outcome}`,
    `Provider: ${event.provider}  Model: ${event.model}` +
      (event.accountId ? `  Account: ${event.accountId}` : ''),
    `Latency: ${event.latencyMs}ms`,
    `Tokens: ${event.promptTokens} prompt + ${event.completionTokens} completion = ${event.totalTokens}` +
      (event.estimated ? ' (estimated)' : ' (reported)'),
  ].map(redactSecrets);
  return {
    requestId: event.requestId,
    provider: event.provider,
    ...(event.accountId ? { accountId: event.accountId } : {}),
    model: event.model,
    status: event.status,
    latencyMs: event.latencyMs,
    totalTokens: event.totalTokens,
    estimated: !!event.estimated,
    lines,
  };
}
