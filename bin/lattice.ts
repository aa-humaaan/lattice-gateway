#!/usr/bin/env bun
import { createServer } from '../src/core/server';
import { loadConfig, GatewayConfig } from '../src/core/config';
import { logger } from '../src/utils/logger';

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

const overrides = parseArgs();
const config = loadConfig(overrides);
const app = createServer(config);

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
});

logger.info(`Lattice Gateway listening at http://${config.host}:${server.port}`);
logger.info(`Ready for incoming OpenAI, Anthropic, and Responses traffic.`);
