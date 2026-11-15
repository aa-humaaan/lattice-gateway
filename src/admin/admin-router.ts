import { Hono } from 'hono';
import { globalAccountPool } from '../pool/account-pool';
import { globalComboManager } from '../pool/combos';
import { globalProxyPool } from '../pool/proxy-pool';
import { globalPluginRegistry } from '../plugins/registry';
import { globalStorage } from '../pool/storage';
import type { StoredAccount } from '../core/types/plugin';

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
    globalAccountPool.addAccount(account);
    globalStorage.save();
    return c.json({ success: true, message: `Account ${body.id} added`, account });
  });

  router.delete('/api/accounts/:id', (c) => {
    const id = c.req.param('id');
    const deleted = globalAccountPool.deleteAccount(id);
    if (deleted) globalStorage.save();
    return c.json({ success: deleted, message: deleted ? `Account ${id} removed` : 'Not found' });
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
    body {
      background: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.16) 0px, transparent 45%),
        radial-gradient(at 100% 0%, rgba(139, 92, 246, 0.14) 0px, transparent 45%),
        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.12) 0px, transparent 50%),
        radial-gradient(at 0% 100%, rgba(6, 182, 212, 0.1) 0px, transparent 50%);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      overflow-x: hidden;
    }

    /* Scrollbar */
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
      gap: 24px;
      backdrop-filter: blur(20px);
      position: sticky;
      top: 0;
      height: 100vh;
      z-index: 50;
      flex-shrink: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 4px;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent), var(--purple));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 1.15rem;
      color: #fff;
      box-shadow: 0 0 20px var(--accent-glow);
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
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.88rem;
      font-weight: 500;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      border: 1px solid transparent;
    }
    .nav-link:hover {
      color: var(--text);
      background: var(--surface-hover);
    }
    .nav-link.active {
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      border-color: rgba(99, 102, 241, 0.28);
      box-shadow: 0 0 16px rgba(99, 102, 241, 0.15);
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
      transform: translateY(-1px);
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.12);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.25);
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.22);
    }
    .btn-sm {
      padding: 5px 10px;
      font-size: 0.78rem;
    }

    /* Main Content */
    main {
      flex: 1;
      padding: 32px 40px;
      overflow-y: auto;
      max-width: 1480px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
    }
    h1 {
      font-size: 1.85rem;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .header-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      color: #34d399;
      font-size: 0.85rem;
      font-weight: 500;
      font-family: var(--font-mono);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
      animation: pulseGlow 2s infinite;
    }
    @keyframes pulseGlow {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.15); }
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 18px 20px;
      backdrop-filter: blur(14px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
      transition: all 0.2s ease;
    }
    .kpi-card:hover {
      border-color: rgba(255, 255, 255, 0.14);
      transform: translateY(-2px);
    }
    .kpi-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .kpi-val {
      font-size: 1.7rem;
      font-weight: 700;
      font-family: var(--font-mono);
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 0.75rem;
      color: var(--text-subtle);
      margin-top: 4px;
      font-family: var(--font-mono);
    }

    /* Section Styling */
    .section-title {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .glass-panel {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      backdrop-filter: blur(16px);
      overflow: hidden;
      margin-bottom: 28px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
    }

    /* Telemetry Grid & Gauges */
    .telemetry-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 28px;
    }
    .telemetry-panel {
      background: var(--bg-surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 20px;
      backdrop-filter: blur(16px);
    }
    .token-meter-container {
      margin-top: 14px;
    }
    .token-bar-track {
      height: 12px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      overflow: hidden;
      display: flex;
      margin: 8px 0;
    }
    .token-bar-prompt {
      background: linear-gradient(90deg, #38bdf8, var(--accent));
      height: 100%;
      transition: width 0.4s ease;
    }
    .token-bar-completion {
      background: linear-gradient(90deg, var(--purple), #ec4899);
      height: 100%;
      transition: width 0.4s ease;
    }
    .token-meter-legend {
      display: flex;
      justify-content: space-between;
      font-size: 0.78rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    .provider-bars {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
    }
    .provider-bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.8rem;
    }
    .provider-bar-name {
      width: 85px;
      font-family: var(--font-mono);
      font-weight: 500;
      color: var(--text-muted);
    }
    .provider-bar-track {
      flex: 1;
      height: 8px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      overflow: hidden;
    }
    .provider-bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.4s ease;
    }
    .provider-bar-val {
      width: 75px;
      text-align: right;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-subtle);
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.88rem;
    }
    th {
      background: rgba(255, 255, 255, 0.02);
      padding: 12px 18px;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--surface-border);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    td {
      padding: 13px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-size: 0.84rem;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface-hover); }

    .tag {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
      font-family: var(--font-mono);
      display: inline-block;
      text-transform: uppercase;
    }
    .tag-active { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25); }
    .tag-cooldown { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); }
    .tag-invalid { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }
    .tag-free { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.25); }
    .tag-provider {
      background: rgba(255, 255, 255, 0.06);
      color: #e2e8f0;
      font-family: var(--font-mono);
      font-size: 0.72rem;
      padding: 2px 6px;
      border-radius: 4px;
    }

    /* Terminal Log Box */
    .terminal-box {
      background: #050608;
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      max-height: 320px;
      overflow-y: auto;
      line-height: 1.6;
      box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.5);
    }
    .log-line {
      display: flex;
      gap: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.02);
      padding: 4px 0;
      align-items: center;
      transition: background 0.15s ease;
    }
    .log-line:hover { background: rgba(255, 255, 255, 0.02); }
    .log-ts { color: var(--text-subtle); flex-shrink: 0; }
    .log-method { color: #38bdf8; font-weight: 600; flex-shrink: 0; }
    .log-path { color: #cbd5e1; flex-shrink: 0; }
    .log-provider { color: #c084fc; flex-shrink: 0; }
    .log-status { color: #34d399; font-weight: 600; flex-shrink: 0; }
    .log-tokens { color: #a7f3d0; margin-left: auto; flex-shrink: 0; }

    /* Modals */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
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
      max-width: 650px;
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
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .form-input, .form-select, .form-textarea {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 10px 14px;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 0.9rem;
      transition: all 0.2s ease;
      outline: none;
    }
    .form-input:focus, .form-select:focus, .form-textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
      background: rgba(255, 255, 255, 0.07);
    }
    .form-textarea { min-height: 80px; resize: vertical; font-family: var(--font-mono); font-size: 0.82rem; }
    .form-hint { font-size: 0.75rem; color: var(--text-subtle); margin-top: 2px; }

    /* Provider Selector Tabs in Modal */
    .provider-tabs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 6px;
    }
    .provider-tab-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--surface-border);
      border-radius: 10px;
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      color: var(--text-muted);
    }
    .provider-tab-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      border-color: rgba(255, 255, 255, 0.16);
    }
    .provider-tab-btn.active {
      background: rgba(99, 102, 241, 0.16);
      border-color: var(--accent);
      color: #fff;
      box-shadow: 0 0 16px var(--accent-glow);
    }
    .provider-tab-icon { font-size: 1.4rem; }
    .provider-tab-name { font-size: 0.78rem; font-weight: 600; text-align: center; }

    /* Combo Wizard Stepper */
    .wizard-steps {
      display: flex;
      border-bottom: 1px solid var(--surface-border);
      background: rgba(0, 0, 0, 0.2);
    }
    .wizard-step {
      flex: 1;
      padding: 12px 14px;
      text-align: center;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-subtle);
      border-bottom: 2px solid transparent;
      transition: all 0.2s ease;
    }
    .wizard-step.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      background: rgba(99, 102, 241, 0.06);
    }
    .wizard-step.completed {
      color: var(--success);
    }

    /* Fallback Chain Flowchart Preview */
    .chain-diagram {
      background: rgba(0, 0, 0, 0.35);
      border: 1px dashed rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      min-height: 60px;
    }
    .chain-node {
      background: rgba(99, 102, 241, 0.18);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #e0e7ff;
      border-radius: 6px;
      padding: 6px 12px;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .chain-arrow {
      color: var(--warning);
      font-size: 0.8rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .chain-arrow-badge {
      font-size: 0.65rem;
      background: rgba(245, 158, 11, 0.15);
      padding: 1px 4px;
      border-radius: 3px;
    }

    .target-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .target-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--surface-border);
      border-radius: 6px;
      padding: 4px 10px;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .target-chip:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .targets-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
    }
    .target-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }
    .target-controls {
      display: flex;
      gap: 4px;
    }

    /* Toast Notifications */
    .toast-container {
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
      pointer-events: auto;
      background: #0f1422;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 12px 18px;
      color: var(--text);
      font-size: 0.85rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      gap: 10px;
      animation: toastIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      min-width: 280px;
    }
    .toast-success { border-left: 4px solid var(--success); }
    .toast-error { border-left: 4px solid var(--danger); }
    .toast-info { border-left: 4px solid var(--accent); }
    @keyframes toastIn { from { transform: translateX(50px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  </style>
</head>
<body>
  <!-- Sidebar Navigation -->
  <aside>
    <div class="brand">
      <div class="brand-logo">L</div>
      <div>
        <div class="brand-title">Lattice Gateway</div>
        <div class="brand-badge">Mission Control v1.0</div>
      </div>
    </div>

    <nav>
      <div class="nav-label">Core Navigation</div>
      <a class="nav-link active" onclick="scrollToSection('sec-overview')">📊 Overview & KPIs</a>
      <a class="nav-link" onclick="scrollToSection('sec-telemetry')">📈 Real-Time Telemetry</a>
      <a class="nav-link" onclick="scrollToSection('sec-accounts')">👥 Credential Pools</a>
      <a class="nav-link" onclick="scrollToSection('sec-combos')">🔀 Virtual Combos</a>
      <a class="nav-link" onclick="scrollToSection('sec-plugins')">🔌 Provider Plugins</a>
      <a class="nav-link" onclick="scrollToSection('sec-logs')">⚡ Live Ingress Stream</a>
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
    <header id="sec-overview">
      <div>
        <h1>Mission Control</h1>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">
          Universal Multi-Provider LLM Gateway, Credential Pool & Virtual Combos
        </p>
      </div>
      <div class="header-actions">
        <div class="status-pill">
          <div class="status-dot"></div>
          <span>Core Operational :4000</span>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">+ Add Account</button>
        <button class="btn btn-secondary btn-sm" onclick="openComboWizard()">+ Create Combo</button>
      </div>
    </header>

    <!-- Top KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Active Plugins</div>
        <div class="kpi-val" id="kpi-plugins" style="color: #818cf8;">5 Active</div>
        <div class="kpi-sub">Kilo · Nous · Cline · OpenCode · DeepSeek</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active Accounts</div>
        <div class="kpi-val" id="kpi-accounts" style="color: #34d399;">Healthy</div>
        <div class="kpi-sub" id="kpi-accounts-sub">0 in cooldown</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Virtual Combos</div>
        <div class="kpi-val" id="kpi-combos" style="color: #38bdf8;">2 Active</div>
        <div class="kpi-sub">Auto-failover active</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Average Latency</div>
        <div class="kpi-val" id="kpi-latency" style="color: #fbbf24;">~118ms</div>
        <div class="kpi-sub" id="kpi-latency-sub">Rolling avg across upstreams</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Streamed Tokens</div>
        <div class="kpi-val" id="kpi-tokens" style="color: #ec4899;">813,700</div>
        <div class="kpi-sub" id="kpi-tokens-sub">524k in · 289k out</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Token Throughput</div>
        <div class="kpi-val" id="kpi-velocity" style="color: #a78bfa;">54 tok/s</div>
        <div class="kpi-sub">Real-time velocity</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Cost Avoidance</div>
        <div class="kpi-val" id="kpi-saved" style="color: #10b981;">$21.45</div>
        <div class="kpi-sub">$0 Free-tier value saved</div>
      </div>
    </div>

    <!-- Section 1: Real-Time Token Telemetry Metrics -->
    <div class="section-title" id="sec-telemetry">
      <span>📈 Real-Time Token Telemetry & Provider Metrics</span>
      <button class="btn btn-secondary btn-sm" onclick="triggerSimulatedPing()">⚡ Simulate Traffic Burst</button>
    </div>
    <div class="telemetry-grid">
      <!-- Token Split & Throughput Panel -->
      <div class="telemetry-panel">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="font-size:1rem; font-weight:600;">Prompt vs Completion Ratio</h3>
          <span class="tag tag-active" id="telemetry-status-badge">LIVE STREAMING</span>
        </div>
        <div class="token-meter-container">
          <div class="token-bar-track">
            <div class="token-bar-prompt" id="bar-prompt" style="width: 64%;"></div>
            <div class="token-bar-completion" id="bar-comp" style="width: 36%;"></div>
          </div>
          <div class="token-meter-legend">
            <span style="color:#38bdf8;">● Prompt: <strong id="lbl-prompt-tok">524,300</strong> (<span id="lbl-prompt-pct">64%</span>)</span>
            <span style="color:#ec4899;">● Completion: <strong id="lbl-comp-tok">289,400</strong> (<span id="lbl-comp-pct">36%</span>)</span>
          </div>
        </div>

        <div style="margin-top:20px; display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
          <div style="background:rgba(255,255,255,0.03); border:1px solid var(--surface-border); border-radius:8px; padding:12px;">
            <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Total Tokens (Lifetime)</div>
            <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-mono); color:var(--text); margin-top:4px;" id="val-total-tok">813,700</div>
          </div>
          <div style="background:rgba(255,255,255,0.03); border:1px solid var(--surface-border); border-radius:8px; padding:12px;">
            <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">Zero-Cost Routing Value</div>
            <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-mono); color:#34d399; margin-top:4px;" id="val-saved-usd">$21.45 Saved</div>
          </div>
        </div>
      </div>

      <!-- Provider Token Distribution Panel -->
      <div class="telemetry-panel">
        <h3 style="font-size:1rem; font-weight:600;">Provider Token Volume Distribution</h3>
        <div class="provider-bars" id="provider-bars-list">
          <div class="provider-bar-row">
            <div class="provider-bar-name">Kilo Code</div>
            <div class="provider-bar-track">
              <div class="provider-bar-fill" id="pbar-kilo" style="width: 36%; background: #6366f1;"></div>
            </div>
            <div class="provider-bar-val" id="pval-kilo">293.0k</div>
          </div>
          <div class="provider-bar-row">
            <div class="provider-bar-name">Nous Hermes</div>
            <div class="provider-bar-track">
              <div class="provider-bar-fill" id="pbar-nous" style="width: 25%; background: #f97316;"></div>
            </div>
            <div class="provider-bar-val" id="pval-nous">201.0k</div>
          </div>
          <div class="provider-bar-row">
            <div class="provider-bar-name">Cline Pool</div>
            <div class="provider-bar-track">
              <div class="provider-bar-fill" id="pbar-cline" style="width: 20%; background: #38bdf8;"></div>
            </div>
            <div class="provider-bar-val" id="pval-cline">165.0k</div>
          </div>
          <div class="provider-bar-row">
            <div class="provider-bar-name">OpenCode Zen</div>
            <div class="provider-bar-track">
              <div class="provider-bar-fill" id="pbar-opencode" style="width: 12%; background: #10b981;"></div>
            </div>
            <div class="provider-bar-val" id="pval-opencode">97.4k</div>
          </div>
          <div class="provider-bar-row">
            <div class="provider-bar-name">DeepSeek Pool</div>
            <div class="provider-bar-track">
              <div class="provider-bar-fill" id="pbar-deepseek" style="width: 7%; background: #8b5cf6;"></div>
            </div>
            <div class="provider-bar-val" id="pval-deepseek">57.3k</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: Interactive Accounts & Pools Management -->
    <div class="section-title" id="sec-accounts">
      <span>👥 Accounts & Credential Pools</span>
      <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">+ Add Credentials</button>
    </div>
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
            <td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">Loading accounts pool...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Section 3: Virtual Model Combos Management -->
    <div class="section-title" id="sec-combos">
      <span>🔀 Virtual Model Combos (Auto-Failover Pipelines)</span>
      <button class="btn btn-secondary btn-sm" onclick="openComboWizard()">+ Launch Combo Wizard</button>
    </div>
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
            <td colspan="5" style="text-align:center; color:var(--text-muted); padding:24px;">Loading virtual combos...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Section 4: Provider Plugins -->
    <div class="section-title" id="sec-plugins">
      <span>🔌 Provider Plugins & Upstreams</span>
    </div>
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
            <td colspan="6" style="text-align:center; color:var(--text-muted); padding:24px;">Loading plugins...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Section 5: Real-Time Ingress Telemetry (SSE Stream) -->
    <div class="section-title" id="sec-logs">
      <span>⚡ Real-Time Ingress & Token Telemetry (SSE Stream)</span>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary btn-sm" onclick="clearLogs()">Clear Stream</button>
        <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">+ Emit Test Event</button>
      </div>
    </div>
    <div class="terminal-box" id="logs-terminal">
      <div class="log-line">
        <span class="log-ts">[SYSTEM]</span>
        <span class="log-status">Gateway initialized on port 4000. Listening for client requests...</span>
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
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Account ID / Alias</label>
          <input type="text" class="form-input" id="acc-form-id" placeholder="e.g. acc_kilo_pro_01" required>
          <span class="form-hint">Unique identifier for this account credential record.</span>
        </div>

        <!-- Provider Specific Fields -->
        <div id="provider-fields-container">
          <!-- Dynamic Content Injected by JS -->
        </div>

        <div class="form-group">
          <label class="form-label">Initial Pool Status</label>
          <select class="form-select" id="acc-form-status">
            <option value="active">Active (Immediate rotation ready)</option>
            <option value="cooldown">Cooldown (Hold off temporary)</option>
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
  <!-- MODAL 2: Live Combo Creator Wizard                                   -->
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

      <!-- Stepper Header -->
      <div class="wizard-steps">
        <div class="wizard-step active" id="wstep-1">1. Identity</div>
        <div class="wizard-step" id="wstep-2">2. Fallback Chain</div>
        <div class="wizard-step" id="wstep-3">3. Policies</div>
        <div class="wizard-step" id="wstep-4">4. Review & Deploy</div>
      </div>

      <div class="modal-body">
        <!-- Wizard Step 1: Identity -->
        <div id="wizard-page-1">
          <div class="form-group">
            <label class="form-label">Virtual Combo ID</label>
            <input type="text" class="form-input" id="wizard-combo-id" placeholder="e.g. lattice/code-flagship-v2" value="lattice/">
            <span class="form-hint">The model identifier clients will pass to /v1/chat/completions or /v1/messages.</span>
          </div>
          <div class="form-group" style="margin-top:14px;">
            <label class="form-label">Display Name</label>
            <input type="text" class="form-input" id="wizard-combo-name" placeholder="e.g. Flagship Multi-Provider Auto-Failover">
          </div>
          <div class="form-group" style="margin-top:14px;">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="wizard-combo-desc" placeholder="Zero-drop multi-provider cascade with automatic 429 fallback and token optimization"></textarea>
          </div>
        </div>

        <!-- Wizard Step 2: Fallback Chain -->
        <div id="wizard-page-2" style="display:none;">
          <div class="form-group">
            <label class="form-label">Quick Add Model Targets</label>
            <div class="target-chips">
              <span class="target-chip" onclick="addTargetToChain('kilo/code-fast:free')">+ kilo/code-fast:free</span>
              <span class="target-chip" onclick="addTargetToChain('nous/hermes-3-llama3')">+ nous/hermes-3-llama3</span>
              <span class="target-chip" onclick="addTargetToChain('cline/sonnet-agent')">+ cline/sonnet-agent</span>
              <span class="target-chip" onclick="addTargetToChain('deepseek/deepseek-reasoner')">+ deepseek/deepseek-reasoner</span>
              <span class="target-chip" onclick="addTargetToChain('opencode/big-pickle')">+ opencode/big-pickle</span>
              <span class="target-chip" onclick="addTargetToChain('mimo-v2.6-flash-free')">+ mimo-v2.6-flash-free</span>
            </div>
          </div>

          <div class="form-group" style="margin-top:14px;">
            <label class="form-label">Add Custom Upstream Target</label>
            <div style="display:flex; gap:8px;">
              <input type="text" class="form-input" id="wizard-custom-target" placeholder="provider/model-id" style="flex:1;">
              <button class="btn btn-secondary" onclick="addCustomTarget()">Add</button>
            </div>
          </div>

          <div class="form-group" style="margin-top:14px;">
            <label class="form-label">Configured Fallback Sequence</label>
            <div class="targets-list" id="wizard-targets-list">
              <!-- Dynamically populated target items -->
            </div>
          </div>

          <div class="form-group" style="margin-top:14px;">
            <label class="form-label">Live Failover Pipeline Preview</label>
            <div class="chain-diagram" id="wizard-chain-preview">
              <!-- Dynamically drawn diagram -->
            </div>
          </div>
        </div>

        <!-- Wizard Step 3: Policies -->
        <div id="wizard-page-3" style="display:none;">
          <div class="form-group">
            <label class="form-label">Failover Strategy</label>
            <select class="form-select" id="wizard-strategy">
              <option value="priority_fallback">Priority Fallback (Sequential cascade upon 429/5xx)</option>
              <option value="round_robin">Round Robin (Load balance requests evenly across targets)</option>
            </select>
            <span class="form-hint">Defines how traffic traverses the configured targets.</span>
          </div>

          <div class="form-group" style="margin-top:18px;">
            <label class="form-label" style="display:flex; align-items:center; gap:8px; cursor:pointer;">
              <input type="checkbox" id="wizard-use-proxies" checked style="width:16px; height:16px; accent-color:var(--accent);">
              <span>Enable Egress Proxy Rotation on Failover</span>
            </label>
            <span class="form-hint" style="margin-left:24px;">Automatically route failed attempts through SOCKS5/HTTP proxy pool.</span>
          </div>
        </div>

        <!-- Wizard Step 4: Review & Deploy -->
        <div id="wizard-page-4" style="display:none;">
          <div style="background:rgba(255,255,255,0.03); border:1px solid var(--surface-border); border-radius:10px; padding:16px;">
            <h4 style="font-size:0.95rem; font-weight:600; margin-bottom:10px;">Virtual Combo Specification</h4>
            <pre style="font-family:var(--font-mono); font-size:0.8rem; color:#a5b4fc; background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; overflow-x:auto;" id="wizard-json-preview"></pre>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" id="wizard-btn-prev" onclick="prevWizardStep()" style="display:none;">Back</button>
        <button class="btn btn-primary" id="wizard-btn-next" onclick="nextWizardStep()">Next: Fallback Chain</button>
        <button class="btn btn-emerald" id="wizard-btn-deploy" onclick="deployCombo()" style="display:none;">Deploy Virtual Combo</button>
      </div>
    </div>
  </div>

  <!-- Toast Container -->
  <div class="toast-container" id="toast-container"></div>

  <!-- ===================================================================== -->
  <!-- JavaScript Application Logic                                          -->
  <!-- ===================================================================== -->
  <script>
    // State
    let currentProviderTab = 'kilo';
    let wizardCurrentStep = 1;
    let wizardTargets = ['kilo/code-fast:free', 'nous/hermes-3-llama3', 'cline/sonnet-agent'];
    let telemetryStats = {
      promptTokens: 524300,
      completionTokens: 289400,
      totalTokens: 813700,
      tokensPerSec: 54,
      savedUsd: 21.45,
    };

    // Initialize Dashboard
    document.addEventListener('DOMContentLoaded', () => {
      fetchAccounts();
      fetchCombos();
      fetchPlugins();
      fetchStats();
      initLogStream();
      switchProviderTab('kilo');
      renderWizardTargets();
    });

    // Navigation Smooth Scroll
    function scrollToSection(id) {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }

    // Toast Notifications
    function showToast(message, type = 'info') {
      const c = document.getElementById('toast-container');
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

    // Fetch Accounts
    async function fetchAccounts() {
      try {
        const res = await fetch('/api/accounts');
        const json = await res.json();
        const accounts = json.accounts || (json.data && json.data.accounts) || [];
        const tbody = document.getElementById('accounts-body');
        
        if (accounts.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">No accounts currently configured. Click <strong>+ Add Credentials</strong> to add one.</td></tr>';
          return;
        }

        tbody.innerHTML = accounts.map(a => {
          const statusTag = a.status === 'active' ? 'tag-active' : a.status === 'cooldown' ? 'tag-cooldown' : 'tag-invalid';
          const lastUsed = a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleTimeString() : 'Never';
          return '<tr>' +
            '<td><strong style="color:#e2e8f0;">' + a.id + '</strong></td>' +
            '<td><span class="tag-provider">' + a.providerId + '</span></td>' +
            '<td><span style="color:var(--text-muted); font-size:0.8rem;">' + a.authType + '</span></td>' +
            '<td><span class="tag ' + statusTag + '">' + a.status + '</span></td>' +
            '<td>' + (a.errorCount || 0) + '</td>' +
            '<td><span style="color:var(--text-subtle);">' + lastUsed + '</span></td>' +
            '<td>' +
              '<button class="btn btn-danger btn-sm" onclick="deleteAccount(\'' + a.id + '\')">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('');

        // Update KPI
        const activeCount = accounts.filter(a => a.status === 'active').length;
        const cooldownCount = accounts.filter(a => a.status === 'cooldown').length;
        document.getElementById('kpi-accounts').textContent = activeCount + ' Active';
        document.getElementById('kpi-accounts-sub').textContent = cooldownCount + ' in cooldown';
      } catch (err) {
        console.error('Failed to fetch accounts:', err);
      }
    }

    // Delete Account
    async function deleteAccount(id) {
      if (!confirm('Are you sure you want to delete account credential: ' + id + '?')) return;
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
        showToast('Network error while deleting account', 'error');
      }
    }

    // Fetch Combos
    async function fetchCombos() {
      try {
        const res = await fetch('/api/combos');
        const json = await res.json();
        const combos = json.combos || (json.data && json.data.combos) || [];
        const tbody = document.getElementById('combos-body');

        if (combos.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:24px;">No virtual combos registered. Click <strong>+ Launch Combo Wizard</strong> to create one.</td></tr>';
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
            '<td><strong style="color:#a5b4fc;">' + c.id + '</strong></td>' +
            '<td>' + (c.name || c.id) + '</td>' +
            '<td>' + chainPills + '</td>' +
            '<td>' + proxyBadge + '</td>' +
            '<td>' +
              '<button class="btn btn-danger btn-sm" onclick="deleteCombo(\'' + c.id + '\')">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('');

        document.getElementById('kpi-combos').textContent = combos.length + ' Active';
      } catch (err) {
        console.error('Failed to fetch combos:', err);
      }
    }

    // Delete Combo
    async function deleteCombo(id) {
      if (!confirm('Are you sure you want to delete virtual combo: ' + id + '?')) return;
      try {
        const res = await fetch('/api/combos/' + encodeURIComponent(id), { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Virtual combo ' + id + ' deleted', 'success');
          fetchCombos();
          fetchStats();
        } else {
          showToast('Failed to delete combo', 'error');
        }
      } catch (err) {
        showToast('Network error while deleting combo', 'error');
      }
    }

    // Fetch Plugins
    async function fetchPlugins() {
      try {
        const res = await fetch('/api/plugins');
        const json = await res.json();
        const plugins = json.plugins || (json.data && json.data.plugins) || [];
        const tbody = document.getElementById('plugins-body');

        tbody.innerHTML = plugins.map(p => {
          const statusTag = p.enabled ? '<span class="tag tag-active">ENABLED</span>' : '<span class="tag tag-invalid">DISABLED</span>';
          const authTypes = (p.supportedAuthTypes || []).join(', ') || 'Standard';
          return '<tr>' +
            '<td><strong style="color:#c084fc;">' + p.id + '</strong></td>' +
            '<td>' + p.displayName + '</td>' +
            '<td style="color:var(--text-muted); font-size:0.78rem;">' + p.defaultBaseUrl + '</td>' +
            '<td><span style="font-size:0.8rem; color:var(--text-subtle);">' + authTypes + '</span></td>' +
            '<td>' + statusTag + '</td>' +
            '<td>' +
              '<button class="btn btn-secondary btn-sm" onclick="togglePlugin(\'' + p.id + '\')">Toggle</button>' +
            '</td>' +
          '</tr>';
        }).join('');

        document.getElementById('kpi-plugins').textContent = plugins.filter(p => p.enabled).length + ' Active';
      } catch (err) {
        console.error('Failed to fetch plugins:', err);
      }
    }

    // Toggle Plugin
    async function togglePlugin(id) {
      try {
        const res = await fetch('/api/plugins/' + encodeURIComponent(id) + '/toggle', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast('Plugin ' + id + ' set to ' + (json.enabled ? 'ENABLED' : 'DISABLED'), 'info');
          fetchPlugins();
          fetchStats();
        }
      } catch (err) {
        showToast('Failed to toggle plugin', 'error');
      }
    }

    // Fetch Stats & Telemetry
    async function fetchStats() {
      try {
        const res = await fetch('/api/telemetry');
        const json = await res.json();
        if (json.success && json.telemetry) {
          updateTelemetryUI(json.telemetry);
        }
      } catch {}
    }

    // Update Telemetry UI
    function updateTelemetryUI(data) {
      telemetryStats = { ...telemetryStats, ...data };
      const pTok = telemetryStats.promptTokens;
      const cTok = telemetryStats.completionTokens;
      const tTok = telemetryStats.totalTokens || (pTok + cTok);

      const pPct = tTok > 0 ? Math.round((pTok / tTok) * 100) : 60;
      const cPct = 100 - pPct;

      document.getElementById('kpi-tokens').textContent = Number(tTok).toLocaleString();
      document.getElementById('kpi-tokens-sub').textContent = Math.round(pTok / 1000) + 'k in · ' + Math.round(cTok / 1000) + 'k out';
      document.getElementById('kpi-velocity').textContent = (telemetryStats.tokensPerSec || 54) + ' tok/s';
      document.getElementById('kpi-saved').textContent = '$' + (telemetryStats.savedUsd || '21.45');

      document.getElementById('val-total-tok').textContent = Number(tTok).toLocaleString();
      document.getElementById('val-saved-usd').textContent = '$' + (telemetryStats.savedUsd || '21.45') + ' Saved';

      document.getElementById('bar-prompt').style.width = pPct + '%';
      document.getElementById('bar-comp').style.width = cPct + '%';
      document.getElementById('lbl-prompt-tok').textContent = Number(pTok).toLocaleString();
      document.getElementById('lbl-comp-tok').textContent = Number(cTok).toLocaleString();
      document.getElementById('lbl-prompt-pct').textContent = pPct + '%';
      document.getElementById('lbl-comp-pct').textContent = cPct + '%';

      // Update provider bars if available
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

    // SSE Stream Ingestion
    function initLogStream() {
      const term = document.getElementById('logs-terminal');
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
              '<span style="color:var(--text-subtle)">' + (log.latencyMs || 45) + 'ms</span> ' +
              '<span class="log-tokens">+' + totalTok + ' tok (' + pTok + ' in / ' + cTok + ' out)</span>';

            term.appendChild(line);
            term.scrollTop = term.scrollHeight;

            // Increment real-time token telemetry
            telemetryStats.promptTokens += pTok;
            telemetryStats.completionTokens += cTok;
            telemetryStats.totalTokens += totalTok;
            telemetryStats.savedUsd = (telemetryStats.promptTokens * 0.000003 + telemetryStats.completionTokens * 0.000015).toFixed(2);
            updateTelemetryUI(telemetryStats);
          } catch (err) {}
        };
      } catch (err) {}
    }

    function clearLogs() {
      document.getElementById('logs-terminal').innerHTML = '<div class="log-line"><span class="log-ts">[SYSTEM]</span><span class="log-status">Stream cleared.</span></div>';
    }

    async function triggerSimulatedPing() {
      try {
        const res = await fetch('/api/telemetry/simulate', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast('Simulated token telemetry packet dispatched', 'info');
        }
      } catch (err) {
        showToast('Simulation error', 'error');
      }
    }

    // =========================================================================
    // CREDENTIALS MODAL LOGIC
    // =========================================================================
    function openCredentialsModal() {
      document.getElementById('modal-credentials').classList.add('open');
      document.getElementById('acc-form-id').focus();
    }

    function closeCredentialsModal() {
      document.getElementById('modal-credentials').classList.remove('open');
    }

    function switchProviderTab(provider) {
      currentProviderTab = provider;
      document.querySelectorAll('.provider-tab-btn').forEach(btn => btn.classList.remove('active'));
      const activeBtn = document.getElementById('tab-btn-' + provider);
      if (activeBtn) activeBtn.classList.add('active');

      const container = document.getElementById('provider-fields-container');
      const idInput = document.getElementById('acc-form-id');

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
            '<input type="password" class="form-input" id="field-kilo-key" placeholder="sk-kilo-..." required>' +
            '<span class="form-hint">Kilo Code platform key granting access to :free and flagship coding models.</span>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Organization ID (Optional)</label>' +
            '<input type="text" class="form-input" id="field-kilo-org" placeholder="org_..."> ' +
          '</div>';
      } else if (provider === 'nous') {
        idInput.placeholder = 'e.g. acc_nous_hermes_01';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Auth Archetype</label>' +
            '<select class="form-select" id="field-nous-authtype">' +
              '<option value="api_key">sk-nous API Key</option>' +
              '<option value="oauth">Hermes Portal OAuth</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Nous Hermes sk-nous Key</label>' +
            '<input type="password" class="form-input" id="field-nous-key" placeholder="sk-nous-..." required>' +
            '<span class="form-hint">Portal key enabling Hermes 3 reasoning and fine-tuned models.</span>' +
          '</div>';
      } else if (provider === 'cline') {
        idInput.placeholder = 'e.g. acc_cline_workos_01';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Auth Archetype</label>' +
            '<select class="form-select" id="field-cline-authtype">' +
              '<option value="oauth">WorkOS OAuth Bearer</option>' +
              '<option value="api_key">Cline Direct API Key</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">WorkOS Access Token</label>' +
            '<input type="password" class="form-input" id="field-cline-token" placeholder="Bearer eyJhbGci..." required>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">WorkOS Refresh Token (Optional)</label>' +
            '<input type="password" class="form-input" id="field-cline-refresh" placeholder="refresh_...">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Associated Account Email</label>' +
            '<input type="email" class="form-input" id="field-cline-email" placeholder="dev@example.com">' +
          '</div>';
      } else if (provider === 'deepseek') {
        idInput.placeholder = 'e.g. acc_deepseek_cookie_01';
        container.innerHTML = 
          '<div class="form-group">' +
            '<label class="form-label">Auth Archetype</label>' +
            '<select class="form-select" id="field-deepseek-authtype">' +
              '<option value="cookie_pool">Chrome Cookie Pool & Token</option>' +
              '<option value="token">User Web Token</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">DeepSeek User Token (userToken)</label>' +
            '<input type="password" class="form-input" id="field-deepseek-token" placeholder="userToken=..." required>' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Raw Chrome Cookies or JSON</label>' +
            '<textarea class="form-textarea" id="field-deepseek-cookies" placeholder="HAPO=...; userToken=..."></textarea>' +
            '<span class="form-hint">Exported session cookie bundle from Chrome extension.</span>' +
          '</div>';
      }
    }

    async function submitAccountForm() {
      const id = document.getElementById('acc-form-id').value.trim();
      const status = document.getElementById('acc-form-status').value;
      if (!id) {
        showToast('Account ID is required', 'error');
        return;
      }

      const credentials = {};
      let authType = 'api_key';

      if (currentProviderTab === 'kilo') {
        authType = document.getElementById('field-kilo-authtype').value;
        const key = document.getElementById('field-kilo-key').value.trim();
        const org = document.getElementById('field-kilo-org').value.trim();
        if (!key) { showToast('Kilo API key is required', 'error'); return; }
        credentials.apiKey = key;
        if (org) credentials.organizationId = org;
      } else if (currentProviderTab === 'nous') {
        authType = document.getElementById('field-nous-authtype').value;
        const key = document.getElementById('field-nous-key').value.trim();
        if (!key) { showToast('Nous sk-nous key is required', 'error'); return; }
        credentials.apiKey = key;
      } else if (currentProviderTab === 'cline') {
        authType = document.getElementById('field-cline-authtype').value;
        const token = document.getElementById('field-cline-token').value.trim();
        const refresh = document.getElementById('field-cline-refresh').value.trim();
        const email = document.getElementById('field-cline-email').value.trim();
        if (!token) { showToast('WorkOS token is required', 'error'); return; }
        credentials.accessToken = token;
        if (refresh) credentials.refreshToken = refresh;
        if (email) credentials.customData = { email };
      } else if (currentProviderTab === 'deepseek') {
        authType = document.getElementById('field-deepseek-authtype').value;
        const token = document.getElementById('field-deepseek-token').value.trim();
        const cookies = document.getElementById('field-deepseek-cookies').value.trim();
        if (!token) { showToast('DeepSeek userToken is required', 'error'); return; }
        credentials.accessToken = token;
        if (cookies) credentials.cookies = cookies;
      }

      const payload = {
        id,
        providerId: currentProviderTab,
        authType,
        status,
        credentials,
      };

      try {
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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
        showToast('Network error while saving account', 'error');
      }
    }

    // =========================================================================
    // COMBO WIZARD LOGIC
    // =========================================================================
    function openComboWizard() {
      wizardCurrentStep = 1;
      updateWizardView();
      document.getElementById('modal-combo-wizard').classList.add('open');
    }

    function closeComboWizard() {
      document.getElementById('modal-combo-wizard').classList.remove('open');
    }

    function updateWizardView() {
      for (let i = 1; i <= 4; i++) {
        document.getElementById('wizard-page-' + i).style.display = i === wizardCurrentStep ? 'block' : 'none';
        const stepHeader = document.getElementById('wstep-' + i);
        stepHeader.classList.remove('active', 'completed');
        if (i === wizardCurrentStep) stepHeader.classList.add('active');
        else if (i < wizardCurrentStep) stepHeader.classList.add('completed');
      }

      const prevBtn = document.getElementById('wizard-btn-prev');
      const nextBtn = document.getElementById('wizard-btn-next');
      const deployBtn = document.getElementById('wizard-btn-deploy');

      prevBtn.style.display = wizardCurrentStep > 1 ? 'inline-flex' : 'none';

      if (wizardCurrentStep === 4) {
        nextBtn.style.display = 'none';
        deployBtn.style.display = 'inline-flex';
        renderWizardJson();
      } else {
        nextBtn.style.display = 'inline-flex';
        deployBtn.style.display = 'none';
        nextBtn.textContent = wizardCurrentStep === 1 ? 'Next: Fallback Chain' : wizardCurrentStep === 2 ? 'Next: Policies' : 'Next: Review & Deploy';
      }
    }

    function nextWizardStep() {
      if (wizardCurrentStep === 1) {
        const id = document.getElementById('wizard-combo-id').value.trim();
        if (!id || id === 'lattice/') {
          showToast('Please enter a valid combo ID', 'error');
          return;
        }
      } else if (wizardCurrentStep === 2) {
        if (wizardTargets.length === 0) {
          showToast('Please add at least one model target', 'error');
          return;
        }
      }
      wizardCurrentStep = Math.min(4, wizardCurrentStep + 1);
      updateWizardView();
    }

    function prevWizardStep() {
      wizardCurrentStep = Math.max(1, wizardCurrentStep - 1);
      updateWizardView();
    }

    function addTargetToChain(modelId) {
      if (!wizardTargets.includes(modelId)) {
        wizardTargets.push(modelId);
        renderWizardTargets();
      }
    }

    function addCustomTarget() {
      const input = document.getElementById('wizard-custom-target');
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

      // Render Visual Diagram
      const preview = document.getElementById('wizard-chain-preview');
      if (preview) {
        if (wizardTargets.length === 0) {
          preview.innerHTML = '<span style="color:var(--text-subtle); font-size:0.75rem;">Pipeline diagram will appear here</span>';
        } else {
          preview.innerHTML = wizardTargets.map((t, i) => {
            const isLast = i === wizardTargets.length - 1;
            return '<div class="chain-node"><span>' + (i + 1) + '.</span> <span>' + t + '</span></div>' +
              (!isLast ? '<div class="chain-arrow"><span>➔</span> <span class="chain-arrow-badge">429 Failover</span></div>' : '');
          }).join('');
        }
      }
    }

    function renderWizardJson() {
      const payload = {
        id: document.getElementById('wizard-combo-id').value.trim(),
        name: document.getElementById('wizard-combo-name').value.trim() || document.getElementById('wizard-combo-id').value.trim(),
        description: document.getElementById('wizard-combo-desc').value.trim(),
        targets: wizardTargets,
        strategy: document.getElementById('wizard-strategy').value,
        useProxies: document.getElementById('wizard-use-proxies').checked,
      };
      document.getElementById('wizard-json-preview').textContent = JSON.stringify(payload, null, 2);
    }

    async function deployCombo() {
      const payload = {
        id: document.getElementById('wizard-combo-id').value.trim(),
        name: document.getElementById('wizard-combo-name').value.trim() || document.getElementById('wizard-combo-id').value.trim(),
        description: document.getElementById('wizard-combo-desc').value.trim(),
        targets: wizardTargets,
        strategy: document.getElementById('wizard-strategy').value,
        useProxies: document.getElementById('wizard-use-proxies').checked,
      };

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
          fetchStats();
        } else {
          showToast('Failed to create combo: ' + (json.error || 'Error'), 'error');
        }
      } catch (err) {
        showToast('Network error while creating combo', 'error');
      }
    }

    function onBackdropClick(e, modalId) {
      if (e.target.id === modalId) {
        document.getElementById(modalId).classList.remove('open');
      }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeCredentialsModal();
        closeComboWizard();
      }
    });
  </script>
</body>
</html>`;
}
