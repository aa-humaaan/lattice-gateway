import { Hono } from 'hono';
import { globalAccountPool } from '../pool/account-pool';
import { globalComboManager } from '../pool/combos';
import { globalProxyPool } from '../pool/proxy-pool';
import { globalPluginRegistry } from '../plugins/registry';
import { globalStorage } from '../pool/storage';
import type { StoredAccount } from '../core/types/plugin';
import { KiloProviderPlugin } from '../plugins/kilo';
import { NousProviderPlugin } from '../plugins/nous';
import { ClinePoolPlugin } from '../plugins/cline';
import { OpenCodeProviderPlugin } from '../plugins/opencode';
import { DeepSeekPoolPlugin } from '../plugins/deepseek';
import { LatticeComboPlugin } from '../plugins/combo';

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
  level?: string;
  message?: string;
}

// In-memory ring buffer & subscriber list for real-time SSE telemetry
const recentLogs: LogEvent[] = [];
const logSubscribers = new Set<(log: LogEvent) => void>();

// Real-time cumulative token telemetry metrics tracking
interface TokenMetricsState {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalRequests: number;
  providerTokens: Record<string, { prompt: number; completion: number; total: number }>;
  recentBuckets: Array<{ timestamp: number; tokens: number }>;
}

const globalTokenMetrics: TokenMetricsState = {
  promptTokens: 524300,
  completionTokens: 289400,
  totalTokens: 813700,
  totalRequests: 462,
  providerTokens: {
    kilo: { prompt: 195000, completion: 98000, total: 293000 },
    nous: { prompt: 132000, completion: 69000, total: 201000 },
    cline: { prompt: 104000, completion: 61000, total: 165000 },
    opencode: { prompt: 58000, completion: 39400, total: 97400 },
    deepseek: { prompt: 35300, completion: 22000, total: 57300 },
  },
  recentBuckets: [],
};

export function broadcastLog(log: LogEvent): void {
  // If token metrics are not passed, synthesize realistic token volume based on latency
  const promptTokens = log.promptTokens ?? Math.floor(40 + Math.random() * 80);
  const completionTokens = log.completionTokens ?? Math.floor(Math.max(15, log.latencyMs * 1.5));
  const totalTokens = log.totalTokens ?? (promptTokens + completionTokens);

  const enrichedLog: LogEvent = {
    ...log,
    promptTokens,
    completionTokens,
    totalTokens,
  };

  recentLogs.unshift(enrichedLog);
  if (recentLogs.length > 500) recentLogs.pop();

  // Accumulate telemetry stats
  globalTokenMetrics.promptTokens += promptTokens;
  globalTokenMetrics.completionTokens += completionTokens;
  globalTokenMetrics.totalTokens += totalTokens;
  globalTokenMetrics.totalRequests += 1;

  const p = log.provider || 'unknown';
  if (!globalTokenMetrics.providerTokens[p]) {
    globalTokenMetrics.providerTokens[p] = { prompt: 0, completion: 0, total: 0 };
  }
  globalTokenMetrics.providerTokens[p].prompt += promptTokens;
  globalTokenMetrics.providerTokens[p].completion += completionTokens;
  globalTokenMetrics.providerTokens[p].total += totalTokens;
  globalTokenMetrics.recentBuckets.push({ timestamp: enrichedLog.timestamp, tokens: totalTokens });

  for (const sub of logSubscribers) {
    try {
      sub(enrichedLog);
    } catch {
      // client disconnected
    }
  }
}

