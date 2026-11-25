import { createServer } from './core/server';
import { loadConfig } from './core/config';
import { logger } from './utils/logger';
import { globalPluginRegistry } from './plugins/registry';
import { globalAccountPool } from './pool/account-pool';
import { globalComboManager } from './pool/combos';
import { globalStorage } from './pool/storage';
import { loadOrCreateAuthTokens, tokenBannerLines } from './core/auth-tokens';
import { formatPortConflict } from './utils/port-error';
import { initializeFromManifest, shutdownFromManifest } from './core/plugin-lifecycle';
import { fileURLToPath } from 'url';

import { KiloProviderPlugin } from './plugins/kilo';
import { NousProviderPlugin } from './plugins/nous';
import { ClinePoolPlugin } from './plugins/cline';
import { DeepSeekPoolPlugin } from './plugins/deepseek';
import { LatticeComboPlugin } from './plugins/combo';

// 1. Load persistent accounts, combos, and proxy configs
globalStorage.load();

// 2. Instantiate the still-hardcoded plugins; OpenCode comes from its manifest.
const kiloPlugin = new KiloProviderPlugin();
const nousPlugin = new NousProviderPlugin();
const clinePlugin = new ClinePoolPlugin();
const deepseekPlugin = new DeepSeekPoolPlugin();
const comboPlugin = new LatticeComboPlugin();

const manifestDir = fileURLToPath(new URL('./plugins/manifests', import.meta.url));
await globalPluginRegistry.loadManifestsFrom(manifestDir);
const opencodePlugin = globalPluginRegistry.get('opencode') as any;

// Wire accounts from global pool into plugins
for (const acc of globalAccountPool.listAccounts()) {
  if (acc.providerId === 'kilo') kiloPlugin.addAccount(acc);
  if (acc.providerId === 'nous') nousPlugin.addAccount(acc);
  if (acc.providerId === 'cline') clinePlugin.addAccount(acc);
  if (acc.providerId === 'deepseek') deepseekPlugin.addAccount(acc);
  if (acc.providerId === 'opencode') opencodePlugin.setAccount(acc);
}

globalPluginRegistry.register(kiloPlugin);
globalPluginRegistry.register(nousPlugin);
globalPluginRegistry.register(clinePlugin);
globalPluginRegistry.register(deepseekPlugin);
globalPluginRegistry.register(comboPlugin);

function parseArgs() {
  const args = process.argv.slice(2);
  const overrides: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) overrides.port = val;
    } else if (arg === '--host' || arg === '-h') {
      overrides.host = args[++i];
    }
  }
  return overrides;
}

// 3. Load local bearer tokens, then create Gateway server with all registered plugins
const overrides = parseArgs();
const authTokens = loadOrCreateAuthTokens(overrides.dataDir || process.env.DATA_DIR || 'data');
const config = loadConfig({
  ...overrides,
  gatewayToken: authTokens.gatewayToken,
  adminToken: authTokens.adminToken,
});
const pluginInstances = globalPluginRegistry.getAll();
await initializeFromManifest(globalPluginRegistry, { dataDir: config.dataDir || 'data', logger });
const app = createServer(config, pluginInstances);

let server: any;
try {
  server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
    idleTimeout: 255,
  });
} catch (err: any) {
  const isPortError =
    err?.code === 'EADDRINUSE' ||
    String(err).includes('EADDRINUSE') ||
    String(err.message || '').toLowerCase().includes('port');

  if (isPortError) {
    logger.error(formatPortConflict(config.port, err));
    logger.error(`Identify the owner yourself, or start Lattice on another port: bun run src/index.ts --port ${config.port + 1}`);
  } else {
    logger.error(`Failed to start server: ${err.message}`);
  }
  process.exit(1);
}

const displayHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;

console.log(`
========================================================================
  🚀 PROJECT LATTICE GATEWAY v1.0 — UNIVERSAL LLM HARNESS & POOL
========================================================================
  Endpoint:         http://${displayHost}:${server.port}
  OpenAI Ingress:   http://${displayHost}:${server.port}/v1/chat/completions
  Anthropic Stream: http://${displayHost}:${server.port}/v1/messages
  Models Catalog:   http://${displayHost}:${server.port}/v1/models
  Admin Dashboard:  http://${displayHost}:${server.port}/admin
========================================================================
${tokenBannerLines(config)}
 ========================================================================
  Active Plugins:   kilo, nous, cline, opencode, deepseek
  Virtual Combos:   lattice/code-flagship, lattice/fast-free
  Storage Path:     data/lattice-store.json
========================================================================
`);

const shutdown = async () => {
  await shutdownFromManifest(globalPluginRegistry);
  try { server.stop(); } catch {}
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

export { app, server };
