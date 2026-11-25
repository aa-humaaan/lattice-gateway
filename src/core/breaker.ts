/** Provider-level circuit breaker. Only provider-health failures count. */
import { GatewayError } from './types/errors';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  failureThreshold: number;
  backoffBaseMs: number;
  backoffCeilingMs: number;
  jitterRatio: number;
  now: () => number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  backoffBaseMs: 1_000,
  backoffCeilingMs: 30_000,
  jitterRatio: 0.2,
  now: () => Date.now(),
};

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * 5xx, timeouts and network failures are provider health signals. Client 4xx
 * (including 429 throttling, handled by the quota cooldown) and caller aborts
 * are never counted.
 */
export function isProviderHealthFailure(error: unknown): boolean {
  if (!error) return false;
  const err = error as {
    name?: string;
    code?: string;
    message?: string;
    status?: number;
    statusCode?: number;
    cause?: { code?: string; message?: string };
  };

  const name = err.name ?? '';
  const code = err.code ?? '';
  // Aborts are identified by type/code only. Status and error type take
  // precedence over message text: a 500 saying "aborted upstream" is a
  // provider failure, not a caller abort.
  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return false;
  }

  if (error instanceof GatewayError) {
    return (err.status ?? 0) >= 500;
  }
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number') return status >= 500;

  if (name === 'TimeoutError' || NETWORK_CODES.has(code)) return true;
  if (err.cause && NETWORK_CODES.has(err.cause.code ?? '')) return true;
  return /fetch failed|socket hang up|network|timed?\s*out|timeout/i.test(err.message ?? '');
}

export class ProviderBreaker {
  state: BreakerState = 'closed';
  failures = 0;
  nextRetryAt = 0;
  private probeInFlight = false;
  private config: BreakerConfig;

  constructor(readonly providerId: string, config: BreakerConfig = DEFAULT_BREAKER_CONFIG) {
    this.config = { ...config };
  }

  configure(patch: Partial<BreakerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  private exponentialDelay(): number {
    const raw = this.config.backoffBaseMs * Math.pow(2, Math.max(0, this.failures - 1));
    const bounded = Math.min(this.config.backoffCeilingMs, raw);
    const jitter = bounded * this.config.jitterRatio * Math.random();
    return Math.min(this.config.backoffCeilingMs, bounded + jitter);
  }

  /** Milliseconds until the next attempt is allowed; 0 when it is allowed now. */
  retryDelayMs(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.nextRetryAt - this.config.now());
  }

  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.probeInFlight) return false;
    if (this.state === 'half-open') return true;
    return this.config.now() >= this.nextRetryAt;
  }

  /** Mark a permitted attempt in flight; an expired open breaker becomes half-open. */
  beginAttempt(): void {
    if (this.state === 'open' && this.config.now() >= this.nextRetryAt) {
      this.state = 'half-open';
    }
    if (this.state === 'half-open') this.probeInFlight = true;
  }

  /** Clear a probe that ended without a recorded outcome (e.g. caller abort). */
  cancelProbe(): void {
    this.probeInFlight = false;
  }

  /** Observable probe state for tests and admin diagnostics. */
  get isProbeInFlight(): boolean {
    return this.probeInFlight;
  }

  recordSuccess(): void {
    this.cancelProbe();
    this.failures = 0;
    this.nextRetryAt = 0;
    this.state = 'closed';
  }

  /** Returns true only when the error was a counted provider-health failure. */
  recordFailure(error?: unknown): boolean {
    // Even an uncounted outcome ends an in-flight probe.
    this.cancelProbe();
    if (error !== undefined && !isProviderHealthFailure(error)) return false;
    this.failures += 1;
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      this.nextRetryAt = this.config.now() + this.exponentialDelay();
    } else {
      this.state = 'closed';
      this.nextRetryAt = 0;
    }
    return true;
  }

  reset(): void {
    this.cancelProbe();
    this.failures = 0;
    this.nextRetryAt = 0;
    this.state = 'closed';
  }
}

export class BreakerRegistry {
  private breakers = new Map<string, ProviderBreaker>();

  constructor(private defaults: Partial<BreakerConfig> = {}) {}

  setDefaults(patch: Partial<BreakerConfig>): void {
    this.defaults = { ...this.defaults, ...patch };
  }

  get(providerId: string): ProviderBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new ProviderBreaker(providerId, { ...DEFAULT_BREAKER_CONFIG, ...this.defaults });
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  configure(providerId: string, patch: Partial<BreakerConfig>): ProviderBreaker {
    const breaker = this.get(providerId);
    breaker.configure(patch);
    return breaker;
  }

  /** Clear one provider's breaker, including a probe wedged by a leaked attempt. */
  resetProvider(providerId: string): ProviderBreaker {
    const breaker = this.get(providerId);
    breaker.reset();
    return breaker;
  }

  reset(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }
}

export const globalBreakerRegistry = new BreakerRegistry();
