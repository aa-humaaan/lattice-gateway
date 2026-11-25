/**
 * Boundary check for operator-supplied upstream URLs. Blocks private,
 * link-local and non-HTTP targets so a crafted account cannot turn the
 * gateway into a proxy for cloud metadata or internal services. DNS names
 * that resolve privately after this check are out of scope for v1.
 */
export function isSafeUpstreamBaseUrl(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  // URL normalizes decimal/octal/hex IPv4 to dotted form; comparing the raw
  // host to the normalized one closes those bypasses. IPv4-mapped IPv6 is
  // rejected outright because it can hide private targets behind a v6 literal.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const rawHost = value.match(/^[a-z]+:\/\/([^/?#@]+)/i)?.[1]?.toLowerCase();
  if (rawHost && rawHost !== host && /^[0-9a-fx.]+$/.test(rawHost)) return false;
  if (/^::ffff:/i.test(host)) return false;
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol === 'http:' && !loopback) return false;
  if (/\.(local|internal|localhost)$/.test(host)) return false;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 0) return false;
    if (a === 127 && host !== '127.0.0.1') return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (/^(fc|fd|fe[89ab])/i.test(host) || host === '::' ) return false;
  return true;
}

/**
 * Classify an address returned by DNS before an upstream fetch. The URL check
 * above only sees a hostname; this closes the gap where a public-looking name
 * resolves into private, loopback, link-local, ULA or multicast space. Unknown
 * formats fail closed; well-formed global IPv6 is allowed.
 */
export function isPrivateResolvedAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^::ffff:/i.test(ip) || ip === '::1' || ip === '::') return true;
  if (/^(fc|fd|fe[89ab])/i.test(ip)) return true;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return !/^[0-9a-f:]+$/i.test(ip);
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 0 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export interface GatewayConfig {
  port: number;
  host: string;
  env: 'development' | 'production' | 'test';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  defaultKeepaliveMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  defaultIdleTimeoutMs: number;
  defaultRequestTimeoutMs: number;
  corsOrigins: string[];
  /** Bearer token required on /v1/* when set. Generated at the application entrypoint. */
  gatewayToken?: string;
  /** Bearer token required on /api/* and /admin when set. */
  adminToken?: string;
  /** Reject request bodies larger than this many bytes with 413. */
  maxBodyBytes?: number;
  dataDir?: string;
  dbPath?: string;
  upstreamUrl?: string;
}

export function loadConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  const requestTimeoutMs = Number(
    process.env.REQUEST_TIMEOUT_MS ||
      overrides?.requestTimeoutMs ||
      overrides?.defaultRequestTimeoutMs ||
      1800000
  );
  const idleTimeoutMs = Number(
    process.env.IDLE_TIMEOUT_MS ||
      overrides?.idleTimeoutMs ||
      overrides?.defaultIdleTimeoutMs ||
      120000
  );

  return {
    port: Number(process.env.PORT || overrides?.port || 4000),
    host: process.env.HOST || overrides?.host || '127.0.0.1',
    env: (process.env.NODE_ENV as GatewayConfig['env']) || overrides?.env || 'development',
    logLevel: (process.env.LOG_LEVEL as GatewayConfig['logLevel']) || overrides?.logLevel || 'info',
    defaultKeepaliveMs: Number(process.env.KEEPALIVE_MS || overrides?.defaultKeepaliveMs || 15000),
    requestTimeoutMs,
    idleTimeoutMs,
    defaultIdleTimeoutMs: idleTimeoutMs,
    defaultRequestTimeoutMs: requestTimeoutMs,
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : overrides?.corsOrigins || ['http://127.0.0.1:4000', 'http://localhost:4000'],
    gatewayToken: process.env.LATTICE_GATEWAY_TOKEN || overrides?.gatewayToken,
    adminToken: process.env.LATTICE_ADMIN_TOKEN || overrides?.adminToken,
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES || overrides?.maxBodyBytes || 10_000_000),
    dataDir: overrides?.dataDir || process.env.DATA_DIR,
    dbPath: process.env.DB_PATH || overrides?.dbPath,
    upstreamUrl: process.env.UPSTREAM_URL || overrides?.upstreamUrl,
  };
}
