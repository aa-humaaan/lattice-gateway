export interface GatewayConfig {
  port: number;
  host: string;
  env: 'development' | 'production' | 'test';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  defaultKeepaliveMs: number;
  corsOrigins: string[];
  dataDir?: string;
  dbPath?: string;
  upstreamUrl?: string;
}

export function loadConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    port: Number(process.env.PORT || overrides?.port || 4000),
    host: process.env.HOST || overrides?.host || '0.0.0.0',
    env: (process.env.NODE_ENV as GatewayConfig['env']) || overrides?.env || 'development',
    logLevel: (process.env.LOG_LEVEL as GatewayConfig['logLevel']) || overrides?.logLevel || 'info',
    defaultKeepaliveMs: Number(process.env.KEEPALIVE_MS || overrides?.defaultKeepaliveMs || 15000),
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : overrides?.corsOrigins || ['*'],
    dataDir: process.env.DATA_DIR || overrides?.dataDir,
    dbPath: process.env.DB_PATH || overrides?.dbPath,
    upstreamUrl: process.env.UPSTREAM_URL || overrides?.upstreamUrl,
  };
}
