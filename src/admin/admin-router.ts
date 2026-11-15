import { Hono } from 'hono';
import { globalAccountPool } from '../pool/account-pool';
import { globalComboManager } from '../pool/combos';
import { globalProxyPool } from '../pool/proxy-pool';
import { globalPluginRegistry } from '../plugins/registry';
import { globalStorage } from '../pool/storage';

export interface LogEvent {
  timestamp: number;
  method: string;
  path: string;
  provider: string;
  model: string;
  status: number;
  latencyMs: number;
}

// In-memory ring buffer & subscriber list for real-time SSE telemetry
const recentLogs: LogEvent[] = [];
const logSubscribers = new Set<(log: LogEvent) => void>();

export function broadcastLog(log: LogEvent): void {
  recentLogs.unshift(log);
  if (recentLogs.length > 500) recentLogs.pop();
  for (const sub of logSubscribers) {
    try {
      sub(log);
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
    globalAccountPool.addAccount(body);
    globalStorage.save();
    return c.json({ success: true, message: `Account ${body.id} added`, account: body });
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
    const combos = globalComboManager.listCombos();
    return c.json({
      success: true,
      data: {
        total: combos.length,
        combos,
      },
    });
  });

  router.post('/api/combos', async (c) => {
    const body = (await c.req.json()) as any;
    if (!body.id || !body.targets || !Array.isArray(body.targets)) {
      return c.json({ success: false, error: 'Invalid combo specification' }, 400);
    }
    globalComboManager.createCombo({
      id: body.id,
      name: body.name || body.id,
      targets: body.targets,
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
    return c.json({ success: true, data: { total: plugins.length, plugins } });
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
  // Real-Time SSE Log Streaming
  // --------------------------------------------------------------------------
  router.get('/api/logs/stream', (c) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send initial connection burst of recent logs
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
        : 0;
    return c.json({
      success: true,
      stats: {
        totalRequests,
        averageLatencyMs: avgLatency,
        activeAccounts: globalAccountPool.listAccounts().filter((a) => a.status === 'active').length,
        cooldownAccounts: globalAccountPool.listAccounts().filter((a) => a.status === 'cooldown').length,
        registeredPlugins: globalPluginRegistry.getAll().length,
        activeCombos: globalComboManager.listCombos().length,
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
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090a0f;
      --surface: rgba(18, 22, 34, 0.75);
      --surface-border: rgba(255, 255, 255, 0.08);
      --surface-hover: rgba(255, 255, 255, 0.04);
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.25);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font-sans: 'Space Grotesk', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.1) 0px, transparent 50%);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
    }

    /* Sidebar Navigation */
    aside {
      width: 260px;
      background: rgba(10, 13, 22, 0.9);
      border-right: 1px solid var(--surface-border);
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      backdrop-filter: blur(16px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 8px;
    }
    .brand-logo {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent), #8b5cf6);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #fff;
      box-shadow: 0 0 16px var(--accent-glow);
    }
    .brand-title {
      font-weight: 700;
      font-size: 1.1rem;
      letter-spacing: -0.02em;
    }
    .brand-badge {
      font-size: 0.7rem;
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(99, 102, 241, 0.3);
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-link {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 500;
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .nav-link:hover, .nav-link.active {
      color: var(--text);
      background: var(--surface-hover);
    }
    .nav-link.active {
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.25);
    }

    /* Main Workspace */
    main {
      flex: 1;
      padding: 32px;
      overflow-y: auto;
      max-width: 1400px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.03em;
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
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 20px;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }
    .kpi-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .kpi-val {
      font-size: 1.8rem;
      font-weight: 700;
      font-family: var(--font-mono);
    }

    /* Sections */
    .section-title {
      font-size: 1.2rem;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .glass-panel {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      backdrop-filter: blur(16px);
      overflow: hidden;
      margin-bottom: 32px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.9rem;
    }
    th {
      background: rgba(255, 255, 255, 0.02);
      padding: 14px 18px;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--surface-border);
    }
    td {
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-family: var(--font-mono);
      font-size: 0.85rem;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface-hover); }

    .tag {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
      display: inline-block;
    }
    .tag-active { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .tag-cooldown { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .tag-free { background: rgba(99, 102, 241, 0.15); color: #818cf8; }

    /* Live Terminal Log Stream */
    .terminal-box {
      background: #050608;
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      max-height: 280px;
      overflow-y: auto;
      line-height: 1.6;
    }
    .log-line {
      display: flex;
      gap: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.02);
      padding: 4px 0;
    }
    .log-ts { color: var(--text-muted); }
    .log-method { color: #38bdf8; font-weight: 600; }
    .log-status { color: #34d399; }
    .log-provider { color: #c084fc; }
  </style>
</head>
<body>
  <aside>
    <div class="brand">
      <div class="brand-logo">L</div>
      <div>
        <div class="brand-title">Lattice Gateway</div>
        <div class="brand-badge">Universal Harness v1.0</div>
      </div>
    </div>
    <nav>
      <a class="nav-link active">📊 Mission Control</a>
      <a class="nav-link">🔌 Plugins & Providers</a>
      <a class="nav-link">👥 Accounts & Pools</a>
      <a class="nav-link">🔀 Virtual Combos</a>
      <a class="nav-link">🛡️ Egress Proxies</a>
    </nav>
  </aside>

  <main>
    <header>
      <div>
        <h1>Mission Control</h1>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">Universal Multi-Provider LLM Gateway & Account Pool Engine</p>
      </div>
      <div class="status-pill">
        <div class="status-dot"></div>
        <span>Core Operational :4000</span>
      </div>
    </header>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Active Plugins</div>
        <div class="kpi-val" id="kpi-plugins">5 Active</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active Accounts</div>
        <div class="kpi-val" id="kpi-accounts">Healthy</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Average Latency</div>
        <div class="kpi-val" id="kpi-latency">~120ms</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Virtual Combos</div>
        <div class="kpi-val" id="kpi-combos">2 Active</div>
      </div>
    </div>

    <div class="section-title">
      <span>Active Provider Plugins</span>
    </div>
    <div class="glass-panel">
      <table>
        <thead>
          <tr>
            <th>Plugin ID</th>
            <th>Provider Name</th>
            <th>Default Base URL</th>
            <th>Auth Types</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="plugins-body">
          <tr>
            <td>kilo</td>
            <td>Kilo Code Upstream</td>
            <td>https://ai-gateway.kilo.ai/api/v1</td>
            <td>OAuth, API Key</td>
            <td><span class="tag tag-active">ENABLED</span></td>
          </tr>
          <tr>
            <td>nous</td>
            <td>Nous Research Hermes</td>
            <td>https://inference-api.nousresearch.com/v1</td>
            <td>Portal OAuth, Bearer</td>
            <td><span class="tag tag-active">ENABLED</span></td>
          </tr>
          <tr>
            <td>cline</td>
            <td>Cline Pool Upstream</td>
            <td>https://api.cline.bot/v1</td>
            <td>WorkOS OAuth, API Key</td>
            <td><span class="tag tag-active">ENABLED</span></td>
          </tr>
          <tr>
            <td>opencode</td>
            <td>OpenCode Zen Provider</td>
            <td>https://opencode.ai/inference</td>
            <td>Keyless Anonymous, uTLS</td>
            <td><span class="tag tag-active">ENABLED</span></td>
          </tr>
          <tr>
            <td>deepseek</td>
            <td>DeepSeek Web Pool</td>
            <td>https://chat.deepseek.com/api/v0</td>
            <td>Chrome Cookies, Tokens</td>
            <td><span class="tag tag-active">ENABLED</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-title">
      <span>Real-Time Ingress Telemetry (SSE Stream)</span>
    </div>
    <div class="terminal-box" id="logs-terminal">
      <div class="log-line">
        <span class="log-ts">[SYSTEM]</span>
        <span class="log-status">Gateway initialized on port 4000. Listening for client requests...</span>
      </div>
    </div>
  </main>

  <script>
    // Live SSE connection to /api/logs/stream
    const term = document.getElementById('logs-terminal');
    try {
      const sse = new EventSource('/api/logs/stream');
      sse.onmessage = (e) => {
        try {
          const log = JSON.parse(e.data);
          const line = document.createElement('div');
          line.className = 'log-line';
          line.innerHTML = '<span class="log-ts">[' + new Date(log.timestamp).toLocaleTimeString() + ']</span> ' +
            '<span class="log-method">' + log.method + '</span> ' +
            '<span>' + log.path + '</span> ' +
            '<span class="log-provider">(' + log.provider + '/' + log.model + ')</span> ' +
            '<span class="log-status">' + log.status + ' OK</span> ' +
            '<span style="color:var(--text-muted)">' + log.latencyMs + 'ms</span>';
          term.appendChild(line);
          term.scrollTop = term.scrollHeight;
        } catch {}
      };
    } catch {}
  </script>
</body>
</html>`;
}
