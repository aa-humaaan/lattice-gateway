import type { StoredAccount, AccountStatus } from '../core/types/plugin';
import { logger } from '../utils/logger';
import { randomBytes } from 'crypto';
import { globalHealthStore, type HealthStore } from './health-store';

const QUOTA_EXHAUSTION_THRESHOLD_SECONDS = 3600;

export class AccountPoolManager {
  constructor(private readonly healthStore: HealthStore = globalHealthStore) {}

  private accounts = new Map<string, StoredAccount>();
  private leases = new Map<string, { accountId: string; providerId: string; expiresAt: number }>();
  private providerIndices = new Map<string, number>();
  private providerUsage = new Map<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      requestsUsed: number;
    }
  >();

  acquireLease(providerId: string, candidateIds: string[], ttlMs = 60_000): { leaseId: string; accountId: string } | undefined {
    const now = Date.now();
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
    const leased = new Set(
      Array.from(this.leases.values())
        .filter((lease) => lease.providerId === providerId)
        .map((lease) => lease.accountId)
    );
    const accountId = candidateIds.find((id) => !leased.has(id));
    if (!accountId) return undefined;
    const leaseId = randomBytes(8).toString('hex');
    this.leases.set(leaseId, { accountId, providerId, expiresAt: now + ttlMs });
    return { leaseId, accountId };
  }

  releaseLease(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  recordUsageForAccount(accountId: string, promptTokens: number, completionTokens: number): void {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    acc.tokensUsed = (acc.tokensUsed || 0) + promptTokens + completionTokens;
    acc.requestsUsed = (acc.requestsUsed || 0) + 1;
    acc.lastUsedAt = Date.now();
    this.healthStore.set(accountId, { status: 'healthy', failures: 0 });
  }

  addAccount(account: StoredAccount): void {
    const merged: StoredAccount = {
      ...account,
      status: account.status || 'active',
      errorCount: account.errorCount || 0,
      createdAt: account.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    const health = this.healthStore.get(account.id);
    if (health && account.status === 'active') {
      if (health.status === 'cooling' && health.cooldownUntil && health.cooldownUntil > Date.now()) {
        merged.status = 'cooldown';
        merged.cooldownUntil = health.cooldownUntil;
      } else if (health.status === 'halfOpen' || (health.status === 'cooling' && health.cooldownUntil && health.cooldownUntil <= Date.now())) {
        this.healthStore.set(account.id, { status: 'halfOpen', failures: health.failures });
      }
    }
    this.accounts.set(account.id, merged);
    logger.info(`[AccountPool] Added/updated account: ${account.id} for provider: ${account.providerId}`);
  }

  getAccount(id: string): StoredAccount | undefined {
    return this.accounts.get(id);
  }

  deleteAccount(id: string): boolean {
    return this.accounts.delete(id);
  }

  listAccounts(providerId?: string): StoredAccount[] {
    const all = Array.from(this.accounts.values());
    if (providerId) {
      return all.filter((a) => a.providerId === providerId);
    }
    return all;
  }

  getActiveAccounts(providerId: string): StoredAccount[] {
    const now = Date.now();
    return this.listAccounts(providerId).filter((a) => {
      // Auto-heal cooldown if duration passed
      if (a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil <= now) {
        a.status = 'active';
        a.cooldownUntil = undefined;
        a.cooldownReason = undefined;
        a.updatedAt = now;
        this.healthStore.set(a.id, {
          status: 'halfOpen',
          failures: this.healthStore.get(a.id)?.failures ?? 0,
        });
        logger.info(`[AccountPool] Account ${a.id} cooldown expired — promoted to HalfOpen`);
      }
      return a.status === 'active';
    });
  }

  getAccountsForExecution(
    providerId: string,
    triedIds: Set<string> = new Set()
  ): StoredAccount[] {
    const active = this.getActiveAccounts(providerId);
    return active.filter((a) => !triedIds.has(a.id));
  }

  getLowestCooldownRemaining(providerId: string): number {
    const now = Date.now();
    const cooldowns = this.listAccounts(providerId)
      .filter((a) => a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil > now)
      .map((a) => Math.ceil((a.cooldownUntil! - now) / 1000));
    return cooldowns.length > 0 ? Math.min(...cooldowns) : 30;
  }

  getAccountDepth(providerId: string): {
    total: number;
    active: number;
    cooldown: number;
    lowestCooldownSec?: number;
  } {
    const now = Date.now();
    const all = this.listAccounts(providerId);
    const active = all.filter((a) => {
      if (a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil <= now) {
        a.status = 'active';
        return true;
      }
      return a.status === 'active';
    });
    const cooldowns = all.filter((a) => a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil > now);
    const lowestCooldownSec =
      cooldowns.length > 0
        ? Math.min(...cooldowns.map((a) => Math.ceil((a.cooldownUntil! - now) / 1000)))
        : undefined;

    return {
      total: all.length,
      active: active.length,
      cooldown: cooldowns.length,
      lowestCooldownSec,
    };
  }

  getNextRotatedAccount(providerId: string): StoredAccount | undefined {
    const active = this.getActiveAccounts(providerId);
    if (active.length === 0) return undefined;

    const currentIndex = this.providerIndices.get(providerId) ?? 0;
    const nextIndex = (currentIndex + 1) % active.length;
    this.providerIndices.set(providerId, nextIndex);

    const account = active[nextIndex];
    account.lastUsedAt = Date.now();
    return account;
  }

  reportSuccess(accountId: string): void {
    const acc = this.accounts.get(accountId);
    if (acc) {
      acc.errorCount = 0;
      acc.lastUsedAt = Date.now();
      this.healthStore.set(accountId, { status: 'healthy', failures: 0 });
    }
  }

  clearCooldown(accountId: string): boolean {
    const acc = this.accounts.get(accountId);
    if (acc) {
      acc.status = 'active';
      acc.cooldownUntil = undefined;
      acc.cooldownReason = undefined;
      acc.errorCount = 0;
      acc.updatedAt = Date.now();
      this.healthStore.set(accountId, { status: 'healthy', failures: 0 });
      logger.info(`[AccountPool] Account ${accountId} cooldown manually cleared -> restored to active`);
      return true;
    }
    return false;
  }

  reportRateLimit(accountId: string, retryAfterSeconds = 30, reason?: string): void {
    const acc = this.accounts.get(accountId);
    if (acc) {
      acc.status = 'cooldown';
      acc.cooldownUntil = Date.now() + retryAfterSeconds * 1000;
      this.healthStore.set(accountId, {
        status: 'cooling',
        cooldownUntil: acc.cooldownUntil,
        failures: acc.errorCount,
      });
      acc.cooldownReason = reason || 'Rate limit 429';
      acc.errorCount++;
      acc.updatedAt = Date.now();

      if (retryAfterSeconds >= QUOTA_EXHAUSTION_THRESHOLD_SECONDS) {
        acc.quotaRemaining = 0;
        acc.quotaResetAt = acc.cooldownUntil;
        logger.warn(
          `[AccountPool] Account ${accountId} quota exhausted (retry-after: ${retryAfterSeconds}s) — marked quota_remaining=0 until ${new Date(acc.quotaResetAt).toISOString()}`
        );
      }

      logger.warn(
        `[AccountPool] Account ${accountId} placed in cooldown for ${retryAfterSeconds}s (${acc.cooldownReason})`
      );
    }
  }

  getQuotaStatus(providerId: string): Array<{
    accountId: string;
    status: string;
    quotaRemaining?: number;
    quotaLimit?: number;
    quotaResetAt?: number;
    cooldownUntil?: number;
  }> {
    return this.listAccounts(providerId).map((a) => ({
      accountId: a.id,
      status: a.status,
      quotaRemaining: a.quotaRemaining,
      quotaLimit: a.quotaLimit,
      quotaResetAt: a.quotaResetAt,
      cooldownUntil: a.cooldownUntil,
    }));
  }

  getNextResetTime(providerId?: string): { resetAt: number; retryAfterSeconds: number } | undefined {
    const now = Date.now();
    const accounts = providerId ? this.listAccounts(providerId) : this.listAccounts();
    let earliestReset: number | undefined;

    for (const a of accounts) {
      if (a.quotaRemaining === 0 && a.quotaResetAt && a.quotaResetAt > now) {
        if (!earliestReset || a.quotaResetAt < earliestReset) {
          earliestReset = a.quotaResetAt;
        }
      }
      if (a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil > now) {
        if (!earliestReset || a.cooldownUntil < earliestReset) {
          earliestReset = a.cooldownUntil;
        }
      }
    }

    if (earliestReset) {
      const retryAfterSeconds = Math.max(1, Math.ceil((earliestReset - now) / 1000));
      return { resetAt: earliestReset, retryAfterSeconds };
    }
    return undefined;
  }

  getProviderQuotaSummary(): Array<{
    providerId: string;
    totalAccounts: number;
    activeAccounts: number;
    quotaExhaustedAccounts: number;
    cooldownAccounts: number;
    nextResetAt?: number;
    quotaRemaining?: number;
    quotaLimit?: number;
    quotaPercent?: number;
    tokensUsed: number;
    promptTokens: number;
    completionTokens: number;
    requestsUsed: number;
    status: 'healthy' | 'warning' | 'critical' | 'exhausted';
  }> {
    const byProvider = new Map<string, StoredAccount[]>();
    for (const acc of this.accounts.values()) {
      const list = byProvider.get(acc.providerId) || [];
      list.push(acc);
      byProvider.set(acc.providerId, list);
    }

    const now = Date.now();
    const result: Array<{
      providerId: string;
      totalAccounts: number;
      activeAccounts: number;
      quotaExhaustedAccounts: number;
      cooldownAccounts: number;
      nextResetAt?: number;
      quotaRemaining?: number;
      quotaLimit?: number;
      quotaPercent?: number;
      tokensUsed: number;
      promptTokens: number;
      completionTokens: number;
      requestsUsed: number;
      status: 'healthy' | 'warning' | 'critical' | 'exhausted';
    }> = [];

    for (const [providerId, accounts] of byProvider) {
      let active = 0;
      let quotaExhausted = 0;
      let cooldown = 0;
      let nextReset: number | undefined;
      let sumQuotaRemaining = 0;
      let sumQuotaLimit = 0;
      let hasLimit = false;

      for (const a of accounts) {
        if (a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil <= now) {
          a.status = 'active';
          a.cooldownUntil = undefined;
          a.cooldownReason = undefined;
          if (a.quotaRemaining === 0 && a.quotaResetAt && a.quotaResetAt <= now) {
            a.quotaRemaining = a.quotaLimit;
            a.quotaResetAt = undefined;
            logger.info(`[AccountPool] Account ${a.id} quota window reset — restored to ${a.quotaRemaining}`);
          }
        }

        if (a.status === 'active') active++;
        else if (a.status === 'cooldown') cooldown++;

        if (a.quotaRemaining === 0) {
          quotaExhausted++;
          if (a.quotaResetAt && (!nextReset || a.quotaResetAt < nextReset)) {
            nextReset = a.quotaResetAt;
          }
        } else if (a.status === 'cooldown' && a.cooldownUntil) {
          if (!nextReset || a.cooldownUntil < nextReset) {
            nextReset = a.cooldownUntil;
          }
        }

        if (a.quotaLimit !== undefined) {
          hasLimit = true;
          sumQuotaLimit += a.quotaLimit;
          sumQuotaRemaining += a.quotaRemaining ?? a.quotaLimit;
        }
      }

      const provUsage = this.providerUsage.get(providerId) || {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requestsUsed: 0,
      };

      const quotaPercent = hasLimit && sumQuotaLimit > 0
        ? Math.round((sumQuotaRemaining / sumQuotaLimit) * 100)
        : undefined;

      let status: 'healthy' | 'warning' | 'critical' | 'exhausted' = 'healthy';
      if (active === 0 || quotaExhausted === accounts.length) {
        status = 'exhausted';
      } else if (quotaPercent !== undefined && quotaPercent <= 15) {
        status = 'critical';
      } else if (cooldown > 0 || (quotaPercent !== undefined && quotaPercent <= 40)) {
        status = 'warning';
      }

      result.push({
        providerId,
        totalAccounts: accounts.length,
        activeAccounts: active,
        quotaExhaustedAccounts: quotaExhausted,
        cooldownAccounts: cooldown,
        nextResetAt: nextReset,
        quotaRemaining: hasLimit ? sumQuotaRemaining : undefined,
        quotaLimit: hasLimit ? sumQuotaLimit : undefined,
        quotaPercent,
        tokensUsed: provUsage.totalTokens,
        promptTokens: provUsage.promptTokens,
        completionTokens: provUsage.completionTokens,
        requestsUsed: provUsage.requestsUsed,
        status,
      });
    }

    return result;
  }

  recordTokenUsage(accountId: string, promptTokens: number, completionTokens: number): void {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    const total = promptTokens + completionTokens;
    if (acc.quotaRemaining !== undefined) {
      acc.quotaRemaining = Math.max(0, acc.quotaRemaining - total);
    }
    acc.tokensUsed = (acc.tokensUsed || 0) + total;
    acc.requestsUsed = (acc.requestsUsed || 0) + 1;
    acc.lastUsedAt = Date.now();
    acc.updatedAt = Date.now();

    const prov = this.providerUsage.get(acc.providerId) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestsUsed: 0,
    };
    prov.promptTokens += promptTokens;
    prov.completionTokens += completionTokens;
    prov.totalTokens += total;
    prov.requestsUsed += 1;
    this.providerUsage.set(acc.providerId, prov);
  }

  /**
   * Records token usage against the most recently used active account for a provider.
   * Used at the gateway edge when the router knows the provider but not the exact account.
   */
  recordProviderUsage(providerId: string, promptTokens: number, completionTokens: number): void {
    const accounts = this.listAccounts(providerId).filter((a) => a.status === 'active');
    const total = promptTokens + completionTokens;
    if (accounts.length > 0) {
      accounts.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
      const acc = accounts[0];
      if (acc.quotaRemaining !== undefined) {
        acc.quotaRemaining = Math.max(0, acc.quotaRemaining - total);
      }
      acc.tokensUsed = (acc.tokensUsed || 0) + total;
      acc.requestsUsed = (acc.requestsUsed || 0) + 1;
      acc.lastUsedAt = Date.now();
      acc.updatedAt = Date.now();
    }

    const prov = this.providerUsage.get(providerId) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestsUsed: 0,
    };
    prov.promptTokens += promptTokens;
    prov.completionTokens += completionTokens;
    prov.totalTokens += total;
    prov.requestsUsed += 1;
    this.providerUsage.set(providerId, prov);
  }

  reportError(accountId: string, isPermanent = false, reason?: string): void {
    const acc = this.accounts.get(accountId);
    if (acc) {
      acc.errorCount++;
      acc.updatedAt = Date.now();
      if (isPermanent || acc.errorCount >= 5) {
        acc.status = 'invalid';
        logger.error(`[AccountPool] Account ${accountId} marked invalid: ${reason || 'Too many errors'}`);
      }
    }
  }
}

export const globalAccountPool = new AccountPoolManager();
