import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig, GatewayConfig } from './config';
import { registerRoutes } from './router';
import { ProviderPlugin } from './types/plugin';
import { GatewayError, serializeDialectError } from './types/errors';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export interface ServerContext {
  config: GatewayConfig;
  plugins: Map<string, ProviderPlugin>;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function createServer(
  customConfig?: Partial<GatewayConfig>,
  plugins?: ProviderPlugin[]
): Hono<AppEnv> {
  const config = loadConfig(customConfig);
  const app = new Hono<AppEnv>();

  const pluginMap = new Map<string, ProviderPlugin>();
  if (plugins && plugins.length > 0) {
    for (const plugin of plugins) {
      pluginMap.set(plugin.id, plugin);
    }
  } else {
    // If no plugin provided, dynamically load default mock provider for Milestone 1
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MockProviderPlugin } = require('../../tests/mocks/mock-provider');
      const mockPlugin = new MockProviderPlugin();
      pluginMap.set(mockPlugin.id, mockPlugin);
    } catch {
      // Mock provider not yet mounted or not required
    }
  }

  // Request ID & Tracing Middleware
  app.use('*', async (c, next) => {
    const reqId =
      c.req.header('x-request-id') ||
      `req_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    c.set('requestId', reqId);
    c.header('x-request-id', reqId);
    await next();
  });

  // Browser-origin guard. A gateway bound to loopback is still reachable from
  // any web page the operator visits; requiring an explicit Origin stops that.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (
      origin &&
      !config.corsOrigins.includes('*') &&
      !config.corsOrigins.includes(origin) &&
      !isLoopbackOrigin(origin)
    ) {
      return c.json({ error: { type: 'forbidden', message: 'Origin not allowed' } }, 403);
    }
    await next();
  });

  // CORS Middleware
  const corsOrigin = config.corsOrigins.includes('*') ? '*' : config.corsOrigins;
  app.use(
    '*',
    cors({
      origin: corsOrigin,
      allowHeaders: ['*'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['x-request-id', 'content-type', 'retry-after'],
    })
  );

  // Reject oversized bodies before the router buffers them. A declared
  // Content-Length is checked first; otherwise count bytes while draining the
  // stream (chunked bodies). The buffered body is reattached for downstream
  // handlers, which is safe because it was fully read here.
  app.use('*', async (c, next) => {
    const maxBytes = config.maxBodyBytes || 10_000_000;
    const tooLarge = () =>
      c.json({ error: { type: 'payload_too_large', message: 'Request body too large' } }, 413);
    const declared = Number(c.req.header('content-length') || 0);
    if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

    if ((!Number.isFinite(declared) || declared === 0) && c.req.raw.body) {
      const reader = c.req.raw.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) return tooLarge();
        chunks.push(value);
      }
      const buffered = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buffered.set(chunk, offset);
        offset += chunk.byteLength;
      }
      (c.req as any).raw = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: buffered,
        signal: c.req.raw.signal,
      });
    }
    await next();
  });

  // Authentication. Tokens are optional at the library level (in-process
  // tests and embeddings use createServer directly); the shipped entrypoints
  // always generate and pass them, so the running gateway is always locked.
  const PUBLIC_PATHS = new Set([
    '/healthz', '/health', '/api/health', '/status', '/api/status',
    '/admin/api/status', '/v1/health', '/live',
    // The dashboard shell is static HTML; its data APIs stay authenticated.
    '/admin',
  ]);

  app.use('*', async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();

    const path = c.req.path;
    const isAdmin = path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/');
    const required = isAdmin
      ? config.adminToken || config.gatewayToken
      : config.gatewayToken;
    if (!required) return next();

    const authHeader = c.req.header('authorization') || '';
    const provided =
      (authHeader.match(/^Bearer\s+(.+)$/i)?.[1] || '').trim() ||
      c.req.header('x-api-key') ||
      '';

    if (provided !== required) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json(
        { error: { type: 'authentication_error', message: 'Unauthorized' } },
        401
      );
    }
    await next();
  });

  // Global Error Handler
  app.onError((err, c) => {
    const reqId = (c.get('requestId') as string) || 'req_err';
    const path = c.req.path;
    const dialect = path.startsWith('/v1/messages')
      ? 'anthropic'
      : path.startsWith('/v1/responses')
      ? 'responses'
      : 'openai';

    const headers: Record<string, string> = {
      'x-request-id': reqId,
    };

    if (err instanceof GatewayError) {
      const errorPayload = serializeDialectError(err, dialect);
      if (err.retryAfter) {
        headers['retry-after'] = String(err.retryAfter);
      }
      return c.json(errorPayload, err.statusCode as any, headers);
    }

    // Uncaught exception / unexpected error
    const genericError = new GatewayError(
      500,
      'internal_server_error',
      err.message || 'An unexpected internal error occurred in Project Lattice',
      { reqId }
    );
    return c.json(serializeDialectError(genericError, dialect), 500, headers);
  });

  // 404 Not Found Handler
  app.notFound((c) => {
    const reqId = (c.get('requestId') as string) || 'req_404';
    const path = c.req.path;
    const dialect = path.startsWith('/v1/messages') ? 'anthropic' : 'openai';
    const notFoundError = new GatewayError(
      404,
      'not_found_error',
      `Route ${c.req.method} ${path} was not found on Project Lattice Gateway`
    );
    return c.json(serializeDialectError(notFoundError, dialect), 404, {
      'x-request-id': reqId,
    });
  });

  // Mount Ingress Routes
  registerRoutes(app, { config, plugins: pluginMap });

  return app;
}
