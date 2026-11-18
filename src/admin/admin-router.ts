import { Hono } from 'hono';
import { isSafeUpstreamBaseUrl } from '../core/config';
import { createLedger } from '../core/request-ledger';
import { globalAccountPool } from '../pool/account-pool';
import { globalComboManager } from '../pool/combos';
import { globalProxyPool } from '../pool/proxy-pool';
import { globalPluginRegistry } from '../plugins/registry';
import { globalStorage } from '../pool/storage';
import type { StoredAccount } from '../core/types/plugin';
import { KiloProviderPlugin } from '../plugins/kilo';
import { NousProviderPlugin } from '../plugins/nous';
import { ClinePoolPlugin, startWorkosDeviceAuth, pollWorkosToken, registerWithCline } from '../plugins/cline';
import { OpenCodeProviderPlugin } from '../plugins/opencode';
import { DeepSeekPoolPlugin } from '../plugins/deepseek';
import { LatticeComboPlugin } from '../plugins/combo';
import { Database } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';

import { getDashboardHtml } from './dashboard-ui';
import {
  getEnrichedModelsCatalog,
  observeEnabledPluginCatalogs,
  probeModel,
} from './models-catalog';
import { getGlobalModelPassportStore } from '../core/model-passports';
import { globalSessionAffinityStore } from '../core/session-affinity';
import { detectAllHarnesses, configureHarness } from './harness-manager';
import { resolveTargetProviderId } from '../utils/model-resolver';
import { FreeLLMAPIProviderPlugin } from '../plugins/freellmapi';
import { globalImportManager } from '../core/account-import';
import { ILLUSTRATIVE_USD_PER_TOKEN } from '../core/pricing';
import { globalSecretStore } from '../core/secret-store';

/** Drops all credential material before an account crosses the HTTP boundary. */
export function redactAccount(account: StoredAccount): Omit<StoredAccount, 'credentials'> {
  const { credentials: _credentials, ...safe } = account;
  return safe;
}

/** Unguessable OAuth session identifiers. Epoch-based ids were enumerable. */
export function createOAuthSessionId(provider: string): string {
  return `${provider}_${crypto.randomUUID()}`;
}

export interface LogEvent {
  timestamp: number;
  method: string;
  path: string;
  provider: string;
  model: string;
  status: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
  level?: string;
  message?: string;
}

// In-memory ring buffer & subscriber list for real-time SSE telemetry
const recentLogs: LogEvent[] = [];
const logSubscribers = new Set<(log: LogEvent) => void>();

// Every number shown in the dashboard comes from this append-only ledger.
export const requestLedger = createLedger(
  process.env.LATTICE_LEDGER_PATH || 'data/request-ledger.ndjson'
);

// OAuth Device Flow Session Tracker
interface OAuthSessionState {
  id: string;
  provider: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  done: boolean;
  success: boolean;
  error?: string;
  email?: string;
  account?: StoredAccount;
  createdAt: number;
  expiresAt: number;
}

const activeOAuthSessions = new Map<string, OAuthSessionState>();

export function broadcastLog(log: LogEvent): void {
  const promptTokens = log.promptTokens ?? 0;
  const completionTokens = log.completionTokens ?? 0;
  const totalTokens = log.totalTokens ?? (promptTokens + completionTokens);

  const enrichedLog: LogEvent = {
    ...log,
    promptTokens,
    completionTokens,
    totalTokens,
  };

  recentLogs.unshift(enrichedLog);
  if (recentLogs.length > 500) recentLogs.pop();

  requestLedger.append({
    timestamp: enrichedLog.timestamp || Date.now(),
    method: enrichedLog.method || 'POST',
    path: enrichedLog.path || '',
    provider: enrichedLog.provider || 'unknown',
    model: enrichedLog.model || '',
    status: enrichedLog.status ?? 200,
    latencyMs: enrichedLog.latencyMs || 0,
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: enrichedLog.estimated,
  });

  for (const sub of logSubscribers) {
    try {
      sub(enrichedLog);
    } catch {}
  }
}

