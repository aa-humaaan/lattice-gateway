import { createServer } from './core/server';
import { loadConfig } from './core/config';
import { logger } from './utils/logger';
import { globalPluginRegistry } from './plugins/registry';
import { globalAccountPool } from './pool/account-pool';
import { globalComboManager } from './pool/combos';
import { globalStorage } from './pool/storage';

import { KiloProviderPlugin } from './plugins/kilo';
import { NousProviderPlugin } from './plugins/nous';
import { ClinePoolPlugin } from './plugins/cline';
import { OpenCodeProviderPlugin } from './plugins/opencode';
import { DeepSeekPoolPlugin } from './plugins/deepseek';

// 1. Load persistent accounts, combos, and proxy configs
globalStorage.load();

// 2. Instantiate and register the 5 primary upstream plugins
const kiloPlugin = new KiloProviderPlugin();
const nousPlugin = new NousProviderPlugin();
const clinePlugin = new ClinePoolPlugin();
const opencodePlugin = new OpenCodeProviderPlugin();
const deepseekPlugin = new DeepSeekPoolPlugin();

// Wire accounts from global pool into plugins
for (const acc of globalAccountPool.listAccounts()) {
  if (acc.providerId === 'kilo') kiloPlugin.setAccount(acc);
  if (acc.providerId === 'nous') nousPlugin.setAccount(acc);
  if (acc.providerId === 'cline') clinePlugin.addAccount(acc);
  if (acc.providerId === 'deepseek') deepseekPlugin.addAccount(acc);
}

globalPluginRegistry.register(kiloPlugin);
globalPluginRegistry.register(nousPlugin);
globalPluginRegistry.register(clinePlugin);
globalPluginRegistry.register(opencodePlugin);
globalPluginRegistry.register(deepseekPlugin);

// 3. Create Gateway server with all registered plugins
const config = loadConfig();
const app = createServer(config, globalPluginRegistry.getAll());

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
});

console.log(`
========================================================================
  🚀 PROJECT LATTICE GATEWAY v1.0 — UNIVERSAL LLM HARNESS & POOL
========================================================================
  Endpoint:         http://${config.host}:${server.port}
  OpenAI Ingress:   http://${config.host}:${server.port}/v1/chat/completions
  Anthropic Stream: http://${config.host}:${server.port}/v1/messages
  Models Catalog:   http://${config.host}:${server.port}/v1/models
  Admin Dashboard:  http://${config.host}:${server.port}/admin
========================================================================
  Active Plugins:   kilo, nous, cline, opencode, deepseek
  Virtual Combos:   lattice/code-flagship, lattice/fast-free
  Storage Path:     data/lattice-store.json
========================================================================
`);

export { app, server };
