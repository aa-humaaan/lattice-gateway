#!/usr/bin/env bun
import { createServer } from '../src/core/server';
import { loadConfig, GatewayConfig } from '../src/core/config';
import { logger } from '../src/utils/logger';
import { globalPluginRegistry } from '../src/plugins/registry';
import { globalAccountPool } from '../src/pool/account-pool';
import { globalComboManager } from '../src/pool/combos';
import { globalStorage } from '../src/pool/storage';

import { KiloProviderPlugin } from '../src/plugins/kilo';
import { NousProviderPlugin } from '../src/plugins/nous';
import { ClinePoolPlugin } from '../src/plugins/cline';
import { OpenCodeProviderPlugin } from '../src/plugins/opencode';
import { DeepSeekPoolPlugin } from '../src/plugins/deepseek';
import { LatticeComboPlugin } from '../src/plugins/combo';

function parseArgs(): Partial<GatewayConfig> {
  const args = process.argv.slice(2);
  const overrides: Partial<GatewayConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) overrides.port = val;
    } else if (arg === '--host' || arg === '-h') {
      overrides.host = args[++i];
    } else if (arg === '--env') {
      overrides.env = args[++i] as GatewayConfig['env'];
    } else if (arg === '--log-level') {
      overrides.logLevel = args[++i] as GatewayConfig['logLevel'];
    }
  }

  return overrides;
}

const banner = `
======================================================
  ____            _           _     _          _   _   _          
 |  _ \\ _ __ ___ (_) ___  ___| |_  | |    __ _| |_| |_(_) ___ ___ 
 | |_) | '__/ _ \\| |/ _ \\/ __| __| | |   / _\` | __| __| |/ __/ _ \\
 |  __/| | | (_) | |  __/ (__| |_  | |__| (_| | |_| |_| | (_|  __/
 |_|   |_|  \\___// |\\___|\\___|\\__| |_____\\__,_|\\__|\\__|_|\\___\\___|
               |__/                                               
               Universal Extensible LLM Gateway & Harness
======================================================
`;

console.log(banner);

// 1. Load persistent accounts, combos, and proxy configs
globalStorage.load();

// 2. Instantiate and register the 5 primary upstream plugins
const kiloPlugin = new KiloProviderPlugin();
const nousPlugin = new NousProviderPlugin();
const clinePlugin = new ClinePoolPlugin();
const opencodePlugin = new OpenCodeProviderPlugin();
const deepseekPlugin = new DeepSeekPoolPlugin();
const comboPlugin = new LatticeComboPlugin();

// Wire accounts from global pool into plugins
for (const acc of globalAccountPool.listAccounts()) {
  if (acc.providerId === 'kilo') kiloPlugin.setAccount(acc);
  if (acc.providerId === 'nous') nousPlugin.setAccount(acc);
  if (acc.providerId === 'cline') clinePlugin.addAccount(acc);
  if (acc.providerId === 'deepseek') deepseekPlugin.addAccount(acc);
  if (acc.providerId === 'opencode') opencodePlugin.setAccount(acc);
}

globalPluginRegistry.register(kiloPlugin);
globalPluginRegistry.register(nousPlugin);
globalPluginRegistry.register(clinePlugin);
globalPluginRegistry.register(opencodePlugin);
globalPluginRegistry.register(deepseekPlugin);
globalPluginRegistry.register(comboPlugin);

const overrides = parseArgs();
const config = loadConfig(overrides);
const app = createServer(config, globalPluginRegistry.getAll());

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
});

logger.info(`Lattice Gateway listening at http://${config.host}:${server.port}`);
logger.info(`Ready for incoming OpenAI, Anthropic, and Responses traffic.`);
