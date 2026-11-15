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