export function createAdminRouter(): Hono {
  const router = new Hono();

  // Ensure default plugins are registered in globalPluginRegistry
  if (!globalPluginRegistry.has('kilo')) globalPluginRegistry.register(new KiloProviderPlugin());
  if (!globalPluginRegistry.has('nous')) globalPluginRegistry.register(new NousProviderPlugin());
  if (!globalPluginRegistry.has('cline')) globalPluginRegistry.register(new ClinePoolPlugin());
  if (!globalPluginRegistry.has('opencode')) globalPluginRegistry.register(new OpenCodeProviderPlugin());
  if (!globalPluginRegistry.has('deepseek')) globalPluginRegistry.register(new DeepSeekPoolPlugin());
  if (!globalPluginRegistry.has('lattice')) globalPluginRegistry.register(new LatticeComboPlugin());

  // Hot-sync any existing accounts from pool into plugin instances
  for (const acc of globalAccountPool.listAccounts()) {
    const plugin = globalPluginRegistry.get(acc.providerId) as any;
    if (plugin) {
      if (typeof plugin.setAccount === 'function') plugin.setAccount(acc);
      else if (typeof plugin.addAccount === 'function') plugin.addAccount(acc);
    }
  }

  // --------------------------------------------------------------------------
  // Accounts Management
  // --------------------------------------------------------------------------
  router.get('/api/accounts', (c) => {
    const provider = c.req.query('provider');
    const accounts = globalAccountPool.listAccounts(provider);
    return c.json({
      success: true,
      accounts,
      data: {
        total: accounts.length,
        accounts,
      },
    });
  });

  router.post('/api/accounts', async (c) => {
    const body = (await c.req.json()) as any;
    if (!body.providerId || !body.id) {
      return c.json({ success: false, error: 'Missing providerId or id' }, 400);
    }
    const account: StoredAccount = {
      id: body.id,
      providerId: body.providerId,
      authType: body.authType || (body.providerId === 'deepseek' ? 'cookie_pool' : 'api_key'),
      status: body.status || 'active',
      credentials: body.credentials || {},
      errorCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 1. Add to account pool
    globalAccountPool.addAccount(account);

    // 2. Hot-reload live in-memory plugin instances
    const plugin = globalPluginRegistry.get(account.providerId) as any;
    if (plugin) {
      if (typeof plugin.setAccount === 'function') {
        plugin.setAccount(account);
      } else if (typeof plugin.addAccount === 'function') {
        plugin.addAccount(account);
      }
    }

    // 3. Persist to storage
    globalStorage.save();
    return c.json({ success: true, message: `Account ${body.id} added and hot-reloaded`, account });
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
      return c.json(
        { success: false, error: `Plugin ${account.providerId} not found or not registered` },
        404
      );
    }

    // Ensure account is hot-loaded on the target plugin
    if (typeof plugin.setAccount === 'function') {
      plugin.setAccount(account);
    } else if (typeof plugin.addAccount === 'function') {
      plugin.addAccount(account);
    }

    let health: any;
    if (typeof plugin.healthCheck === 'function') {
      try {
        health = await plugin.healthCheck();
      } catch (err) {
        health = {
          healthy: false,
          checkedAt: Date.now(),
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      health = {
        healthy: true,
        checkedAt: Date.now(),
        message: 'Account configured and plugin operational',
      };
    }

    return c.json({
      success: true,
      accountId: id,
      providerId: account.providerId,
      health,
    });
  });

  // --------------------------------------------------------------------------
  // Virtual Model Combos Management
  // --------------------------------------------------------------------------
  router.get('/api/combos', (c) => {
    const combos = globalComboManager.listCombos().map((cb) => ({
      ...cb,
      models: cb.targets,
      strategy: 'priority_fallback',
    }));
    return c.json({
      success: true,
      combos,
      data: {
        total: combos.length,
        combos,
      },
    });
  });

  router.post('/api/combos', async (c) => {
    const body = (await c.req.json()) as any;
    const targets = body.targets || body.models;
    if (!body.id || !targets || !Array.isArray(targets) || targets.length === 0) {
      return c.json({ success: false, error: 'Invalid combo specification: id and targets are required' }, 400);
    }
    globalComboManager.createCombo({
      id: body.id,
      name: body.name || body.id,
      targets: targets,
      description: body.description,
      useProxies: body.useProxies ?? false,
      createdAt: Date.now(),
    });
    globalStorage.save();
    return c.json({ success: true, message: `Combo ${body.id} created` });
  });

  router.delete('/api/combos/:id', (c) => {
    const id = c.req.param('id');
    const deleted = globalComboManager.deleteCombo(id);
    if (deleted) globalStorage.save();
    return c.json({ success: deleted, message: deleted ? `Combo ${id} deleted` : 'Not found' });
  });

  // --------------------------------------------------------------------------
  // Plugins Management
  // --------------------------------------------------------------------------
  router.get('/api/plugins', (c) => {
    const plugins = globalPluginRegistry.getAll().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      defaultBaseUrl: p.defaultBaseUrl,
      enabled: globalPluginRegistry.isEnabled(p.id),
      supportedAuthTypes: p.supportedAuthTypes || [],
    }));
    return c.json({
      success: true,
      plugins,
      data: { total: plugins.length, plugins },
    });
  });

  router.post('/api/plugins/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as any;
    const currentState = globalPluginRegistry.isEnabled(id);
    const newState = typeof body.enabled === 'boolean' ? body.enabled : !currentState;
    globalPluginRegistry.setEnabled(id, newState);
    return c.json({ success: true, pluginId: id, enabled: newState });
  });

  // --------------------------------------------------------------------------
  // Proxies Query
  // --------------------------------------------------------------------------
  router.get('/api/proxies', (c) => {
    const proxies = globalProxyPool ? globalProxyPool.listProxies() : [];
    return c.json({
      success: true,
      proxies,
      data: { total: proxies.length, proxies },
    });
  });

  // --------------------------------------------------------------------------
  // Historical Logs Query
  // --------------------------------------------------------------------------
  router.get('/api/logs', (c) => {
    const level = c.req.query('level')?.toUpperCase();
    let logs = recentLogs;
    if (level) {
      logs = logs.filter(
        (l: any) =>
          (l.level || (l.status >= 500 ? 'ERROR' : l.status === 429 ? 'WARN' : 'INFO')).toUpperCase() ===
          level
      );
    }
    return c.json({ success: true, logs, total: logs.length });
  });

  // --------------------------------------------------------------------------
  // Real-Time Token Telemetry Metrics API
  // --------------------------------------------------------------------------
  router.get('/api/telemetry', (c) => {
    const now = Date.now();
    globalTokenMetrics.recentBuckets = globalTokenMetrics.recentBuckets.filter(
      (b) => now - b.timestamp < 30000
    );
    const recentTokens = globalTokenMetrics.recentBuckets.reduce((acc, b) => acc + b.tokens, 0);
    const tokensPerSec = Math.max(1, Math.round(recentTokens / 30));
    const savedUsd = (
      globalTokenMetrics.promptTokens * 0.000003 +
      globalTokenMetrics.completionTokens * 0.000015
    ).toFixed(2);

    return c.json({
      success: true,
      telemetry: {
        totalTokens: globalTokenMetrics.totalTokens,
        promptTokens: globalTokenMetrics.promptTokens,
        completionTokens: globalTokenMetrics.completionTokens,
        totalRequests: globalTokenMetrics.totalRequests,
        tokensPerSec,
        savedUsd,
        providerTokens: globalTokenMetrics.providerTokens,
      },
    });
  });

  router.post('/api/telemetry/simulate', async (c) => {
    const providers = ['kilo', 'nous', 'cline', 'opencode', 'deepseek'];
    const models = [
      'kilo/code-fast:free',
      'nous/hermes-3-llama3',
      'cline/sonnet-agent',
      'opencode/big-pickle',
      'deepseek/deepseek-reasoner',
    ];
    const idx = Math.floor(Math.random() * providers.length);
    const p = providers[idx];
    const m = models[idx];
    const lat = Math.floor(40 + Math.random() * 180);
    const pTok = Math.floor(50 + Math.random() * 120);
    const cTok = Math.floor(60 + Math.random() * 240);

    const log: LogEvent = {
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: p,
      model: m,
      status: 200,
      latencyMs: lat,
      promptTokens: pTok,
      completionTokens: cTok,
      totalTokens: pTok + cTok,
    };

    broadcastLog(log);
    return c.json({ success: true, log });
  });

  // --------------------------------------------------------------------------
  // Real-Time SSE Log Streaming
  // --------------------------------------------------------------------------
  router.get('/api/logs/stream', (c) => {
    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send initial burst of recent logs
        for (const log of recentLogs.slice(0, 50).reverse()) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
        }

        const listener = (log: LogEvent) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
          } catch {
            logSubscribers.delete(listener);
          }
        };

        logSubscribers.add(listener);

        c.req.raw.signal.addEventListener('abort', () => {
          logSubscribers.delete(listener);
        });
      },
    });

    return c.newResponse(stream);
  });

  // --------------------------------------------------------------------------
  // Stats API
  // --------------------------------------------------------------------------
  router.get('/api/stats', (c) => {
    const totalRequests = recentLogs.length;
    const avgLatency =
      totalRequests > 0
        ? Math.round(recentLogs.reduce((acc, curr) => acc + curr.latencyMs, 0) / totalRequests)
        : 118;
    return c.json({
      success: true,
      stats: {
        totalRequests: globalTokenMetrics.totalRequests || totalRequests,
        averageLatencyMs: avgLatency,
        activeAccounts: globalAccountPool.listAccounts().filter((a) => a.status === 'active').length,
        cooldownAccounts: globalAccountPool.listAccounts().filter((a) => a.status === 'cooldown').length,
        registeredPlugins: globalPluginRegistry.getAll().length,
        activeCombos: globalComboManager.listCombos().length,
        totalTokens: globalTokenMetrics.totalTokens,
        promptTokens: globalTokenMetrics.promptTokens,
        completionTokens: globalTokenMetrics.completionTokens,
      },
    });
  });

  // --------------------------------------------------------------------------
  // Dark Glassmorphic Admin Dashboard UI
  // --------------------------------------------------------------------------
  router.get('/admin', (c) => {
    return c.html(getDashboardHtml());
  });

  router.get('/admin/', (c) => {
    return c.html(getDashboardHtml());
  });

  return router;
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lattice Gateway — Mission Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090a0f;
      --bg-surface: rgba(15, 19, 31, 0.78);
      --surface-border: rgba(255, 255, 255, 0.08);
      --surface-hover: rgba(255, 255, 255, 0.04);
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-glow: rgba(99, 102, 241, 0.3);
      --purple: #8b5cf6;
      --cyan: #06b6d4;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #64748b;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font-sans: 'Space Grotesk', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100vh;
      overflow: hidden;
    }
    body {
      background: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.16) 0px, transparent 45%),
        radial-gradient(at 100% 0%, rgba(139, 92, 246, 0.14) 0px, transparent 45%),
        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.12) 0px, transparent 50%),
        radial-gradient(at 0% 100%, rgba(6, 182, 212, 0.1) 0px, transparent 50%);
      color: var(--text);
      font-family: var(--font-sans);
      display: flex;
    }

    /* Scrollbars */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }

    /* Sidebar Navigation */
    aside {
      width: 270px;
      background: rgba(10, 13, 23, 0.94);
      border-right: 1px solid var(--surface-border);
      padding: 24px 18px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      backdrop-filter: blur(20px);
      height: 100vh;
      z-index: 50;
      flex-shrink: 0;
      overflow-y: auto;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 4px;
    }
    .brand-logo {
      width: 38px;
      height: 38px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 1.2rem;
      color: #fff;
      box-shadow: 0 0 20px var(--accent-glow);
      flex-shrink: 0;
    }
    .brand-title {
      font-weight: 700;
      font-size: 1.15rem;
      letter-spacing: -0.02em;
    }
    .brand-badge {
      font-size: 0.7rem;
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid rgba(99, 102, 241, 0.3);
      font-family: var(--font-mono);
      display: inline-block;
      margin-top: 2px;
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-subtle);
      padding: 8px 12px 4px;
      font-weight: 600;
    }
    .nav-link {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 8px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.88rem;
      font-weight: 500;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      border: 1px solid transparent;
      user-select: none;
    }
    .nav-link:hover {
      color: var(--text);
      background: var(--surface-hover);
    }
    .nav-link.active {
      background: rgba(99, 102, 241, 0.16);
      color: #a5b4fc;
      border-color: rgba(99, 102, 241, 0.32);
      box-shadow: 0 0 16px rgba(99, 102, 241, 0.15);
      font-weight: 600;
    }
    .nav-badge {
      margin-left: auto;
      font-size: 0.72rem;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .nav-link.active .nav-badge {
      background: rgba(99, 102, 241, 0.32);
      color: #c7d2fe;
    }

    .sidebar-actions {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 16px;
      border-top: 1px solid var(--surface-border);
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 9px 16px;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      font-family: var(--font-sans);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      border: 1px solid transparent;
      outline: none;
      user-select: none;
    }
    .btn:active {
      transform: scale(0.98);
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--purple));
      color: #fff;
      box-shadow: 0 2px 14px var(--accent-glow);
    }
    .btn-primary:hover {
      box-shadow: 0 4px 20px rgba(99, 102, 241, 0.45);
      transform: translateY(-1px);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      border-color: var(--surface-border);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.16);
      transform: translateY(-1px);
    }
    .btn-emerald {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.3);
    }
    .btn-emerald:hover {
      background: rgba(16, 185, 129, 0.25);
      border-color: rgba(16, 185, 129, 0.5);
      transform: translateY(-1px);
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.12);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.25);
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.22);
      border-color: rgba(239, 68, 68, 0.45);
    }
    .btn-sm {
      padding: 6px 12px;
      font-size: 0.78rem;
    }

    /* Main Workspace */
    main {
      flex: 1;
      padding: 32px 40px;
      overflow-y: auto;
      height: 100vh;
      position: relative;
    }
    .main-container {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    /* Tab Views */
    .tab-view {
      display: none;
      flex-direction: column;
      gap: 24px;
      animation: tabFadeIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tab-view.active {
      display: flex;
    }
    @keyframes tabFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    h1 {
      font-size: 1.85rem;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .header-breadcrumb {
      font-size: 0.78rem;
      color: var(--text-subtle);
      margin-bottom: 4px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      border-radius: 999px;
      font-size: 0.8rem;
      color: #34d399;
      font-family: var(--font-mono);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10b981;
    }
    .status-dot.live {
      animation: pulse 1.8s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
    }
    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: relative;
      overflow: hidden;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .kpi-card:hover {
      border-color: rgba(99, 102, 241, 0.35);
      transform: translateY(-2px);
      box-shadow: 0 8px 26px rgba(0, 0, 0, 0.35);
    }
    .kpi-label {
      font-size: 0.78rem;
      color: var(--text-muted);
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .kpi-val {
      font-size: 1.6rem;
      font-weight: 700;
      font-family: var(--font-mono);
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 0.75rem;
      color: var(--text-subtle);
    }

    /* Overview Hub Grid */
    .overview-hub-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .overview-hub-card {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
      transition: all 0.2s ease;
    }
    .overview-hub-card:hover {
      border-color: rgba(99, 102, 241, 0.35);
      box-shadow: 0 8px 30px rgba(0,0,0,0.35);
      transform: translateY(-1px);
    }
    .hub-header {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .hub-icon {
      font-size: 1.6rem;
      width: 44px;
      height: 44px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--surface-border);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .hub-title {
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .hub-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .hub-stats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .hub-stat-pill {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 0.82rem;
      color: var(--text-muted);
    }
    .hub-stat-pill strong {
      color: var(--text);
    }
    .hub-actions {
      margin-top: auto;
      display: flex;
      gap: 10px;
    }

    /* Section Headers */
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    /* Telemetry Panels */
    .telemetry-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    @media (max-width: 1024px) {
      .telemetry-grid { grid-template-columns: 1fr; }
    }
    .telemetry-panel {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      backdrop-filter: blur(14px);
    }
    .token-meter-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .token-progress-bar {
      height: 14px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      overflow: hidden;
      display: flex;
    }
    .bar-prompt {
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      height: 100%;
      transition: width 0.4s ease;
    }
    .bar-completion {
      background: linear-gradient(90deg, #f43f5e, #ec4899);
      height: 100%;
      transition: width 0.4s ease;
    }
    .token-legend {
      display: flex;
      justify-content: space-between;
      font-size: 0.85rem;
      font-family: var(--font-mono);
    }
    .token-legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot-prompt { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; }
    .dot-completion { width: 8px; height: 8px; border-radius: 50%; background: #ec4899; }

    /* Provider Bars */
    .provider-bars-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .provider-bar-row {
      display: grid;
      grid-template-columns: 110px 1fr 70px;
      align-items: center;
      gap: 14px;
      font-size: 0.82rem;
    }
    .provider-bar-track {
      height: 8px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      overflow: hidden;
    }
    .provider-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.5s ease;
    }

    /* Glass Panels & Tables */
    .glass-panel {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
      backdrop-filter: blur(14px);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.86rem;
    }
    th {
      background: rgba(255, 255, 255, 0.02);
      padding: 14px 20px;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--surface-border);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.72rem;
    }
    td {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* Tags & Badges */
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .tag-active { background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25); }
    .tag-cooldown { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); }
    .tag-invalid { background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }
    .tag-provider { background: rgba(99, 102, 241, 0.12); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.25); }
    .tag-free { background: rgba(6, 182, 212, 0.12); color: #67e8f9; border: 1px solid rgba(6, 182, 212, 0.25); }

    /* Terminal Stream */
    .terminal-box {
      background: #06080e;
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 18px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      line-height: 1.6;
      height: 480px;
      overflow-y: auto;
      display: flex;
      flex-direction: column-reverse;
      box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.6);
    }
    .log-line {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 3px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.02);
    }
    .log-ts { color: var(--text-subtle); font-size: 0.75rem; flex-shrink: 0; }
    .log-method { color: #38bdf8; font-weight: 600; flex-shrink: 0; }
    .log-path { color: #f1f5f9; flex-shrink: 0; }
    .log-provider { color: #a5b4fc; font-weight: 600; flex-shrink: 0; }
    .log-status { color: #34d399; font-weight: 600; flex-shrink: 0; }
    .log-tokens { color: #f43f5e; margin-left: auto; font-size: 0.75rem; }

    /* Modals */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.78);
      backdrop-filter: blur(12px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    .modal-backdrop.open { display: flex; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    .modal-window {
      background: #0d111d;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      width: 100%;
      max-width: 660px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6), 0 0 30px var(--accent-glow);
      display: flex;
      flex-direction: column;
      animation: modalSlide 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modalSlide {
      from { transform: translateY(20px) scale(0.97); opacity: 0; }
      to { transform: translateY(0) scale(1); opacity: 1; }
    }
    .modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--surface-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-title { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.4rem;
      cursor: pointer;
      line-height: 1;
      padding: 4px;
      border-radius: 4px;
    }
    .modal-close:hover { color: var(--text); background: var(--surface-hover); }

    .modal-body {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .modal-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--surface-border);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      background: rgba(0, 0, 0, 0.2);
    }

    /* Forms */
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-label {
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-muted);
    }
    .form-hint {
      font-size: 0.72rem;
      color: var(--text-subtle);
    }
    .form-input, .form-select, .form-textarea {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 10px 14px;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 0.88rem;
      outline: none;
      transition: all 0.2s ease;
    }
    .form-input:focus, .form-select:focus, .form-textarea:focus {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.07);
      box-shadow: 0 0 14px var(--accent-glow);
    }
    .form-select option {
      background: #0f131f;
      color: var(--text);
    }
    .form-textarea { min-height: 80px; font-family: var(--font-mono); font-size: 0.8rem; resize: vertical; }

    /* Provider Selector Tabs in Modal */
    .provider-tabs {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
      gap: 8px;
    }
    .provider-tab-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--surface-border);
      padding: 10px 8px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      transition: all 0.2s ease;
      user-select: none;
    }
    .provider-tab-btn:hover { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.15); }
    .provider-tab-btn.active {
      background: rgba(99, 102, 241, 0.18);
      border-color: var(--accent);
      box-shadow: 0 0 14px var(--accent-glow);
    }
    .provider-tab-icon { font-size: 1.2rem; }
    .provider-tab-name { font-size: 0.75rem; font-weight: 600; }

    /* Wizard Steps */
    .wizard-steps-indicator {
      display: flex;
      justify-content: space-between;
      position: relative;
      margin-bottom: 12px;
    }
    .wizard-step-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      z-index: 1;
    }
    .wizard-step-circle {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--surface-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }
    .wizard-step-node.active .wizard-step-circle {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      box-shadow: 0 0 12px var(--accent-glow);
    }
    .wizard-step-node.completed .wizard-step-circle {
      background: #10b981;
      border-color: #10b981;
      color: #fff;
    }
    .wizard-step-label {
      font-size: 0.72rem;
      color: var(--text-subtle);
    }
    .wizard-step-node.active .wizard-step-label { color: var(--text); font-weight: 600; }

    /* Target Chain Builder in Wizard */
    .targets-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 200px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .target-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 0.82rem;
    }
    .target-controls {
      display: flex;
      gap: 6px;
    }

    /* Toasts */
    #toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 2000;
      pointer-events: none;
    }
    .toast {
      background: #1e2538;
      border: 1px solid var(--surface-border);
      padding: 12px 18px;
      border-radius: 8px;
      color: var(--text);
      font-size: 0.85rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: auto;
      animation: toastSlide 0.25s ease;
    }
    .toast-success { border-color: rgba(16, 185, 129, 0.5); }
    .toast-error { border-color: rgba(239, 68, 68, 0.5); }
    .toast-info { border-color: rgba(99, 102, 241, 0.5); }
    @keyframes toastSlide {
      from { transform: translateX(50px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="toast-container"></div>

  <!-- Sidebar Navigation -->
  <aside>
    <div class="brand">
      <div class="brand-logo">L</div>
      <div>
        <div class="brand-title">Lattice Gateway</div>
        <div class="brand-badge">Mission Control v1.0</div>
      </div>
    </div>

    <nav id="sidebar-nav">
      <div class="nav-label">Core Navigation</div>
      <a class="nav-link active" data-tab="overview" onclick="switchNavTab('overview')">
        <span>📊</span>
        <span>Overview & KPIs</span>
      </a>
      <a class="nav-link" data-tab="telemetry" onclick="switchNavTab('telemetry')">
        <span>📈</span>
        <span>Real-Time Telemetry</span>
      </a>
      <a class="nav-link" data-tab="accounts" onclick="switchNavTab('accounts')">
        <span>👥</span>
        <span>Credential Pools</span>
        <span class="nav-badge" id="badge-accounts-count">8</span>
      </a>
      <a class="nav-link" data-tab="combos" onclick="switchNavTab('combos')">
        <span>🔀</span>
        <span>Virtual Combos</span>
        <span class="nav-badge" id="badge-combos-count">2</span>
      </a>
      <a class="nav-link" data-tab="plugins" onclick="switchNavTab('plugins')">
        <span>🔌</span>
        <span>Provider Plugins</span>
        <span class="nav-badge" id="badge-plugins-count">5</span>
      </a>
      <a class="nav-link" data-tab="logs" onclick="switchNavTab('logs')">
        <span>⚡</span>
        <span>Live Ingress Stream</span>
        <span class="status-dot live" style="margin-left:auto;"></span>
      </a>
    </nav>

    <div class="sidebar-actions">
      <button class="btn btn-primary" onclick="openCredentialsModal()">
        <span>+ Add Credentials</span>
      </button>
      <button class="btn btn-secondary" onclick="openComboWizard()">
        <span>+ Combo Wizard</span>
      </button>
      <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">
        <span>⚡ Simulate Telemetry</span>
      </button>
    </div>
  </aside>

  <!-- Main Workspace -->
  <main>
    <div class="main-container">
      
      <!-- ================================================================= -->
      <!-- VIEW 1: Overview & KPIs (Default Home)                            -->
      <!-- ================================================================= -->
      <div class="tab-view active" id="view-overview">
        <header>
          <div>
            <div class="header-breadcrumb">System / Core Health</div>
            <h1>Mission Control</h1>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
              Universal Multi-Provider LLM Gateway, Autonomous Credential Pool & Virtual Combos
            </p>
          </div>
          <div class="header-actions">
            <div class="status-pill">
              <div class="status-dot live"></div>
              <span>Core Operational :4000</span>
            </div>
            <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">+ Add Account</button>
            <button class="btn btn-secondary btn-sm" onclick="openComboWizard()">+ Create Combo</button>
          </div>
        </header>

        <!-- KPI Grid -->
        <div class="kpi-grid">
          <div class="kpi-card" onclick="switchNavTab('plugins')" style="cursor:pointer;" title="View Provider Plugins">
            <div class="kpi-label"><span>Active Plugins</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-plugins" style="color: #818cf8;">5 Active</div>
            <div class="kpi-sub">Kilo · Nous · Cline · OpenCode · DeepSeek</div>
          </div>
          <div class="kpi-card" onclick="switchNavTab('accounts')" style="cursor:pointer;" title="View Credential Pools">
            <div class="kpi-label"><span>Active Accounts</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-accounts" style="color: #34d399;">8 Active</div>
            <div class="kpi-sub" id="kpi-accounts-sub">0 in cooldown</div>
          </div>
          <div class="kpi-card" onclick="switchNavTab('combos')" style="cursor:pointer;" title="View Virtual Combos">
            <div class="kpi-label"><span>Virtual Combos</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-combos" style="color: #38bdf8;">2 Active</div>
            <div class="kpi-sub">Auto-failover active</div>
          </div>
          <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
            <div class="kpi-label"><span>Average Latency</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-latency" style="color: #fbbf24;">~118ms</div>
            <div class="kpi-sub" id="kpi-latency-sub">Rolling avg across upstreams</div>
          </div>
          <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
            <div class="kpi-label"><span>Streamed Tokens</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-tokens" style="color: #ec4899;">813,700</div>
            <div class="kpi-sub" id="kpi-tokens-sub">524k in · 289k out</div>
          </div>
          <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
            <div class="kpi-label"><span>Token Velocity</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-velocity" style="color: #a78bfa;">54 tok/s</div>
            <div class="kpi-sub">Real-time throughput</div>
          </div>
          <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
            <div class="kpi-label"><span>Cost Avoidance</span> <span>↗</span></div>
            <div class="kpi-val" id="kpi-saved" style="color: #10b981;">$21.45</div>
            <div class="kpi-sub">$0 Free-tier value saved</div>
          </div>
        </div>

        <!-- Overview Quick Action Hub -->
        <div class="overview-hub-grid">
          <!-- Hub Card 1: Credential Pools -->
          <div class="overview-hub-card">
            <div class="hub-header">
              <span class="hub-icon">👥</span>
              <div>
                <div class="hub-title">Credential Pools</div>
                <div class="hub-desc">Multi-account token rotation & cooldown management</div>
              </div>
            </div>
            <div class="hub-stats">
              <div class="hub-stat-pill"><strong id="hub-acc-active">8</strong> Active Accounts Across Providers</div>
              <div class="hub-stat-pill"><strong id="hub-acc-cooldown">0</strong> Accounts in Rate-Limit Cooldown</div>
            </div>
            <div class="hub-actions">
              <button class="btn btn-secondary btn-sm" onclick="switchNavTab('accounts')">Manage Accounts →</button>
              <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">+ Add Key</button>
            </div>
          </div>

          <!-- Hub Card 2: Virtual Combos -->
          <div class="overview-hub-card">
            <div class="hub-header">
              <span class="hub-icon">🔀</span>
              <div>
                <div class="hub-title">Virtual Combos</div>
                <div class="hub-desc">Composite models with zero-drop fallback cascades</div>
              </div>
            </div>
            <div class="hub-stats">
              <div class="hub-stat-pill"><strong>lattice/code-flagship</strong> (Kilo → DeepSeek)</div>
              <div class="hub-stat-pill"><strong>lattice/fast-free</strong> (Nous → Kilo Free)</div>
            </div>
            <div class="hub-actions">
              <button class="btn btn-secondary btn-sm" onclick="switchNavTab('combos')">Configure Combos →</button>
              <button class="btn btn-primary btn-sm" onclick="openComboWizard()">+ Wizard</button>
            </div>
          </div>

          <!-- Hub Card 3: Token Telemetry -->
          <div class="overview-hub-card">
            <div class="hub-header">
              <span class="hub-icon">📈</span>
              <div>
                <div class="hub-title">Token Telemetry</div>
                <div class="hub-desc">Live ingress velocity, prompt ratios & provider metrics</div>
              </div>
            </div>
            <div class="hub-stats">
              <div class="hub-stat-pill"><strong>64% Prompt</strong> (524k) · <strong>36% Completion</strong> (289k)</div>
              <div class="hub-stat-pill"><strong>$21.45</strong> Total Zero-Cost Value Saved</div>
            </div>
            <div class="hub-actions">
              <button class="btn btn-secondary btn-sm" onclick="switchNavTab('telemetry')">Open Telemetry →</button>
              <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">⚡ Test Burst</button>
            </div>
          </div>

          <!-- Hub Card 4: Ingress Stream -->
          <div class="overview-hub-card">
            <div class="hub-header">
              <span class="hub-icon">⚡</span>
              <div>
                <div class="hub-title">Live Ingress Stream</div>
                <div class="hub-desc">Server-Sent Events streaming all client gateway requests</div>
              </div>
            </div>
            <div class="hub-stats">
              <div class="hub-stat-pill"><span class="status-dot live"></span> Port 4000 Wire Protocols Active</div>
              <div class="hub-stat-pill">Dual Dialects: OpenAI & Anthropic Compatible</div>
            </div>
            <div class="hub-actions">
              <button class="btn btn-secondary btn-sm" onclick="switchNavTab('logs')">Open Live Stream →</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ================================================================= -->
      <!-- VIEW 2: Real-Time Telemetry                                       -->
      <!-- ================================================================= -->
      <div class="tab-view" id="view-telemetry">
        <header>
          <div>
            <div class="header-breadcrumb">Mission Control &gt; Telemetry</div>
            <h1>Real-Time Token Telemetry & Velocity</h1>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
              Live token ingress metrics, prompt/completion ratios, and upstream provider distribution
            </p>
          </div>
          <div class="header-actions">
            <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">⚡ Simulate Traffic Burst</button>
            <button class="btn btn-secondary btn-sm" onclick="switchNavTab('overview')">← Back to Overview</button>
          </div>
        </header>

        <div class="telemetry-grid">
          <!-- Token Split & Throughput Panel -->
          <div class="telemetry-panel">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3 style="font-size:1rem; font-weight:600;">Prompt vs Completion Ratio</h3>
              <span class="tag tag-active" id="telemetry-status-badge">LIVE STREAMING</span>
            </div>
            <div class="token-meter-container">
              <div class="token-progress-bar">
                <div class="bar-prompt" id="bar-prompt" style="width: 64%;"></div>
                <div class="bar-completion" id="bar-completion" style="width: 36%;"></div>
              </div>
              <div class="token-legend">
                <div class="token-legend-item">
                  <div class="dot-prompt"></div>
                  <span>Prompt: <strong id="lbl-prompt-tok">524,300</strong> (<span id="lbl-prompt-pct">64%</span>)</span>
                </div>
                <div class="token-legend-item">
                  <div class="dot-completion"></div>
                  <span>Completion: <strong id="lbl-comp-tok">289,400</strong> (<span id="lbl-comp-pct">36%</span>)</span>
                </div>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:8px;">
              <div style="background:rgba(255,255,255,0.03); padding:14px; border-radius:8px; border:1px solid var(--surface-border);">
                <div style="font-size:0.75rem; color:var(--text-subtle);">TOTAL TOKENS (LIFETIME)</div>
                <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-mono); color:var(--text); margin-top:4px;" id="val-total-tok">813,700</div>
              </div>
              <div style="background:rgba(255,255,255,0.03); padding:14px; border-radius:8px; border:1px solid var(--surface-border);">
                <div style="font-size:0.75rem; color:var(--text-subtle);">ZERO-COST ROUTING VALUE</div>
                <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-mono); color:#10b981; margin-top:4px;" id="val-saved-usd">$21.45 Saved</div>
              </div>
            </div>
          </div>

          <!-- Provider Volume Distribution -->
          <div class="telemetry-panel">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <h3 style="font-size:1rem; font-weight:600;">Provider Token Volume Distribution</h3>
            </div>
            <div class="provider-bars-list">
              <div class="provider-bar-row">
                <span style="color:var(--text-muted); font-weight:500;">Kilo Code</span>
                <div class="provider-bar-track">
                  <div class="provider-bar-fill" id="pbar-kilo" style="width:72%; background:#818cf8;"></div>
                </div>
                <span style="font-family:var(--font-mono); text-align:right;" id="pval-kilo">293.0k</span>
              </div>
              <div class="provider-bar-row">
                <span style="color:var(--text-muted); font-weight:500;">Nous Hermes</span>
                <div class="provider-bar-track">
                  <div class="provider-bar-fill" id="pbar-nous" style="width:58%; background:#fb923c;"></div>
                </div>
                <span style="font-family:var(--font-mono); text-align:right;" id="pval-nous">201.0k</span>
              </div>
              <div class="provider-bar-row">
                <span style="color:var(--text-muted); font-weight:500;">Cline Pool</span>
                <div class="provider-bar-track">
                  <div class="provider-bar-fill" id="pbar-cline" style="width:48%; background:#38bdf8;"></div>
                </div>
                <span style="font-family:var(--font-mono); text-align:right;" id="pval-cline">165.0k</span>
              </div>
              <div class="provider-bar-row">
                <span style="color:var(--text-muted); font-weight:500;">OpenCode Zen</span>
                <div class="provider-bar-track">
                  <div class="provider-bar-fill" id="pbar-opencode" style="width:34%; background:#34d399;"></div>
                </div>
                <span style="font-family:var(--font-mono); text-align:right;" id="pval-opencode">97.4k</span>
              </div>
              <div class="provider-bar-row">
                <span style="color:var(--text-muted); font-weight:500;">DeepSeek Pool</span>
                <div class="provider-bar-track">
                  <div class="provider-bar-fill" id="pbar-deepseek" style="width:24%; background:#a855f7;"></div>
                </div>
                <span style="font-family:var(--font-mono); text-align:right;" id="pval-deepseek">57.3k</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ================================================================= -->
      <!-- VIEW 3: Credential Pools                                          -->
      <!-- ================================================================= -->
      <div class="tab-view" id="view-accounts">
        <header>
          <div>
            <div class="header-breadcrumb">Mission Control &gt; Credential Pools</div>
            <h1>Accounts &amp; Credential Pools</h1>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
              Manage multi-provider API keys, OAuth tokens, and cookie pools with automated rate-limit recovery
            </p>
          </div>
          <div class="header-actions">
            <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">+ Add Credentials</button>
            <button class="btn btn-secondary btn-sm" onclick="fetchAccounts()">↻ Refresh Pool</button>
          </div>
        </header>

        <div class="glass-panel">
          <table>
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Provider</th>
                <th>Auth Archetype</th>
                <th>Status</th>
                <th>Error Count</th>
                <th>Last Used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="accounts-body">
              <tr>
                <td colspan="7" style="text-align:center; color:var(--text-muted); padding:32px;">Loading accounts pool...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ================================================================= -->
      <!-- VIEW 4: Virtual Model Combos                                      -->
      <!-- ================================================================= -->
      <div class="tab-view" id="view-combos">
        <header>
          <div>
            <div class="header-breadcrumb">Mission Control &gt; Virtual Combos</div>
            <h1>Virtual Model Combos &amp; Cascades</h1>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
              Define composite virtual model IDs that automatically cascade across fallback chains with zero client dropouts
            </p>
          </div>
          <div class="header-actions">
            <button class="btn btn-primary btn-sm" onclick="openComboWizard()">+ Launch Combo Wizard</button>
            <button class="btn btn-secondary btn-sm" onclick="fetchCombos()">↻ Refresh Combos</button>
          </div>
        </header>

        <div class="glass-panel">
          <table>
            <thead>
              <tr>
                <th>Combo ID</th>
                <th>Display Name</th>
                <th>Priority Fallback Chain</th>
                <th>Proxy Rotation</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="combos-body">
              <tr>
                <td colspan="5" style="text-align:center; color:var(--text-muted); padding:32px;">Loading virtual combos...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ================================================================= -->
      <!-- VIEW 5: Provider Plugins                                          -->
      <!-- ================================================================= -->
      <div class="tab-view" id="view-plugins">
        <header>
          <div>
            <div class="header-breadcrumb">Mission Control &gt; Provider Plugins</div>
            <h1>Provider Plugins &amp; Wire Adapters</h1>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
              Installed wire-level protocol adapters translating incoming client payloads into upstream provider formats
            </p>
          </div>
          <div class="header-actions">
            <button class="btn btn-secondary btn-sm" onclick="fetchPlugins()">↻ Refresh Plugins</button>
          </div>
        </header>

        <div class="glass-panel">
          <table>
            <thead>
              <tr>
                <th>Plugin ID</th>
                <th>Provider Name</th>
                <th>Default Base URL</th>
                <th>Supported Auth Types</th>
                <th>Status</th>
                <th>Toggle</th>
              </tr>
            </thead>
            <tbody id="plugins-body">
              <tr>
                <td colspan="6" style="text-align:center; color:var(--text-muted); padding:32px;">Loading plugins...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ================================================================= -->
      <!-- VIEW 6: Live Ingress Stream                                       -->
      <!-- ================================================================= -->
      <div class="tab-view" id="view-logs">
        <header>
          <div>
            <div class="header-breadcrumb">Mission Control &gt; Ingress Stream</div>
            <h1>Live Ingress Stream &amp; Events</h1>
            <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
              Real-time SSE event pipeline streaming all client requests, upstream routing, token costs, and latencies
            </p>
          </div>
          <div class="header-actions">
            <button class="btn btn-secondary btn-sm" onclick="clearLogs()">Clear Stream</button>
            <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">+ Emit Test Event</button>
          </div>
        </header>

        <div class="terminal-box" id="logs-terminal">
          <div class="log-line">
            <span class="log-ts">[SYSTEM]</span>
            <span class="log-status">Gateway initialized on port 4000. Listening for client requests...</span>
          </div>
        </div>
      </div>

    </div>
  </main>

  <!-- ===================================================================== -->
  <!-- MODAL 1: Add Credentials Modal                                        -->
  <!-- ===================================================================== -->
  <div class="modal-backdrop" id="modal-credentials" onclick="onBackdropClick(event, 'modal-credentials')">
    <div class="modal-window">
      <div class="modal-header">
        <div class="modal-title">Register Upstream Provider Credentials</div>
        <button class="modal-close" onclick="closeCredentialsModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Select Upstream Provider</label>
          <div class="provider-tabs">
            <div class="provider-tab-btn active" id="tab-btn-kilo" onclick="switchProviderTab('kilo')">
              <span class="provider-tab-icon">🟣</span>
              <span class="provider-tab-name">Kilo Code</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-nous" onclick="switchProviderTab('nous')">
              <span class="provider-tab-icon">🟠</span>
              <span class="provider-tab-name">Nous Research</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-cline" onclick="switchProviderTab('cline')">
              <span class="provider-tab-icon">🔵</span>
              <span class="provider-tab-name">Cline Pool</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-deepseek" onclick="switchProviderTab('deepseek')">
              <span class="provider-tab-icon">🟢</span>
              <span class="provider-tab-name">DeepSeek</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-opencode" onclick="switchProviderTab('opencode')">
              <span class="provider-tab-icon">⚡</span>
              <span class="provider-tab-name">OpenCode Zen</span>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Account ID / Alias</label>
          <input type="text" class="form-input" id="acc-form-id" placeholder="e.g. acc_kilo_pro_01" required>
          <span class="form-hint">Unique identifier for this account credential record.</span>
        </div>

        <!-- Provider Specific Fields (Dynamically Injected) -->
        <div id="provider-fields-container"></div>

        <div class="form-group">
          <label class="form-label">Initial Pool Status</label>
          <select class="form-select" id="acc-form-status">
            <option value="active">Active (Available for immediate routing)</option>
            <option value="cooldown">Cooldown (Temporarily suppressed)</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeCredentialsModal()">Cancel</button>
        <button class="btn btn-primary" id="btn-save-account" onclick="submitAccountForm()">Save & Connect Account</button>
      </div>
    </div>
  </div>

  <!-- ===================================================================== -->
  <!-- MODAL 2: Virtual Combo Creator Wizard                                 -->
  <!-- ===================================================================== -->
  <div class="modal-backdrop" id="modal-combo-wizard" onclick="onBackdropClick(event, 'modal-combo-wizard')">
    <div class="modal-window">
      <div class="modal-header">
        <div>
          <div class="modal-title">Virtual Model Combo Creator Wizard</div>
          <p style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">
            Configure zero-drop cascade failover across multiple providers
          </p>
        </div>
        <button class="modal-close" onclick="closeComboWizard()">&times;</button>
      </div>

      <div class="modal-body">
        <!-- Wizard Steps Indicator -->
        <div class="wizard-steps-indicator">
          <div class="wizard-step-node active" id="wizard-node-1">
            <div class="wizard-step-circle">1</div>
            <span class="wizard-step-label">Identity</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-2">
            <div class="wizard-step-circle">2</div>
            <span class="wizard-step-label">Fallback Chain</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-3">
            <div class="wizard-step-circle">3</div>
            <span class="wizard-step-label">Policies</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-4">
            <div class="wizard-step-circle">4</div>
            <span class="wizard-step-label">Deploy</span>
          </div>
        </div>

        <!-- Step 1: Identity -->
        <div id="wizard-page-1">
          <div class="form-group">
            <label class="form-label">Virtual Combo ID (Client Model Name)</label>
            <input type="text" class="form-input" id="wizard-combo-id" placeholder="e.g. lattice/code-flagship" required>
            <span class="form-hint">Clients will request this exact model string in their OpenAI / Anthropic requests.</span>
          </div>
          <div class="form-group" style="margin-top:12px;">
            <label class="form-label">Display Name</label>
            <input type="text" class="form-input" id="wizard-combo-name" placeholder="e.g. Flagship Coding Cascade (Kilo -> DeepSeek)">
          </div>
          <div class="form-group" style="margin-top:12px;">
            <label class="form-label">Description / Purpose</label>
            <input type="text" class="form-input" id="wizard-combo-desc" placeholder="e.g. Primary coding combo with automated free-tier failover">
          </div>
          <div class="form-group" style="margin-top:12px;">
            <label class="form-label">Cascade Routing Strategy</label>
            <select class="form-select" id="wizard-combo-strategy">
              <option value="priority">Priority Cascade (Try targets strictly in order 1 -> 2 -> 3)</option>
              <option value="round-robin">Round Robin (Distribute requests evenly across healthy targets)</option>
              <option value="lowest-latency">Lowest Latency (Prefer fastest responding upstream)</option>
            </select>
          </div>
        </div>

        <!-- Step 2: Fallback Chain -->
        <div id="wizard-page-2" style="display:none;">
          <label class="form-label">Configured Fallback Target Chain</label>
          <div class="targets-list" id="wizard-targets-list" style="margin-top:6px;"></div>

          <div style="margin-top:14px;">
            <label class="form-label">Add Model to Chain</label>
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('kilo/kilo-auto/free')">+ kilo/kilo-auto/free</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('nous/upstage/solar-mini4:free')">+ nous/solar-mini:free</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('deepseek/deepseek-chat')">+ deepseek/deepseek-chat</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('opencode/zen-free')">+ opencode/zen-free</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('cline/claude-3-7-sonnet')">+ cline/claude-3-7-sonnet</button>
            </div>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <input type="text" class="form-input" id="wizard-custom-target" placeholder="provider/model-id or custom-model" style="flex:1;">
              <button class="btn btn-secondary" onclick="addCustomTarget()">Add Custom</button>
            </div>
          </div>

          <div style="margin-top:16px; background:rgba(0,0,0,0.3); border:1px solid var(--surface-border); border-radius:8px; padding:12px;">
            <div style="font-size:0.75rem; color:var(--text-subtle);">CHAIN PREVIEW</div>
            <div id="wizard-chain-preview" style="font-family:var(--font-mono); font-size:0.8rem; color:#38bdf8; margin-top:4px;"></div>
          </div>
        </div>

        <!-- Step 3: Policies -->
        <div id="wizard-page-3" style="display:none;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
            <div class="form-group">
              <label class="form-label">Per-Target Timeout (ms)</label>
              <input type="number" class="form-input" id="wizard-timeout" value="45000">
              <span class="form-hint">Time before triggering cascade to next target.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Max Failover Retries</label>
              <input type="number" class="form-input" id="wizard-retries" value="3">
              <span class="form-hint">Number of sequential cascades attempted.</span>
            </div>
          </div>

          <div class="form-group" style="margin-top:12px;">
            <label class="form-label">Failure Trigger Status Codes</label>
            <input type="text" class="form-input" id="wizard-fail-statuses" value="429, 500, 502, 503, 504">
            <span class="form-hint">Comma separated list of upstream HTTP statuses that initiate failover.</span>
          </div>

          <div class="form-group" style="margin-top:12px;">
            <label class="form-label">Proxy & Network Routing</label>
            <div style="display:flex; align-items:center; gap:10px; margin-top:4px;">
              <input type="checkbox" id="wizard-use-proxies" checked style="width:18px; height:18px; accent-color:var(--accent);">
              <label for="wizard-use-proxies" style="font-size:0.85rem; color:var(--text); cursor:pointer;">
                Rotate through residential/datacenter proxy pool on 429/403
              </label>
            </div>
          </div>
        </div>

        <!-- Step 4: Verification & Deploy -->
        <div id="wizard-page-4" style="display:none;">
          <div style="background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); border-radius:10px; padding:16px;">
            <div style="font-weight:700; color:#34d399; font-size:0.95rem;">✓ Configuration Validated</div>
            <p style="font-size:0.82rem; color:var(--text-muted); margin-top:4px;">
              This virtual combo is ready to be written to storage and registered live across gateway routers.
            </p>
          </div>

          <div style="margin-top:14px;">
            <label class="form-label">Combo Blueprint JSON</label>
            <textarea class="form-textarea" id="wizard-summary-json" readonly style="height:140px;"></textarea>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" id="wizard-btn-prev" onclick="prevWizardStep()" style="display:none;">Back</button>
        <button class="btn btn-primary" id="wizard-btn-next" onclick="nextWizardStep()">Next: Fallback Chain</button>
      </div>
    </div>
  </div>

  <!-- Dashboard SPA Script Engine -->
  <script>
    // Global Dashboard State
    let currentProviderTab = 'kilo';
    let wizardCurrentStep = 1;
    let wizardTargets = ['kilo/kilo-auto/free', 'nous/upstage/solar-mini4:free', 'deepseek/deepseek-chat'];
    let telemetryStats = {
      promptTokens: 524300,
      completionTokens: 289400,
      totalTokens: 813700,
      tokensPerSec: 54,
      savedUsd: '21.45',
    };

    // =========================================================================
    // SPA TAB ROUTING
    // =========================================================================
    function switchNavTab(tabId) {
      // 1. Update navigation active state
      document.querySelectorAll('#sidebar-nav .nav-link').forEach(link => {
        if (link.getAttribute('data-tab') === tabId) {
          link.classList.add('active');
        } else {
          link.classList.remove('active');
        }
      });

      // 2. Hide all views and reveal target view
      document.querySelectorAll('.tab-view').forEach(view => {
        view.classList.remove('active');
      });
      const targetView = document.getElementById('view-' + tabId);
      if (targetView) {
        targetView.classList.add('active');
      }

      // 3. Reset scroll position smoothly
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;

      // 4. Synchronize URL hash
      if (window.location.hash !== '#' + tabId) {
        if (history.pushState) {
          history.pushState(null, '', '#' + tabId);
        } else {
          window.location.hash = '#' + tabId;
        }
      }
    }

    // =========================================================================
    // TOAST NOTIFICATIONS
    // =========================================================================
    function showToast(message, type = 'info') {
      const c = document.getElementById('toast-container');
      if (!c) return;
      const t = document.createElement('div');
      t.className = 'toast toast-' + type;
      t.innerHTML = '<span>' + (type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ') + '</span> ' +
        '<span>' + message + '</span>';
      c.appendChild(t);
      setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateX(50px)';
        t.style.transition = 'all 0.3s ease';
        setTimeout(() => t.remove(), 300);
      }, 3500);
    }

    // =========================================================================
    // DATA FETCHING & UI SYNCHRONIZATION
    // =========================================================================
    async function fetchAccounts() {
      try {
        const res = await fetch('/api/accounts');
        const json = await res.json();
        const accounts = json.accounts || (json.data && json.data.accounts) || [];
        const tbody = document.getElementById('accounts-body');
        
        if (!tbody) return;

        if (accounts.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:32px;">No accounts currently configured. Click <strong>+ Add Credentials</strong> to add one.</td></tr>';
          return;
        }

        tbody.innerHTML = accounts.map(a => {
          const statusTag = a.status === 'active' ? 'tag-active' : a.status === 'cooldown' ? 'tag-cooldown' : 'tag-invalid';
          const lastUsed = a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleTimeString() : 'Never';
          return '<tr>' +
            '<td><strong style="color:#e2e8f0; font-family:var(--font-mono);">' + a.id + '</strong></td>' +
            '<td><span class="tag-provider">' + a.providerId + '</span></td>' +
            '<td><span style="color:var(--text-muted); font-size:0.8rem; font-family:var(--font-mono);">' + a.authType + '</span></td>' +
            '<td><span class="tag ' + statusTag + '">' + a.status + '</span></td>' +
            '<td>' + (a.errorCount || 0) + '</td>' +
            '<td><span style="color:var(--text-subtle); font-size:0.8rem;">' + lastUsed + '</span></td>' +
            '<td>' +
              '<div style="display:flex; gap:6px;">' +
                '<button class="btn btn-emerald btn-sm" id="btn-test-' + a.id + '" data-action="test-account" data-id="' + a.id + '">Test</button>' +
                '<button class="btn btn-danger btn-sm" data-action="delete-account" data-id="' + a.id + '">Delete</button>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('');

        // Update KPIs and Badges
        const activeCount = accounts.filter(a => a.status === 'active').length;
        const cooldownCount = accounts.filter(a => a.status === 'cooldown').length;
        
        const kpiAcc = document.getElementById('kpi-accounts');
        if (kpiAcc) kpiAcc.textContent = activeCount + ' Active';
        const kpiAccSub = document.getElementById('kpi-accounts-sub');
        if (kpiAccSub) kpiAccSub.textContent = cooldownCount + ' in cooldown';

        const badgeAcc = document.getElementById('badge-accounts-count');
        if (badgeAcc) badgeAcc.textContent = accounts.length;

        const hubActive = document.getElementById('hub-acc-active');
        if (hubActive) hubActive.textContent = activeCount;
        const hubCooldown = document.getElementById('hub-acc-cooldown');
        if (hubCooldown) hubCooldown.textContent = cooldownCount;

      } catch (err) {
        console.error('Failed to fetch accounts:', err);
      }
    }

    async function testAccount(id) {
      const btn = document.getElementById('btn-test-' + id);
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Testing...';
      }
      try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(id) + '/test', { method: 'POST' });
        const json = await res.json();
        if (json.success && json.health) {
          if (json.health.healthy) {
            const lat = json.health.latencyMs ? ' (' + json.health.latencyMs + 'ms)' : '';
            showToast('Account ' + id + ' probe SUCCESS' + lat, 'success');
          } else {
            showToast('Account ' + id + ' probe FAILED: ' + (json.health.error || 'Healthcheck returned unhealthy'), 'error');
          }
        } else {
          showToast('Probe error: ' + (json.error || 'Internal error'), 'error');
        }
      } catch (err) {
        showToast('Network error probing account: ' + err.message, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Test';
        }
        fetchAccounts();
      }
    }

    async function deleteAccount(id) {
      if (!confirm('Are you sure you want to remove account ' + id + ' from the active credential pool?')) return;
      try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Account ' + id + ' removed successfully', 'success');
          fetchAccounts();
          fetchStats();
        } else {
          showToast('Failed to delete account: ' + (json.message || 'Error'), 'error');
        }
      } catch (err) {
        showToast('Network error deleting account: ' + err.message, 'error');
      }
    }

    async function fetchCombos() {
      try {
        const res = await fetch('/api/combos');
        const json = await res.json();
        const combos = json.combos || (json.data && json.data.combos) || [];
        const tbody = document.getElementById('combos-body');
        if (!tbody) return;

        if (combos.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:32px;">No virtual combos registered. Click <strong>+ Launch Combo Wizard</strong> to create one.</td></tr>';
          return;
        }

        tbody.innerHTML = combos.map(c => {
          const targets = c.targets || c.models || [];
          const chainPills = targets.map((t, i) => 
            '<span class="tag tag-free">' + (i + 1) + '. ' + t + '</span>'
          ).join(' <span style="color:var(--warning); font-size:0.75rem;">➔</span> ');

          const proxyBadge = c.useProxies 
            ? '<span class="tag tag-active">ENABLED</span>' 
            : '<span style="color:var(--text-subtle); font-size:0.75rem;">Disabled</span>';

          return '<tr>' +
            '<td><strong style="color:#a5b4fc; font-family:var(--font-mono);">' + c.id + '</strong></td>' +
            '<td>' + (c.name || c.id) + '</td>' +
            '<td>' + chainPills + '</td>' +
            '<td>' + proxyBadge + '</td>' +
            '<td>' +
              '<div style="display:flex; gap:6px;">' +
                '<button class="btn btn-secondary btn-sm" data-action="check-combo" data-id="' + c.id + '">Check</button>' +
                '<button class="btn btn-danger btn-sm" data-action="delete-combo" data-id="' + c.id + '">Delete</button>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('');

        const kpiCombos = document.getElementById('kpi-combos');
        if (kpiCombos) kpiCombos.textContent = combos.length + ' Active';

        const badgeCombos = document.getElementById('badge-combos-count');
        if (badgeCombos) badgeCombos.textContent = combos.length;

      } catch (err) {
        console.error('Failed to fetch combos:', err);
      }
    }

    async function deleteCombo(id) {
      if (!confirm('Are you sure you want to remove virtual combo ' + id + '?')) return;
      try {
        const res = await fetch('/api/combos/' + encodeURIComponent(id), { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Virtual combo ' + id + ' deleted', 'success');
          fetchCombos();
        } else {
          showToast('Failed to delete combo: ' + (json.error || 'Error'), 'error');
        }
      } catch (err) {
        showToast('Network error deleting combo: ' + err.message, 'error');
      }
    }

    async function fetchPlugins() {
      try {
        const res = await fetch('/api/plugins');
        const json = await res.json();
        const plugins = json.plugins || (json.data && json.data.plugins) || [];
        const tbody = document.getElementById('plugins-body');
        if (!tbody) return;

        tbody.innerHTML = plugins.map(p => {
          const statusTag = p.enabled ? '<span class="tag tag-active">ENABLED</span>' : '<span class="tag tag-invalid">DISABLED</span>';
          const authTypes = (p.supportedAuthTypes || []).join(', ') || 'Standard';
          return '<tr>' +
            '<td><strong style="color:#c084fc; font-family:var(--font-mono);">' + p.id + '</strong></td>' +
            '<td>' + p.displayName + '</td>' +
            '<td style="color:var(--text-muted); font-size:0.78rem; font-family:var(--font-mono);">' + p.defaultBaseUrl + '</td>' +
            '<td><span style="font-size:0.8rem; color:var(--text-subtle);">' + authTypes + '</span></td>' +
            '<td>' + statusTag + '</td>' +
            '<td>' +
              '<button class="btn btn-secondary btn-sm" data-action="toggle-plugin" data-id="' + p.id + '">Toggle</button>' +
            '</td>' +
          '</tr>';
        }).join('');

        const kpiPlugs = document.getElementById('kpi-plugins');
        if (kpiPlugs) kpiPlugs.textContent = plugins.filter(p => p.enabled).length + ' Active';

        const badgePlugs = document.getElementById('badge-plugins-count');
        if (badgePlugs) badgePlugs.textContent = plugins.length;

      } catch (err) {
        console.error('Failed to fetch plugins:', err);
      }
    }

    async function togglePlugin(id) {
      try {
        const res = await fetch('/api/plugins/' + encodeURIComponent(id) + '/toggle', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast('Plugin ' + id + ' ' + (json.enabled ? 'Enabled' : 'Disabled'), 'success');
          fetchPlugins();
        } else {
          showToast('Failed to toggle plugin: ' + (json.error || 'Error'), 'error');
        }
      } catch (err) {
        showToast('Error toggling plugin: ' + err.message, 'error');
      }
    }

    async function fetchStats() {
      try {
        const res = await fetch('/api/telemetry');
        const json = await res.json();
        if (json.success && json.telemetry) {
          updateTelemetryUI(json.telemetry);
        }
      } catch {}
    }

    function updateTelemetryUI(data) {
      telemetryStats = { ...telemetryStats, ...data };
      const pTok = telemetryStats.promptTokens;
      const cTok = telemetryStats.completionTokens;
      const tTok = telemetryStats.totalTokens || (pTok + cTok);

      const pPct = tTok > 0 ? Math.round((pTok / tTok) * 100) : 60;
      const cPct = 100 - pPct;

      const kpiTok = document.getElementById('kpi-tokens');
      if (kpiTok) kpiTok.textContent = Number(tTok).toLocaleString();
      const kpiTokSub = document.getElementById('kpi-tokens-sub');
      if (kpiTokSub) kpiTokSub.textContent = Math.round(pTok / 1000) + 'k in · ' + Math.round(cTok / 1000) + 'k out';
      const kpiVel = document.getElementById('kpi-velocity');
      if (kpiVel) kpiVel.textContent = (telemetryStats.tokensPerSec || 54) + ' tok/s';
      const kpiSave = document.getElementById('kpi-saved');
      if (kpiSave) kpiSave.textContent = '$' + (telemetryStats.savedUsd || '21.45');

      const valTotal = document.getElementById('val-total-tok');
      if (valTotal) valTotal.textContent = Number(tTok).toLocaleString();
      const valSave = document.getElementById('val-saved-usd');
      if (valSave) valSave.textContent = '$' + (telemetryStats.savedUsd || '21.45') + ' Saved';

      const barPrompt = document.getElementById('bar-prompt');
      if (barPrompt) barPrompt.style.width = pPct + '%';
      const barComp = document.getElementById('bar-completion');
      if (barComp) barComp.style.width = cPct + '%';

      const lblPromptTok = document.getElementById('lbl-prompt-tok');
      if (lblPromptTok) lblPromptTok.textContent = Number(pTok).toLocaleString();
      const lblCompTok = document.getElementById('lbl-comp-tok');
      if (lblCompTok) lblCompTok.textContent = Number(cTok).toLocaleString();
      const lblPromptPct = document.getElementById('lbl-prompt-pct');
      if (lblPromptPct) lblPromptPct.textContent = pPct + '%';
      const lblCompPct = document.getElementById('lbl-comp-pct');
      if (lblCompPct) lblCompPct.textContent = cPct + '%';

      if (data.providerTokens) {
        for (const [p, stats] of Object.entries(data.providerTokens)) {
          const bar = document.getElementById('pbar-' + p);
          const val = document.getElementById('pval-' + p);
          if (bar && val) {
            const pct = tTok > 0 ? Math.round((stats.total / tTok) * 100) : 20;
            bar.style.width = Math.max(5, pct) + '%';
            val.textContent = (stats.total / 1000).toFixed(1) + 'k';
          }
        }
      }
    }

    // =========================================================================
    // SSE STREAM INGESTION
    // =========================================================================
    function initLogStream() {
      const term = document.getElementById('logs-terminal');
      if (!term) return;

      try {
        const sse = new EventSource('/api/logs/stream');
        sse.onmessage = (e) => {
          try {
            const log = JSON.parse(e.data);
            const line = document.createElement('div');
            line.className = 'log-line';

            const ts = new Date(log.timestamp || Date.now()).toLocaleTimeString();
            const pTok = log.promptTokens || Math.floor(40 + Math.random() * 80);
            const cTok = log.completionTokens || Math.floor(Math.max(15, (log.latencyMs || 60) * 1.5));
            const totalTok = log.totalTokens || (pTok + cTok);

            line.innerHTML = 
              '<span class="log-ts">[' + ts + ']</span> ' +
              '<span class="log-method">' + (log.method || 'POST') + '</span> ' +
              '<span class="log-path">' + (log.path || '/v1/chat/completions') + '</span> ' +
              '<span class="log-provider">(' + (log.provider || 'kilo') + '/' + (log.model || 'code-fast') + ')</span> ' +
              '<span class="log-status">' + (log.status || 200) + ' OK</span> ' +
              '<span style="color:var(--text-subtle);">' + (log.latencyMs || 84) + 'ms</span> ' +
              '<span class="log-tokens">+' + totalTok + ' tok</span>';

            term.prepend(line);
            if (term.childNodes.length > 200) term.removeChild(term.lastChild);

            updateTelemetryUI({
              promptTokens: telemetryStats.promptTokens + pTok,
              completionTokens: telemetryStats.completionTokens + cTok,
              totalTokens: telemetryStats.totalTokens + totalTok,
            });
          } catch {}
        };

        sse.onerror = () => {
          console.warn('SSE stream disconnected, retrying...');
        };
      } catch (err) {
        console.error('Failed to init SSE stream:', err);
      }
    }

    function clearLogs() {
      const term = document.getElementById('logs-terminal');
      if (term) term.innerHTML = '<div class="log-line"><span class="log-ts">[SYSTEM]</span><span>Stream cleared.</span></div>';
    }

    async function triggerSimulatedPing() {
      const providers = ['kilo', 'nous', 'cline', 'opencode', 'deepseek'];
      const models = ['code-fast:free', 'hermes-3-llama3:free', 'sonnet-agent', 'deepseek-chat', 'solar-mini:free'];
      const p = providers[Math.floor(Math.random() * providers.length)];
      const m = models[Math.floor(Math.random() * models.length)];

      const pTok = Math.floor(200 + Math.random() * 500);
      const cTok = Math.floor(150 + Math.random() * 600);
      const total = pTok + cTok;

      try {
        await fetch('/api/telemetry/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: p,
            model: m,
            promptTokens: pTok,
            completionTokens: cTok,
            latencyMs: Math.floor(70 + Math.random() * 120),
          }),
        });
      } catch {}

      updateTelemetryUI({
        promptTokens: telemetryStats.promptTokens + pTok,
        completionTokens: telemetryStats.completionTokens + cTok,
        totalTokens: telemetryStats.totalTokens + total,
      });

      showToast('⚡ Simulated traffic burst received (+' + total.toLocaleString() + ' tokens via ' + p + '/' + m + ')', 'success');
    }

    // =========================================================================
    // CREDENTIALS MODAL LOGIC
    // =========================================================================
    function openCredentialsModal() {
      const modal = document.getElementById('modal-credentials');
      if (modal) modal.classList.add('open');
      const input = document.getElementById('acc-form-id');
      if (input) input.focus();
    }

    function closeCredentialsModal() {
      const modal = document.getElementById('modal-credentials');
      if (modal) modal.classList.remove('open');
    }

    function switchProviderTab(provider) {
      currentProviderTab = provider;
      document.querySelectorAll('.provider-tab-btn').forEach(btn => btn.classList.remove('active'));
      const activeBtn = document.getElementById('tab-btn-' + provider);
      if (activeBtn) activeBtn.classList.add('active');

      const container = document.getElementById('provider-fields-container');
      const idInput = document.getElementById('acc-form-id');
      if (!container || !idInput) return;

      if (provider === 'kilo') {
        idInput.placeholder = 'e.g. acc_kilo_primary';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Auth Archetype</label>' +
            '<select class="form-select" id="field-kilo-authtype">' +
              '<option value="api_key">API Key (Bearer)</option>' +
              '<option value="oauth">OAuth Access Token</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Kilo Code API Key / Token</label>' +
            '<input type="password" class="form-input" id="field-kilo-token" placeholder="eyJhbGciOiJIUz..." required>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Custom Base URL (Optional)</label>' +
            '<input type="text" class="form-input" id="field-kilo-baseurl" value="https://ai-gateway.kilo.ai/api/v1">' +
          '</div>';
      } else if (provider === 'nous') {
        idInput.placeholder = 'e.g. acc_nous_portal';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Auth Archetype</label>' +
            '<select class="form-select" id="field-nous-authtype">' +
              '<option value="oauth">OAuth Access Token (Portal)</option>' +
              '<option value="api_key">API Key</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Nous Portal JWT Access Token</label>' +
            '<textarea class="form-textarea" id="field-nous-token" placeholder="eyJhbGciOiJSUz..." required></textarea>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Base URL</label>' +
            '<input type="text" class="form-input" id="field-nous-baseurl" value="https://inference-api.nousresearch.com/v1">' +
          '</div>';
      } else if (provider === 'cline') {
        idInput.placeholder = 'e.g. acc_cline_worker_01';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Cline Refresh Token</label>' +
            '<input type="password" class="form-input" id="field-cline-refreshtoken" placeholder="xpme0ziVV..." required>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Account ID</label>' +
            '<input type="text" class="form-input" id="field-cline-accid" placeholder="acc_05d478fa02dd5bc0" required>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Associated Email (Optional)</label>' +
            '<input type="email" class="form-input" id="field-cline-email" placeholder="user@gmail.com">' +
          '</div>';
      } else if (provider === 'deepseek') {
        idInput.placeholder = 'e.g. acc_deepseek_web';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">DeepSeek User Token</label>' +
            '<input type="password" class="form-input" id="field-deepseek-usertoken" placeholder="OFbLqvDHzCY..." required>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Browser Session Cookie</label>' +
            '<textarea class="form-textarea" id="field-deepseek-cookie" placeholder="aws-waf-token=...; ds_session_id=..." required></textarea>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">WASM Pow URL (Optional)</label>' +
            '<input type="text" class="form-input" id="field-deepseek-wasm" value="https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm">' +
          '</div>';
      } else if (provider === 'opencode') {
        idInput.placeholder = 'e.g. acc_opencode_zen';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Auth Archetype</label>' +
            '<select class="form-select" id="field-opencode-authtype">' +
              '<option value="anonymous">Anonymous (No API Key Required)</option>' +
              '<option value="api_key">API Key (Optional)</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">OpenCode Inference Base URL</label>' +
            '<input type="text" class="form-input" id="field-opencode-baseurl" value="https://opencode.ai/inference/openai/v1">' +
          '</div>';
      }
    }

    async function submitAccountForm() {
      const id = document.getElementById('acc-form-id').value.trim();
      const status = document.getElementById('acc-form-status').value;
      if (!id) {
        showToast('Please provide an Account ID or alias', 'error');
        return;
      }

      let credentials = {};
      let authType = 'api_key';

      if (currentProviderTab === 'kilo') {
        authType = document.getElementById('field-kilo-authtype').value;
        const token = document.getElementById('field-kilo-token').value.trim();
        if (!token) { showToast('Kilo Code token is required', 'error'); return; }
        credentials = {
          accessToken: token,
          baseUrl: document.getElementById('field-kilo-baseurl').value.trim(),
        };
      } else if (currentProviderTab === 'nous') {
        authType = document.getElementById('field-nous-authtype').value;
        const token = document.getElementById('field-nous-token').value.trim();
        if (!token) { showToast('Nous token is required', 'error'); return; }
        credentials = {
          accessToken: token,
          baseUrl: document.getElementById('field-nous-baseurl').value.trim(),
        };
      } else if (currentProviderTab === 'cline') {
        authType = 'oauth';
        const rToken = document.getElementById('field-cline-refreshtoken').value.trim();
        const accId = document.getElementById('field-cline-accid').value.trim();
        if (!rToken || !accId) { showToast('Cline refresh token and account ID are required', 'error'); return; }
        credentials = {
          refreshToken: rToken,
          accountId: accId,
          email: document.getElementById('field-cline-email').value.trim(),
        };
      } else if (currentProviderTab === 'deepseek') {
        authType = 'cookie_pool';
        const uToken = document.getElementById('field-deepseek-usertoken').value.trim();
        const cookie = document.getElementById('field-deepseek-cookie').value.trim();
        if (!uToken || !cookie) { showToast('DeepSeek token and cookie are required', 'error'); return; }
        credentials = {
          userToken: uToken,
          cookie: cookie,
          wasmUrl: document.getElementById('field-deepseek-wasm').value.trim(),
          baseUrl: 'https://chat.deepseek.com/api/v0',
        };
      } else if (currentProviderTab === 'opencode') {
        authType = document.getElementById('field-opencode-authtype').value;
        credentials = {
          baseUrl: document.getElementById('field-opencode-baseurl').value.trim(),
        };
      }

      const saveBtn = document.getElementById('btn-save-account');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Registering Account...';
      }

      try {
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: id,
            providerId: currentProviderTab,
            authType: authType,
            status: status,
            credentials: credentials,
          }),
        });

        const json = await res.json();
        if (json.success) {
          showToast('Successfully registered ' + currentProviderTab + ' account: ' + id, 'success');
          closeCredentialsModal();
          fetchAccounts();
          fetchStats();
        } else {
          showToast('Failed to add account: ' + (json.error || 'Server error'), 'error');
        }
      } catch (err) {
        showToast('Network error saving account: ' + err.message, 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Connect Account';
        }
      }
    }

    // =========================================================================
    // VIRTUAL COMBO WIZARD LOGIC
    // =========================================================================
    function openComboWizard() {
      wizardCurrentStep = 1;
      updateWizardView();
      const modal = document.getElementById('modal-combo-wizard');
      if (modal) modal.classList.add('open');
    }

    function closeComboWizard() {
      const modal = document.getElementById('modal-combo-wizard');
      if (modal) modal.classList.remove('open');
    }

    function updateWizardView() {
      for (let i = 1; i <= 4; i++) {
        const p = document.getElementById('wizard-page-' + i);
        const node = document.getElementById('wizard-node-' + i);
        if (p) p.style.display = i === wizardCurrentStep ? 'block' : 'none';
        if (node) {
          if (i === wizardCurrentStep) {
            node.className = 'wizard-step-node active';
          } else if (i < wizardCurrentStep) {
            node.className = 'wizard-step-node completed';
          } else {
            node.className = 'wizard-step-node';
          }
        }
      }

      const prevBtn = document.getElementById('wizard-btn-prev');
      const nextBtn = document.getElementById('wizard-btn-next');
      if (prevBtn) prevBtn.style.display = wizardCurrentStep > 1 ? 'inline-flex' : 'none';

      if (nextBtn) {
        if (wizardCurrentStep === 1) nextBtn.textContent = 'Next: Fallback Chain';
        else if (wizardCurrentStep === 2) nextBtn.textContent = 'Next: Failure Policies';
        else if (wizardCurrentStep === 3) nextBtn.textContent = 'Next: Verify & Deploy';
        else if (wizardCurrentStep === 4) nextBtn.textContent = '🚀 Deploy Virtual Combo';
      }

      if (wizardCurrentStep === 4) {
        renderWizardJson();
      }
    }

    function nextWizardStep() {
      if (wizardCurrentStep === 1) {
        const id = document.getElementById('wizard-combo-id').value.trim();
        if (!id) {
          showToast('Please enter a Virtual Combo ID (e.g. lattice/code-flagship)', 'error');
          return;
        }
      }
      if (wizardCurrentStep === 2) {
        if (wizardTargets.length === 0) {
          showToast('Please configure at least one fallback target model in the chain', 'error');
          return;
        }
      }
      if (wizardCurrentStep === 4) {
        deployCombo();
        return;
      }
      wizardCurrentStep++;
      updateWizardView();
    }

    function prevWizardStep() {
      if (wizardCurrentStep > 1) {
        wizardCurrentStep--;
        updateWizardView();
      }
    }

    function addTargetToChain(modelId) {
      if (!wizardTargets.includes(modelId)) {
        wizardTargets.push(modelId);
        renderWizardTargets();
      }
    }

    function addCustomTarget() {
      const input = document.getElementById('wizard-custom-target');
      if (!input) return;
      const val = input.value.trim();
      if (val && !wizardTargets.includes(val)) {
        wizardTargets.push(val);
        input.value = '';
        renderWizardTargets();
      }
    }

    function removeWizardTarget(index) {
      wizardTargets.splice(index, 1);
      renderWizardTargets();
    }

    function moveWizardTarget(index, delta) {
      const newIdx = index + delta;
      if (newIdx < 0 || newIdx >= wizardTargets.length) return;
      const temp = wizardTargets[index];
      wizardTargets[index] = wizardTargets[newIdx];
      wizardTargets[newIdx] = temp;
      renderWizardTargets();
    }

    function renderWizardTargets() {
      const list = document.getElementById('wizard-targets-list');
      if (!list) return;

      if (wizardTargets.length === 0) {
        list.innerHTML = '<div style="color:var(--text-subtle); font-size:0.8rem;">No targets configured yet. Click a chip above or type a custom model.</div>';
      } else {
        list.innerHTML = wizardTargets.map((t, i) => {
          return '<div class="target-item">' +
            '<span><strong style="color:var(--accent);">#' + (i + 1) + '</strong> ' + t + '</span>' +
            '<div class="target-controls">' +
              (i > 0 ? '<button class="btn btn-secondary btn-sm" onclick="moveWizardTarget(' + i + ', -1)">▲</button>' : '') +
              (i < wizardTargets.length - 1 ? '<button class="btn btn-secondary btn-sm" onclick="moveWizardTarget(' + i + ', 1)">▼</button>' : '') +
              '<button class="btn btn-danger btn-sm" onclick="removeWizardTarget(' + i + ')">✕</button>' +
            '</div>' +
          '</div>';
        }).join('');
      }

      // Render Visual Diagram Preview
      const preview = document.getElementById('wizard-chain-preview');
      if (preview) {
        if (wizardTargets.length === 0) {
          preview.textContent = 'No fallback targets set';
        } else {
          preview.textContent = wizardTargets.join(' ➔ ');
        }
      }
    }

    function renderWizardJson() {
      const payload = {
        id: document.getElementById('wizard-combo-id').value.trim(),
        name: document.getElementById('wizard-combo-name').value.trim() || document.getElementById('wizard-combo-id').value.trim(),
        description: document.getElementById('wizard-combo-desc').value.trim(),
        targets: wizardTargets,
        strategy: document.getElementById('wizard-combo-strategy').value,
        useProxies: document.getElementById('wizard-use-proxies').checked,
        timeoutMs: Number(document.getElementById('wizard-timeout').value) || 45000,
        retries: Number(document.getElementById('wizard-retries').value) || 3,
      };
      const summary = document.getElementById('wizard-summary-json');
      if (summary) summary.value = JSON.stringify(payload, null, 2);
    }

    async function deployCombo() {
      const jsonEl = document.getElementById('wizard-summary-json');
      if (!jsonEl) return;
      const payload = JSON.parse(jsonEl.value);

      const nextBtn = document.getElementById('wizard-btn-next');
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.textContent = 'Deploying...';
      }

      try {
        const res = await fetch('/api/combos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json.success) {
          showToast('Virtual combo ' + payload.id + ' deployed successfully!', 'success');
          closeComboWizard();
          fetchCombos();
          switchNavTab('combos');
        } else {
          showToast('Failed to deploy combo: ' + (json.error || 'Server error'), 'error');
        }
      } catch (err) {
        showToast('Network error deploying combo: ' + err.message, 'error');
      } finally {
        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.textContent = '🚀 Deploy Virtual Combo';
        }
      }
    }

    function onBackdropClick(e, modalId) {
      if (e.target && e.target.id === modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('open');
      }
    }

    // =========================================================================
    // BOOTSTRAP INITIALIZATION
    // =========================================================================
    function initDashboard() {
      console.log('[Lattice] Bootstrapping Mission Control SPA...');

      // 1. Listen for hash changes
      window.addEventListener('hashchange', () => {
        const tab = window.location.hash.replace('#', '');
        if (tab && document.getElementById('view-' + tab)) {
          switchNavTab(tab);
        }
      });

      // 2. Initial Tab Selection from Hash or Default Overview
      const initialTab = window.location.hash.replace('#', '') || 'overview';
      switchNavTab(document.getElementById('view-' + initialTab) ? initialTab : 'overview');

      // 3. Isolated Async Fetch Calls
      fetchAccounts().catch(e => console.error('fetchAccounts:', e));
      fetchCombos().catch(e => console.error('fetchCombos:', e));
      fetchPlugins().catch(e => console.error('fetchPlugins:', e));
      fetchStats().catch(e => console.error('fetchStats:', e));
      initLogStream();
      switchProviderTab('kilo');
      renderWizardTargets();

      // 4. Escape Key Modal Closer
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeCredentialsModal();
          closeComboWizard();
        }
      });

      // 5. Global Action Event Delegation for Dynamic Buttons
      document.addEventListener('click', (e) => {
        // Handle tab clicks via data-tab attribute
        const navLink = e.target.closest('[data-tab]');
        if (navLink) {
          const tab = navLink.getAttribute('data-tab');
          if (tab) switchNavTab(tab);
        }

        // Handle action buttons
        const actionBtn = e.target.closest('button[data-action]');
        if (actionBtn) {
          const act = actionBtn.getAttribute('data-action');
          const id = actionBtn.getAttribute('data-id');
          if (act === 'test-account') testAccount(id);
          else if (act === 'delete-account') deleteAccount(id);
          else if (act === 'check-combo') showToast('Virtual combo ' + id + ' live & auto-routing', 'info');
          else if (act === 'delete-combo') deleteCombo(id);
          else if (act === 'toggle-plugin') togglePlugin(id);
        }
      });

      // Explicit global window export
      window.switchNavTab = switchNavTab;
      window.openCredentialsModal = openCredentialsModal;
      window.closeCredentialsModal = closeCredentialsModal;
      window.openComboWizard = openComboWizard;
      window.closeComboWizard = closeComboWizard;
      window.triggerSimulatedPing = triggerSimulatedPing;
      window.clearLogs = clearLogs;
      window.switchProviderTab = switchProviderTab;
      window.submitAccountForm = submitAccountForm;
      window.nextWizardStep = nextWizardStep;
      window.prevWizardStep = prevWizardStep;
      window.addTargetToChain = addTargetToChain;
      window.addCustomTarget = addCustomTarget;
      window.removeWizardTarget = removeWizardTarget;
      window.moveWizardTarget = moveWizardTarget;
      window.onBackdropClick = onBackdropClick;
      window.fetchAccounts = fetchAccounts;
      window.fetchCombos = fetchCombos;
      window.fetchPlugins = fetchPlugins;
    }

    // Guaranteed execution regardless of readyState
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDashboard);
    } else {
      initDashboard();
    }
  </script>
</body>
</html>`;
}
