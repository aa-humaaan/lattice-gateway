import type { StoredAccount, AccountStatus } from '../core/types/plugin';
import { logger } from '../utils/logger';

export class AccountPoolManager {
  private accounts = new Map<string, StoredAccount>();
  private providerIndices = new Map<string, number>();

  addAccount(account: StoredAccount): void {
    this.accounts.set(account.id, {
      ...account,
      status: account.status || 'active',
      errorCount: account.errorCount || 0,
      createdAt: account.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
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
        logger.info(`[AccountPool] Account ${a.id} cooldown expired — auto-restored to active`);
      }
      return a.status === 'active';
    });
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
      acc.cooldownReason = reason || 'Rate limit 429';
      acc.errorCount++;
      acc.updatedAt = Date.now();
      logger.warn(
        `[AccountPool] Account ${accountId} placed in cooldown for ${retryAfterSeconds}s (${acc.cooldownReason})`
      );
    }
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