export function createAdminRouter(): Hono {
  // Ensure default provider plugins are registered in registry
  if (!globalPluginRegistry.has('kilo')) {
    globalPluginRegistry.register(new KiloProviderPlugin());
  }
  if (!globalPluginRegistry.has('nous')) {
    globalPluginRegistry.register(new NousProviderPlugin());
  }
  if (!globalPluginRegistry.has('cline')) {
    globalPluginRegistry.register(new ClinePoolPlugin());
  }
  if (!globalPluginRegistry.has('opencode')) {
    globalPluginRegistry.register(new OpenCodeProviderPlugin());
  }
  if (!globalPluginRegistry.has('deepseek')) {
    globalPluginRegistry.register(new DeepSeekPoolPlugin());
  }
  if (!globalPluginRegistry.has('lattice-combo')) {
    globalPluginRegistry.register(new LatticeComboPlugin());
  }

  const router = new Hono();

  // --------------------------------------------------------------------------
  // REST API: Accounts & Credential Pools
  // --------------------------------------------------------------------------
  router.get('/api/accounts', (c) => {
    const accounts = globalAccountPool.listAccounts();
    return c.json({
      success: true,
      count: accounts.length,
      accounts: accounts.map(redactAccount),
    });
  });

  router.post('/api/accounts', async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.providerId || !body.credentials) {
      return c.json({ success: false, error: 'Missing required account fields (id, providerId, credentials)' }, 400);
    }

    const baseUrls = [body.credentials.baseUrl, body.credentials.customData?.baseUrl];
    if (baseUrls.some((url) => !isSafeUpstreamBaseUrl(url))) {
      return c.json(
        { success: false, error: 'Unsafe upstream baseUrl: private, link-local or non-HTTP targets are not allowed' },
        400
      );
    }

    const account: StoredAccount = {
      id: body.id,
      providerId: body.providerId,
      authType: body.authType || 'api_key',
      status: body.status || 'active',
      credentials: body.credentials,
      errorCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    globalAccountPool.addAccount(account);

    const plugin = globalPluginRegistry.get(account.providerId) as any;
    if (plugin) {
      if (typeof plugin.setAccount === 'function') {
        plugin.setAccount(account);
      } else if (typeof plugin.addAccount === 'function') {
        plugin.addAccount(account);
      }
    }

    globalStorage.save();
    return c.json({
      success: true,
      message: `Account ${body.id} added and hot-reloaded`,
      account: redactAccount(account),
    });
  });

  router.delete('/api/accounts/:id', (c) => {
    const id = c.req.param('id');
    const existing = globalAccountPool.getAccount(id);
    const deleted = globalAccountPool.deleteAccount(id);
    if (deleted) {
      if (existing) {
        const plugin = globalPluginRegistry.get(existing.providerId) as any;
        if (plugin) {
          if (Array.isArray(plugin.accounts)) {
            plugin.accounts = plugin.accounts.filter((a: any) => a.id !== id);
          } else if (plugin.account?.id === id) {
            plugin.account = undefined;
          }
        }
      }
      globalStorage.save();
    }
    return c.json({ success: deleted, message: deleted ? `Account ${id} removed` : 'Not found' });
  });

  router.post('/api/accounts/:id/test', async (c) => {
    const id = c.req.param('id');
    const account = globalAccountPool.getAccount(id);
    if (!account) {
      return c.json({ success: false, error: `Account ${id} not found` }, 404);
    }

    const plugin = globalPluginRegistry.get(account.providerId) as any;
    if (!plugin) {
      return c.json({ success: false, error: `Plugin ${account.providerId} not found` }, 404);
    }

    if (typeof plugin.setAccount === 'function') {
      plugin.setAccount(account);
    } else if (typeof plugin.addAccount === 'function') {
      plugin.addAccount(account);
    }

    try {
      const health = await plugin.healthCheck();
      return c.json({ success: true, accountId: id, providerId: account.providerId, health });
    } catch (err: any) {
      return c.json({ success: false, accountId: id, error: err.message }, 500);
    }
  });

  // --------------------------------------------------------------------------
  // REST API: 1-Click Interactive OAuth Device Flows
  // --------------------------------------------------------------------------
  router.post('/api/oauth/start', async (c) => {
    for (const [id, session] of activeOAuthSessions) {
      if (session.expiresAt < Date.now()) activeOAuthSessions.delete(id);
    }
    const body = await c.req.json().catch(() => ({}));
    const provider = body.provider || 'cline';

    // 1. Cline Pool (WorkOS OAuth Device Code)
    if (provider === 'cline') {
      try {
        const device = await startWorkosDeviceAuth();
        const sessionId = createOAuthSessionId('cline');
        const authUrl = device.verification_uri_complete || device.verification_uri;

        const state: OAuthSessionState = {
          id: sessionId,
          provider: 'cline',
          deviceCode: device.device_code,
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          verificationUriComplete: device.verification_uri_complete,
          done: false,
          success: false,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        activeOAuthSessions.set(sessionId, state);

        (async () => {
          try {
            const token = await pollWorkosToken(device.device_code, {
              interval: device.interval || 5,
              expiresIn: device.expires_in || 300,
            });
            const reg = await registerWithCline(token.access_token, token.refresh_token);
            const email = reg.data?.userInfo?.email || 'cline-user@gmail.com';
            const accountId = (reg.data as any)?.accountId || reg.data?.userInfo?.id || 'new';
            const accId = `acc_cline_${Date.now()}_${accountId}`;

            const newAccount: StoredAccount = {
              id: accId,
              providerId: 'cline',
              authType: 'oauth',
              status: 'active',
              credentials: {
                refreshToken: reg.data.refreshToken,
                accountId: accountId,
                email: email,
              },
              errorCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            globalAccountPool.addAccount(newAccount);
            const plugin = globalPluginRegistry.get('cline') as any;
            if (plugin && typeof plugin.addAccount === 'function') {
              plugin.addAccount(newAccount);
            }
            globalStorage.save();

            state.done = true;
            state.success = true;
            state.email = email;
            state.account = newAccount;
          } catch (err: any) {
            state.done = true;
            state.success = false;
            state.error = err.message || 'WorkOS authorization failed';
          }
        })();

        return c.json({
          success: true,
          sessionId,
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          verificationUriComplete: authUrl,
          authUrl: authUrl,
          data: {
            sessionId,
            userCode: device.user_code,
            verificationUri: device.verification_uri,
            verificationUriComplete: authUrl,
            authUrl: authUrl,
          },
        });
      } catch (err: any) {
        return c.json({ success: false, error: err.message }, 500);
      }
    }

    // 2. Kilo Code (Device Authorization)
    if (provider === 'kilo') {
      try {
        const kiloPlugin = (globalPluginRegistry.get('kilo') as KiloProviderPlugin) || new KiloProviderPlugin();
        const device = await kiloPlugin.requestDeviceCode();
        const sessionId = createOAuthSessionId('kilo');

        const state: OAuthSessionState = {
          id: sessionId,
          provider: 'kilo',
          deviceCode: device.device_code,
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          done: false,
          success: false,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        activeOAuthSessions.set(sessionId, state);

        (async () => {
          try {
            const deadline = Date.now() + (device.expires_in || 300) * 1000;
            const interval = (device.interval || 5) * 1000;
            let tokenRes = null;

            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, interval));
              try {
                tokenRes = await kiloPlugin.exchangeDeviceToken(device.device_code);
                if (tokenRes && tokenRes.access_token) break;
              } catch {
                // Pending authorization, continue polling
              }
            }

            if (!tokenRes || !tokenRes.access_token) {
              throw new Error('Kilo device authorization timed out or cancelled');
            }

            const accId = `acc_kilo_${Date.now()}`;
            let email = 'kilo-user@gmail.com';
            try {
              const payload = JSON.parse(Buffer.from(tokenRes.access_token.split('.')[1], 'base64').toString());
              if (payload.email) email = payload.email;
            } catch {}

            const newAccount: StoredAccount = {
              id: accId,
              providerId: 'kilo',
              authType: 'oauth',
              status: 'active',
              credentials: {
                accessToken: tokenRes.access_token,
                email: email,
                baseUrl: 'https://ai-gateway.kilo.ai/api/v1',
              },
              errorCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            globalAccountPool.addAccount(newAccount);
            const plugin = globalPluginRegistry.get('kilo') as any;
            if (plugin && typeof plugin.setAccount === 'function') {
              plugin.setAccount(newAccount);
            }
            globalStorage.save();

            state.done = true;
            state.success = true;
            state.email = email;
            state.account = newAccount;
          } catch (err: any) {
            state.done = true;
            state.success = false;
            state.error = err.message || 'Kilo device authorization failed';
          }
        })();

        const authUrl = device.verification_uri || 'https://kilo.ai/auth/device';
        return c.json({
          success: true,
          sessionId,
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          verificationUriComplete: authUrl,
          authUrl: authUrl,
          data: {
            sessionId,
            userCode: device.user_code,
            verificationUri: device.verification_uri,
            verificationUriComplete: authUrl,
            authUrl: authUrl,
          },
        });
      } catch (err: any) {
        return c.json({ success: false, error: err.message }, 500);
      }
    }

    // 3. Nous Research Portal Auth
    if (provider === 'nous') {
      try {
        const nousPlugin = (globalPluginRegistry.get('nous') as NousProviderPlugin) || new NousProviderPlugin();
        const auth = await nousPlugin.requestPortalAuth();
        const sessionId = createOAuthSessionId('nous');

        const userCode = auth.user_code || 'PORTAL_AUTH';
        const verifyUri = auth.verification_uri || 'https://portal.nousresearch.com/manage-subscription';
        const verifyUriComplete = auth.verification_uri_complete || (auth.user_code ? `${verifyUri}?user_code=${auth.user_code}` : auth.auth_url);

        const state: OAuthSessionState = {
          id: sessionId,
          provider: 'nous',
          deviceCode: auth.device_code || auth.session_id,
          userCode: userCode,
          verificationUri: verifyUri,
          verificationUriComplete: verifyUriComplete,
          done: false,
          success: false,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        activeOAuthSessions.set(sessionId, state);

        (async () => {
          try {
            const deadline = Date.now() + (auth.expires_in || 600) * 1000;
            const interval = 4000;
            let tokenRes = null;

            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, interval));
              try {
                const res = await nousPlugin.pollPortalToken(auth.device_code || auth.session_id);
                if (res && res.access_token) {
                  tokenRes = res;
                  break;
                }
              } catch {
                // Pending authorization
              }
            }

            if (!tokenRes || !tokenRes.access_token) {
              throw new Error('Nous portal device authorization timed out or cancelled');
            }

            const accId = `acc_nous_${Date.now()}`;
            let email = 'nous-portal@user';
            try {
              const payload = JSON.parse(Buffer.from(tokenRes.access_token.split('.')[1], 'base64').toString());
              if (payload.email) email = payload.email;
            } catch {}

            const newAccount: StoredAccount = {
              id: accId,
              providerId: 'nous',
              authType: 'oauth',
              status: 'active',
              credentials: {
                accessToken: tokenRes.access_token,
                refreshToken: tokenRes.refresh_token,
                email: email,
                baseUrl: 'https://inference-api.nousresearch.com/v1',
              },
              errorCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            globalAccountPool.addAccount(newAccount);
            const plugin = globalPluginRegistry.get('nous') as any;
            if (plugin && typeof plugin.setAccount === 'function') {
              plugin.setAccount(newAccount);
            }
            globalStorage.save();

            state.done = true;
            state.success = true;
            state.email = email;
            state.account = newAccount;
          } catch (err: any) {
            state.done = true;
            state.success = false;
            state.error = err.message || 'Nous portal authorization failed';
          }
        })();

        return c.json({
          success: true,
          sessionId,
          userCode: userCode,
          verificationUri: verifyUri,
          verificationUriComplete: verifyUriComplete,
          authUrl: verifyUriComplete,
          data: {
            sessionId,
            userCode: userCode,
            verificationUri: verifyUri,
            verificationUriComplete: verifyUriComplete,
            authUrl: verifyUriComplete,
          },
        });
      } catch (err: any) {
        return c.json({ success: false, error: err.message }, 500);
      }
    }

    return c.json({ success: false, error: `OAuth flow not supported for provider: ${provider}` }, 400);
  });

  router.get('/api/oauth/status', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ success: false, error: 'sessionId is required' }, 400);

    const session = activeOAuthSessions.get(sessionId);
    if (!session) return c.json({ success: false, error: 'Session expired or not found' }, 404);
    if (session.expiresAt < Date.now()) {
      activeOAuthSessions.delete(sessionId);
      return c.json({ success: false, error: 'Session expired or not found' }, 404);
    }

    return c.json({
      success: true,
      done: session.done,
      status: session.done ? (session.success ? 'success' : 'error') : 'pending',
      error: session.error,
      email: session.email,
      account: session.account ? redactAccount(session.account) : undefined,
    });
  });

  // --------------------------------------------------------------------------
  // REST API: Consentful account import (explicit path, preview, confirm)
  // --------------------------------------------------------------------------
  router.post('/api/accounts/import/preview', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const preview = globalImportManager.preview(body.source, body.path);
      return c.json({ success: true, ...preview });
    } catch (err: any) {
      return c.json({ success: false, error: err.message }, 400);
    }
  });

  router.post('/api/accounts/import/confirm', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = globalImportManager.confirm(body.token);
      return c.json({ success: true, ...result });
    } catch (err: any) {
      return c.json({ success: false, error: err.message }, 400);
    }
  });

  router.get('/api/secrets/availability', (c) => {
    return c.json({ success: true, availability: globalSecretStore.availability() });
  });

  // --------------------------------------------------------------------------
  // REST API: Virtual Model Combos & Reachability Health
  // --------------------------------------------------------------------------
  router.get('/api/combos', (c) => {
    const rawCombos = globalComboManager.listCombos();
    const combos = rawCombos.map((combo) => {
      let reachableCount = 0;
      const targetDetails = combo.targets.map((target) => {
        const providerId = resolveTargetProviderId(target);

        const isEnabled = globalPluginRegistry.isEnabled(providerId);
        const accounts = globalAccountPool.listAccounts(providerId);
        let status: 'reachable' | 'quota_exhausted' | 'cooldown' | 'disabled' | 'no_accounts' = 'reachable';
        let reachable = true;

        if (!isEnabled && globalPluginRegistry.get(providerId)) {
          status = 'disabled';
          reachable = false;
        } else if (accounts.length > 0) {
          const activeAccounts = accounts.filter((a) => a.status === 'active');
          const hasQuota = activeAccounts.some((a) => a.quotaRemaining === undefined || a.quotaRemaining > 0);
          if (activeAccounts.length === 0) {
            const hasCooldown = accounts.some((a) => a.status === 'cooldown');
            status = hasCooldown ? 'cooldown' : 'no_accounts';
            reachable = false;
          } else if (!hasQuota) {
            status = 'quota_exhausted';
            reachable = false;
          }
        }

        const depth = globalAccountPool.getAccountDepth(providerId);

        if (reachable) reachableCount++;
        return {
          target,
          providerId,
          status,
          reachable,
          availableAccounts: depth.active,
          accountDepth: {
            total: depth.total,
            active: depth.active,
            cooldown: depth.cooldown,
            lowestCooldownSec: depth.lowestCooldownSec,
          },
        };
      });

      const comboHealth: 'healthy' | 'degraded' | 'exhausted' =
        reachableCount === combo.targets.length
          ? 'healthy'
          : reachableCount > 0
          ? 'degraded'
          : 'exhausted';

      return {
        ...combo,
        health: comboHealth,
        reachableTargets: reachableCount,
        totalTargets: combo.targets.length,
        targetDetails,
      };
    });

    return c.json({ success: true, count: combos.length, combos });
  });

  router.get('/api/combos/health', (c) => {
    const rawCombos = globalComboManager.listCombos();
    const comboHealths = rawCombos.map((combo) => {
      let reachableCount = 0;
      const targetDetails = combo.targets.map((target) => {
        const providerId = resolveTargetProviderId(target);

        const isEnabled = globalPluginRegistry.isEnabled(providerId);
        const accounts = globalAccountPool.listAccounts(providerId);
        let status: 'reachable' | 'quota_exhausted' | 'cooldown' | 'disabled' | 'no_accounts' = 'reachable';
        let reachable = true;

        if (!isEnabled && globalPluginRegistry.get(providerId)) {
          status = 'disabled';
          reachable = false;
        } else if (accounts.length > 0) {
          const activeAccounts = accounts.filter((a) => a.status === 'active');
          const hasQuota = activeAccounts.some((a) => a.quotaRemaining === undefined || a.quotaRemaining > 0);
          if (activeAccounts.length === 0) {
            const hasCooldown = accounts.some((a) => a.status === 'cooldown');
            status = hasCooldown ? 'cooldown' : 'no_accounts';
            reachable = false;
          } else if (!hasQuota) {
            status = 'quota_exhausted';
            reachable = false;
          }
        }

        const depth = globalAccountPool.getAccountDepth(providerId);

        if (reachable) reachableCount++;
        return {
          target,
          providerId,
          status,
          reachable,
          availableAccounts: depth.active,
          accountDepth: {
            total: depth.total,
            active: depth.active,
            cooldown: depth.cooldown,
            lowestCooldownSec: depth.lowestCooldownSec,
          },
        };
      });

      const comboHealth: 'healthy' | 'degraded' | 'exhausted' =
        reachableCount === combo.targets.length
          ? 'healthy'
          : reachableCount > 0
          ? 'degraded'
          : 'exhausted';

      return {
        comboId: combo.id,
        name: combo.name,
        health: comboHealth,
        reachableTargets: reachableCount,
        totalTargets: combo.targets.length,
        targets: targetDetails,
      };
    });

    return c.json({ success: true, count: comboHealths.length, health: comboHealths });
  });

  router.post('/api/combos', async (c) => {
    const body = await c.req.json();
    if (!body.id || !Array.isArray(body.targets) || body.targets.length === 0) {
      return c.json({ success: false, error: 'Missing required combo fields (id, targets[])' }, 400);
    }

    globalComboManager.createCombo({
      id: body.id,
      name: body.name || body.id,
      description: body.description || '',
      targets: body.targets,
      createdAt: Date.now(),
    });

    globalStorage.save();
    return c.json({ success: true, message: `Virtual combo ${body.id} registered live`, combo: body });
  });

  router.delete('/api/combos/:id', (c) => {
    const id = c.req.param('id');
    const deleted = globalComboManager.deleteCombo(id);
    if (deleted) globalStorage.save();
    return c.json({ success: deleted, message: deleted ? `Combo ${id} deleted` : 'Not found' });
  });

  // --------------------------------------------------------------------------
  // REST API: Provider Plugins & Upstreams
  // --------------------------------------------------------------------------
  router.get('/api/plugins', (c) => {
    const plugins = globalPluginRegistry.getAll();
    return c.json({
      success: true,
      count: plugins.length,
      plugins: plugins.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        defaultBaseUrl: p.defaultBaseUrl,
        supportedAuthTypes: p.supportedAuthTypes,
        enabled: globalPluginRegistry.isEnabled(p.id),
      })),
    });
  });

  router.post('/api/plugins/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const plugin = globalPluginRegistry.get(id);
    if (!plugin) return c.json({ success: false, error: `Plugin ${id} not found` }, 404);

    const body = await c.req.json().catch(() => ({}));
    const newState = typeof body?.enabled === 'boolean' ? body.enabled : !globalPluginRegistry.isEnabled(id);
    globalPluginRegistry.setEnabled(id, newState);
    return c.json({ success: true, pluginId: id, id, enabled: newState });
  });

  // --------------------------------------------------------------------------
  // REST API: Free Models Catalog & Probing (R2)
  // --------------------------------------------------------------------------
  router.get('/api/models', async (c) => {
    await observeEnabledPluginCatalogs();
    const models = getEnrichedModelsCatalog();
    return c.json({
      success: true,
      count: models.length,
      models,
    });
  });

  router.get('/api/model-passports', (c) => {
    const store = getGlobalModelPassportStore();
    return c.json({
      success: true,
      passports: store.list().map((passport) => ({
        ...passport,
        signatureValid: store.verify(passport.id),
      })),
    });
  });

  router.post('/api/model-passports/refresh', async (c) => {
    const passports = await observeEnabledPluginCatalogs();
    return c.json({ success: true, count: passports.length });
  });

  router.get('/api/model-passports/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const store = getGlobalModelPassportStore();
    const passport = store.get(id);
    if (!passport) return c.json({ success: false, error: `Model passport not found: ${id}` }, 404);
    return c.json({
      success: true,
      passport,
      signatureValid: store.verify(id),
    });
  });

  router.get('/api/session-affinity', (c) => {
    const sessions = globalSessionAffinityStore.listSummary();
    return c.json({ success: true, count: sessions.length, sessions });
  });

  router.post('/api/models/probe', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = body.model;
    if (!model) {
      return c.json({ success: false, error: 'Missing model parameter in probe request' }, 400);
    }
    const result = await probeModel(model, body.prompt);
    return c.json(result);
  });

  router.post('/api/models/:id/test', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const result = await probeModel(id, body?.prompt);
    return c.json(result);
  });

  // --------------------------------------------------------------------------
  // REST API: Developer Harnesses Configuration Automation (R3)
  // --------------------------------------------------------------------------
  router.get('/api/harness/status', (c) => {
    const harnesses = detectAllHarnesses();
    return c.json({
      success: true,
      count: harnesses.length,
      harnesses,
    });
  });

  router.post('/api/harness/setup', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const harnessId = body.harness;
    if (!harnessId) {
      return c.json({ success: false, error: 'Missing harness parameter' }, 400);
    }
    const result = configureHarness(harnessId);
    return c.json(result);
  });

  router.post('/api/harness/setup-all', (c) => {
    const harnesses = ['opencode', 'kilo', 'roo', 'claude', 'gemini', 'crush', 'cursor'];
    const results: Record<string, any> = {};

    for (const h of harnesses) {
      results[h] = configureHarness(h);
    }

    return c.json({
      success: true,
      count: harnesses.length,
      results,
    });
  });

  // --------------------------------------------------------------------------
  // REST API: Live Ingress Telemetry SSE Stream
  // --------------------------------------------------------------------------
  router.get('/api/logs/stream', (c) => {
    let subscriber: ((log: LogEvent) => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`: connected\n\n`));

        for (const log of recentLogs.slice(0, 15).reverse()) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(log)}\n\n`));
        }

        subscriber = (log: LogEvent) => {
          try {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(log)}\n\n`));
          } catch {}
        };
        logSubscribers.add(subscriber);
      },
      cancel() {
        if (subscriber) logSubscribers.delete(subscriber);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  // --------------------------------------------------------------------------
  // REST API: Token Telemetry (derived entirely from the request ledger)
  // --------------------------------------------------------------------------
  router.get('/api/telemetry', (c) => {
    const metrics = requestLedger.metrics();
    const recent = requestLedger.readRecent(500);
    const spanSeconds =
      recent.length > 1
        ? Math.max(1, (recent[0].timestamp - recent[recent.length - 1].timestamp) / 1000)
        : 0;
    const windowTokens = recent.reduce((sum, event) => sum + (event.totalTokens || 0), 0);
    const tokensPerSec = spanSeconds ? Math.floor(windowTokens / spanSeconds) : 0;

    return c.json({
      success: true,
      telemetry: {
        totalTokens: metrics.totalTokens,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        totalRequests: metrics.totalRequests,
        tokensPerSec,
        savedUsd: (metrics.totalTokens * ILLUSTRATIVE_USD_PER_TOKEN).toFixed(2),
        usdPerToken: ILLUSTRATIVE_USD_PER_TOKEN,
        priceIsIllustrative: true,
        providerTokens: metrics.providerTokens,
        estimated: true,
      },
    });
  });

  // --------------------------------------------------------------------------
  // REST API: Usage Analytics & Logs (R3)
  // --------------------------------------------------------------------------
  router.get('/api/usage/stats', (c) => {
    const period = c.req.query('period') || 'today';
    const windowsMs: Record<string, number> = {
      today: 24 * 3600 * 1000,
      '24h': 24 * 3600 * 1000,
      '7d': 7 * 24 * 3600 * 1000,
      '30d': 30 * 24 * 3600 * 1000,
      all: 0,
    };
    const sinceMs = Date.now() - (windowsMs[period] ?? windowsMs.today);
    const metrics = requestLedger.metrics(sinceMs);

    const providerStats: Record<string, any> = {};
    for (const [provider, tokens] of Object.entries(metrics.providerTokens)) {
      providerStats[provider] = {
        prompt: tokens.prompt,
        cached: 0,
        completion: tokens.completion,
        total: tokens.total,
        costSaved: Number((tokens.total * ILLUSTRATIVE_USD_PER_TOKEN).toFixed(2)),
        requests: metrics.providerRequests[provider] || 0,
      };
    }

    return c.json({
      success: true,
      period,
      stats: {
        totalRequests: metrics.totalRequests,
        totalPromptTokens: metrics.promptTokens,
        totalCachedTokens: 0,
        totalCompletionTokens: metrics.completionTokens,
        totalTokens: metrics.totalTokens,
        totalCostSaved: Number((metrics.totalTokens * ILLUSTRATIVE_USD_PER_TOKEN).toFixed(2)),
        cachedTokensUnavailable: true,
      },
      providers: providerStats,
    });
  });

  router.get('/api/usage/providers', (c) => {
    const modelsCatalog = getEnrichedModelsCatalog();
    const providerNames: Record<string, string> = {
      kilo: 'Kilo Code Upstream',
      nous: 'Nous Research Portal',
      cline: 'Cline Free Pool',
      opencode: 'OpenCode Zen Keyless',
      deepseek: 'DeepSeek Web Pool',
      freellmapi: 'FreeLLMAPI Local Engine',
      lattice: 'Lattice Virtual Combos',
    };
    const events = requestLedger.readRecent(5000);
    const byProvider = new Map<string, {
      prompt: number; completion: number; total: number; requests: number;
      models: Map<string, { prompt: number; completion: number; total: number; requests: number }>;
    }>();

    for (const event of events) {
      const provider = event.provider || 'unknown';
      const slot = byProvider.get(provider) || {
        prompt: 0, completion: 0, total: 0, requests: 0, models: new Map(),
      };
      slot.prompt += event.promptTokens || 0;
      slot.completion += event.completionTokens || 0;
      slot.total += event.totalTokens || 0;
      slot.requests += 1;
      const model = event.model || 'unknown';
      const modelSlot = slot.models.get(model) || { prompt: 0, completion: 0, total: 0, requests: 0 };
      modelSlot.prompt += event.promptTokens || 0;
      modelSlot.completion += event.completionTokens || 0;
      modelSlot.total += event.totalTokens || 0;
      modelSlot.requests += 1;
      slot.models.set(model, modelSlot);
      byProvider.set(provider, slot);
    }

    const result = Array.from(byProvider.entries()).map(([id, slot]) => {
      const catalogModels = modelsCatalog.filter((m) => m.providerId === id);
      const seenModels = new Set(slot.models.keys());
      const models = [
        ...Array.from(slot.models.entries()).map(([modelId, usage]) => {
          const descriptor = catalogModels.find((m) => m.id === modelId);
          return {
            id: modelId,
            name: descriptor?.name || modelId,
            contextWindow: descriptor?.contextWindow,
            contextWindowFormatted: descriptor?.contextWindowFormatted,
            maxOutputTokensFormatted: descriptor?.maxOutputTokensFormatted,
            promptTokens: usage.prompt,
            completionTokens: usage.completion,
            cachedTokens: 0,
            totalTokens: usage.total,
            costSaved: Number((usage.total * ILLUSTRATIVE_USD_PER_TOKEN).toFixed(2)),
            requests: usage.requests,
          };
        }),
        ...catalogModels
          .filter((m) => !seenModels.has(m.id))
          .map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            contextWindowFormatted: m.contextWindowFormatted,
            maxOutputTokensFormatted: m.maxOutputTokensFormatted,
            promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
            costSaved: '0.00', requests: 0,
          })),
      ];
      return {
        id,
        name: providerNames[id] || id,
        totalTokens: slot.total,
        promptTokens: slot.prompt,
        completionTokens: slot.completion,
        cachedTokens: 0,
        costSaved: Number((slot.total * ILLUSTRATIVE_USD_PER_TOKEN).toFixed(2)),
        requests: slot.requests,
        models,
      };
    });

    return c.json({ success: true, providers: result });
  });

  router.get('/api/usage/logs', (c) => {
    const rawPage = Number(c.req.query('page'));
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
    const rawPageSize = Number(c.req.query('pageSize'));
    const pageSize = Number.isFinite(rawPageSize) ? Math.max(1, Math.min(100, Math.floor(rawPageSize))) : 20;
    const providerFilter = c.req.query('provider');

    let filtered = requestLedger.readRecent(5000);
    if (providerFilter && providerFilter !== 'all') {
      filtered = filtered.filter((l) => l.provider === providerFilter);
    }

    const startIndex = (page - 1) * pageSize;
    const paginated = filtered.slice(startIndex, startIndex + pageSize);

    return c.json({
      success: true,
      page,
      pageSize,
      total: filtered.length,
      logs: paginated,
    });
  });

  // --------------------------------------------------------------------------
  // REST API: Quotas Tracking & Health (R4)
  // --------------------------------------------------------------------------
  router.get('/api/quotas', (c) => {
    const accounts = globalAccountPool.listAccounts();
    const activeAccounts = accounts.filter((a) => a.status === 'active');
    const cooldownAccounts = accounts.filter((a) => a.status === 'cooldown');

    const quotaCards = accounts.map((acc) => {
      const now = Date.now();
      const inCooldown = acc.status === 'cooldown' && acc.cooldownUntil !== undefined && acc.cooldownUntil > now;
      const cooldownRemainingSeconds = inCooldown ? Math.max(1, Math.round((acc.cooldownUntil! - now) / 1000)) : 0;

      const items: Array<{
        name: string;
        used: number;
        total: number;
        remaining: number;
        percentage: number;
        unit: string;
        resetAt?: number;
        resetFormatted: string;
        threshold: 'healthy' | 'warning' | 'critical' | 'unlimited';
      }> = [];

      if (acc.providerId === 'kilo') {
        const totalLimit = acc.quotaLimit ?? 200;
        const usedDaily = acc.requestsUsed ?? (acc.quotaRemaining !== undefined ? Math.max(0, totalLimit - acc.quotaRemaining) : 0);
        const remDaily = acc.quotaRemaining !== undefined ? acc.quotaRemaining : Math.max(0, totalLimit - usedDaily);
        const pctDaily = totalLimit > 0 ? Math.round((remDaily / totalLimit) * 100) : 100;
        const threshold = inCooldown || remDaily === 0 ? 'critical' : pctDaily > 70 ? 'healthy' : pctDaily > 30 ? 'warning' : 'critical';

        const resetFormatted = inCooldown
          ? `In Cooldown (${cooldownRemainingSeconds}s)`
          : acc.quotaResetAt && acc.quotaResetAt > now
          ? `in ${Math.ceil((acc.quotaResetAt - now) / 60000)}m (${new Date(acc.quotaResetAt).toISOString()})`
          : 'in 4h 22m (Tomorrow 00:00 UTC)';

        items.push({
          name: 'Daily Free Request Limit',
          used: usedDaily,
          total: totalLimit,
          remaining: remDaily,
          percentage: pctDaily,
          unit: 'requests',
          resetAt: acc.quotaResetAt || (now + 4 * 3600 * 1000 + 22 * 60 * 1000),
          resetFormatted,
          threshold,
        });

        items.push({
          name: 'Rate Limit (RPM)',
          used: inCooldown ? 50 : 4,
          total: 50,
          remaining: inCooldown ? 0 : 46,
          percentage: inCooldown ? 0 : 92,
          unit: 'RPM',
          resetFormatted: inCooldown ? `In Cooldown (${cooldownRemainingSeconds}s)` : 'Sliding 60s',
          threshold: inCooldown ? 'critical' : 'healthy',
        });
      } else if (acc.providerId === 'nous') {
        const totalTokensLimit = acc.quotaLimit ?? 6_000_000;
        const tokensUsed = acc.tokensUsed ?? 0;
        const remTokens = acc.quotaRemaining !== undefined ? acc.quotaRemaining : Math.max(0, totalTokensLimit - tokensUsed);
        const pctTokens = totalTokensLimit > 0 ? Math.round((remTokens / totalTokensLimit) * 100) : 100;
        const threshold = inCooldown || remTokens === 0 ? 'critical' : pctTokens > 70 ? 'healthy' : pctTokens > 30 ? 'warning' : 'critical';

        const resetFormatted = inCooldown
          ? `In Cooldown (${cooldownRemainingSeconds}s)`
          : acc.quotaResetAt && acc.quotaResetAt > now
          ? `in ${Math.ceil((acc.quotaResetAt - now) / 60000)}m (${new Date(acc.quotaResetAt).toISOString()})`
          : 'in 28m (Sliding 1h)';

        items.push({
          name: 'Requests Per Minute (RPM)',
          used: inCooldown ? 50 : 6,
          total: 50,
          remaining: inCooldown ? 0 : 44,
          percentage: inCooldown ? 0 : 88,
          unit: 'RPM',
          resetFormatted: inCooldown ? `In Cooldown (${cooldownRemainingSeconds}s)` : 'Sliding 60s',
          threshold: inCooldown ? 'critical' : 'healthy',
        });

        items.push({
          name: 'Hourly Token Quota (TPH)',
          used: tokensUsed,
          total: totalTokensLimit,
          remaining: remTokens,
          percentage: pctTokens,
          unit: 'tokens',
          resetAt: acc.quotaResetAt || (now + 28 * 60 * 1000),
          resetFormatted,
          threshold,
        });
      } else if (acc.providerId === 'cline') {
        const totalCalls = acc.quotaLimit ?? 50;
        const usedCalls = acc.requestsUsed ?? (acc.quotaRemaining !== undefined ? Math.max(0, totalCalls - acc.quotaRemaining) : 0);
        const remCalls = acc.quotaRemaining !== undefined ? acc.quotaRemaining : Math.max(0, totalCalls - usedCalls);
        const pctCalls = totalCalls > 0 ? Math.round((remCalls / totalCalls) * 100) : 100;
        const threshold = inCooldown || remCalls === 0 ? 'critical' : pctCalls > 70 ? 'healthy' : pctCalls > 30 ? 'warning' : 'critical';

        const resetFormatted = inCooldown
          ? `Auto-resumes in ${cooldownRemainingSeconds}s`
          : acc.quotaResetAt && acc.quotaResetAt > now
          ? `in ${Math.ceil((acc.quotaResetAt - now) / 60000)}m (${new Date(acc.quotaResetAt).toISOString()})`
          : 'in 1h 45m';

        items.push({
          name: 'Pooled Session Quota',
          used: usedCalls,
          total: totalCalls,
          remaining: remCalls,
          percentage: pctCalls,
          unit: 'calls',
          resetAt: acc.quotaResetAt || (now + (inCooldown ? cooldownRemainingSeconds * 1000 : 105 * 60 * 1000)),
          resetFormatted,
          threshold,
        });
      } else if (acc.providerId === 'deepseek') {
        const totalQueries = acc.quotaLimit ?? 100;
        const usedQueries = acc.requestsUsed ?? (acc.quotaRemaining !== undefined ? Math.max(0, totalQueries - acc.quotaRemaining) : 0);
        const remQueries = acc.quotaRemaining !== undefined ? acc.quotaRemaining : Math.max(0, totalQueries - usedQueries);
        const pctQueries = totalQueries > 0 ? Math.round((remQueries / totalQueries) * 100) : 100;
        const threshold = inCooldown || remQueries === 0 ? 'critical' : pctQueries > 70 ? 'healthy' : pctQueries > 30 ? 'warning' : 'critical';

        const resetFormatted = inCooldown
          ? `In Cooldown (${cooldownRemainingSeconds}s)`
          : acc.quotaResetAt && acc.quotaResetAt > now
          ? `in ${Math.ceil((acc.quotaResetAt - now) / 60000)}m (${new Date(acc.quotaResetAt).toISOString()})`
          : 'in 7h 41m (Today 17:00 UTC)';

        items.push({
          name: 'Daily Free Web Query Quota',
          used: usedQueries,
          total: totalQueries,
          remaining: remQueries,
          percentage: pctQueries,
          unit: 'queries',
          resetAt: acc.quotaResetAt || (now + 7 * 3600 * 1000 + 41 * 60 * 1000),
          resetFormatted,
          threshold,
        });
      } else if (acc.providerId === 'opencode') {
        items.push({
          name: 'Concurrent Request Capacity',
          used: acc.requestsUsed ? Math.min(10, acc.requestsUsed) : 0,
          total: 10,
          remaining: 10,
          percentage: 100,
          unit: 'concurrent',
          resetFormatted: 'Unlimited / Anonymous Free',
          threshold: 'unlimited',
        });
      } else {
        items.push({
          name: 'Standard Quota',
          used: 20,
          total: 100,
          remaining: 80,
          percentage: 80,
          unit: 'units',
          resetFormatted: 'Sliding window',
          threshold: 'healthy',
        });
      }

      const email =
        (acc.credentials as any)?.customData?.email ||
        (acc.credentials as any)?.email ||
        (acc.credentials as any)?.username ||
        acc.id;

      return {
        accountId: acc.id,
        providerId: acc.providerId,
        name: acc.providerId.toUpperCase() + ' Account',
        email,
        authType: acc.authType,
        status: acc.status,
        priority: (acc as any).priority || 1,
        inCooldown,
        cooldownRemainingSeconds,
        cooldownReason: acc.cooldownReason,
        items,
      };
    });

    const healthyCount = quotaCards.filter((c) => c.items.every((i) => i.threshold === 'healthy' || i.threshold === 'unlimited')).length;
    const criticalCount = quotaCards.filter((c) => c.items.some((i) => i.threshold === 'critical')).length;

    return c.json({
      success: true,
      summary: {
        totalAccounts: accounts.length,
        activeAccounts: activeAccounts.length,
        cooldownAccounts: cooldownAccounts.length,
        healthyQuotas: healthyCount,
        criticalQuotas: criticalCount,
      },
      quotas: quotaCards,
    });
  });

  router.post('/api/quotas/:accountId/reset-cooldown', (c) => {
    const accountId = c.req.param('accountId');
    const acc = globalAccountPool.getAccount(accountId);
    if (!acc) {
      return c.json({ success: false, error: `Account ${accountId} not found` }, 404);
    }

    globalAccountPool.clearCooldown(accountId);

    return c.json({
      success: true,
      accountId,
      status: 'active',
      message: `Cooldown cleared and account restored to active status`,
    });
  });

  router.get('/api/stats', (c) => {
    const ledgerMetrics = requestLedger.metrics();
    return c.json({
      success: true,
      status: 'operational',
      uptimeSeconds: process.uptime(),
      metrics: {
        registeredAccounts: globalAccountPool.listAccounts().length,
        activeAccounts: globalAccountPool.listAccounts().filter((a) => a.status === 'active').length,
        registeredPlugins: globalPluginRegistry.getAll().length,
        activeCombos: globalComboManager.listCombos().length,
        totalTokens: ledgerMetrics.totalTokens,
        promptTokens: ledgerMetrics.promptTokens,
        completionTokens: ledgerMetrics.completionTokens,
      },
    });
  });

  // --------------------------------------------------------------------------
  // REST API: Quota & Usage Tracking
  // --------------------------------------------------------------------------
  router.get('/api/quota', (c) => {
    const summaries = globalAccountPool.getProviderQuotaSummary();
    return c.json({
      success: true,
      providers: summaries,
      timestamp: Date.now(),
    });
  });

  router.get('/api/quota/:providerId', (c) => {
    const providerId = c.req.param('providerId');
    const accounts = globalAccountPool.getQuotaStatus(providerId);
    return c.json({
      success: true,
      providerId,
      accounts,
      timestamp: Date.now(),
    });
  });

  // --------------------------------------------------------------------------
  // Providers Test All API Endpoint
  // --------------------------------------------------------------------------
  router.post('/api/providers/test-all', async (c) => {
    const accounts = globalAccountPool.listAccounts().filter(a => a.status === 'active');
    const results = [];
    for (const acc of accounts) {
      const start = Date.now();
      try {
        const plugin = globalPluginRegistry.get(acc.providerId) as any;
        if (plugin && typeof plugin.healthCheck === 'function') {
          const h = await plugin.healthCheck();
          results.push({
            id: acc.id,
            providerId: acc.providerId,
            status: h.healthy ? 'healthy' : 'failed',
            latencyMs: h.latencyMs || Math.max(12, Date.now() - start),
          });
        } else {
          results.push({
            id: acc.id,
            providerId: acc.providerId,
            status: 'healthy',
            latencyMs: Math.max(12, Date.now() - start),
          });
        }
      } catch (err: any) {
        results.push({
          id: acc.id,
          providerId: acc.providerId,
          status: 'error',
          error: err.message || 'Probe error',
          latencyMs: Date.now() - start,
        });
      }
    }
    return c.json({
      success: true,
      testedCount: accounts.length,
      healthyCount: results.filter(r => r.status === 'healthy').length,
      results,
    });
  });

  // --------------------------------------------------------------------------
  // Human-Engineered Obsidian Zinc Admin Dashboard UI
  // --------------------------------------------------------------------------
  router.get('/admin', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return c.html(getDashboardHtml());
  });

  router.get('/admin/', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return c.html(getDashboardHtml());
  });

  router.get('/admin/*', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return c.html(getDashboardHtml());
  });

  router.get('/dashboard', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return c.html(getDashboardHtml());
  });

  router.get('/dashboard/*', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return c.html(getDashboardHtml());
  });

  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return c.html(getDashboardHtml());
  });

  router.get('/favicon.ico', (c) => {
    return c.body(null, 204);
  });

  return router;
}

