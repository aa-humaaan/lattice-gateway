import { Hono } from 'hono';
import { ServerContext, AppEnv } from './server';
import {
  normalizeOpenAIChat,
  normalizeAnthropicMessages,
  normalizeOpenAIResponses,
} from '../engine/dialect/normalizer';
import {
  serializeOpenAIChat,
  serializeAnthropicMessage,
  serializeOpenAIResponse,
} from '../engine/dialect/serializer';
import {
  createOpenAISSEStream,
  createAnthropicSSEStream,
} from '../engine/dialect/stream-adapter';
import { createXMLToolInterceptor } from '../engine/dialect/xml-tool-interceptor';
import { GatewayError } from './types/errors';
import { ProviderPlugin } from './types/plugin';
import { createAdminRouter, broadcastLog } from '../admin/admin-router';

export function registerRoutes(app: Hono<AppEnv>, context: ServerContext): void {
  const { config, plugins } = context;

  // Mount Admin Dashboard & Management REST APIs
  app.route('/', createAdminRouter());

  // --------------------------------------------------------------------------
  // Liveness & Health Probes
  // --------------------------------------------------------------------------
  app.get('/healthz', (c) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      version: '0.1.0',
      timestamp: Date.now(),
    });
  });

  app.get('/live', (c) => {
    return c.json({ live: true });
  });

  // --------------------------------------------------------------------------
  // GET /v1/models (Aggregated Model Catalog)
  // --------------------------------------------------------------------------
  app.get('/v1/models', async (c) => {
    const models = [];
    for (const plugin of plugins.values()) {
      const pluginModels = await plugin.listModels();
      models.push(...pluginModels);
    }

    return c.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: m.created || 1731693600,
        owned_by: m.ownedBy || m.providerId || 'lattice',
        permission: [],
        root: m.id,
        parent: null,
      })),
    });
  });

  // --------------------------------------------------------------------------
  // Model Catalog Cache & Provider Resolution
  // --------------------------------------------------------------------------
  interface CachedModelCatalog {
    timestamp: number;
    modelToPlugin: Map<string, ProviderPlugin>;
  }
  let catalogCache: CachedModelCatalog | null = null;
  const CATALOG_CACHE_TTL_MS = 60_000; // 60s TTL

  async function getModelPluginMap(): Promise<Map<string, ProviderPlugin>> {
    const now = Date.now();
    if (catalogCache && now - catalogCache.timestamp < CATALOG_CACHE_TTL_MS) {
      return catalogCache.modelToPlugin;
    }

    const map = new Map<string, ProviderPlugin>();
    for (const plugin of plugins.values()) {
      try {
        const models = await plugin.listModels();
        for (const m of models) {
          map.set(m.id, plugin);
          // If model has a vendor prefix (e.g., "kilo/claude-3-7-sonnet"),
          // also map the bare model name if unambiguous
          if (m.id.includes('/')) {
            const bareName = m.id.split('/').slice(1).join('/');
            if (!map.has(bareName)) {
              map.set(bareName, plugin);
            }
          }
        }
      } catch {
        // Suppress individual plugin catalog lookup failures during cache build
      }
    }

    catalogCache = { timestamp: now, modelToPlugin: map };
    return map;
  }

  // Helper to resolve provider plugin for requested model
  async function resolveProvider(modelId: string): Promise<ProviderPlugin> {
    if (plugins.size === 0) {
      throw new GatewayError(
        503,
        'service_unavailable',
        'No provider plugins are currently registered or active'
      );
    }

    // In single-provider environments (e.g. M1 mock provider dev/test),
    // route directly to the active provider.
    if (plugins.size === 1) {
      return plugins.values().next().value!;
    }

    // 1. Direct provider prefix match: "providerId/modelName"
    const [providerId] = modelId.split('/');
    if (plugins.has(providerId)) {
      return plugins.get(providerId)!;
    }

    // 2. Direct plugin ID match (e.g. "mock", "kilo")
    if (plugins.has(modelId)) {
      return plugins.get(modelId)!;
    }

    // 3. Catalog lookup: check if any active plugin provides this model
    const modelMap = await getModelPluginMap();
    if (modelMap.has(modelId)) {
      return modelMap.get(modelId)!;
    }

    // 4. Model not found across active plugins — fail with HTTP 404
    throw new GatewayError(
      404,
      'model_not_found',
      `No active provider found for model: ${modelId}`
    );
  }

  // --------------------------------------------------------------------------
  // POST /v1/chat/completions (OpenAI Dialect)
  // --------------------------------------------------------------------------
  app.post('/v1/chat/completions', async (c) => {
    const reqId = (c.get('requestId') as string) || `req_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'Invalid JSON payload in request body'
      );
    }

    const canonicalReq = normalizeOpenAIChat(rawBody, reqId);
    const provider = await resolveProvider(canonicalReq.model);

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      const canonicalRes = await provider.execute(canonicalReq, c.req.raw.signal);
      const openAIResponse = serializeOpenAIChat(canonicalRes);
      return c.json(openAIResponse);
    }

    // Streaming Branch
    const upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);

    const sseStream = createOpenAISSEStream(cleanEvents, {
      includeUsage: canonicalReq.streamOptions?.includeUsage,
      keepaliveMs: config.defaultKeepaliveMs,
      signal: c.req.raw.signal,
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'x-request-id': reqId,
      },
    });
  });

  // --------------------------------------------------------------------------
  // POST /v1/messages (Anthropic Dialect)
  // --------------------------------------------------------------------------
  app.post('/v1/messages', async (c) => {
    const reqId = (c.get('requestId') as string) || `msg_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'Invalid JSON payload in request body'
      );
    }

    const canonicalReq = normalizeAnthropicMessages(rawBody, reqId);
    const provider = await resolveProvider(canonicalReq.model);

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      const canonicalRes = await provider.execute(canonicalReq, c.req.raw.signal);
      const anthropicResponse = serializeAnthropicMessage(canonicalRes);
      return c.json(anthropicResponse);
    }

    // Streaming Branch
    const upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);

    const sseStream = createAnthropicSSEStream(cleanEvents, {
      keepaliveMs: config.defaultKeepaliveMs,
      signal: c.req.raw.signal,
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'x-request-id': reqId,
      },
    });
  });

  // --------------------------------------------------------------------------
  // POST /v1/responses (OpenAI Responses Dialect)
  // --------------------------------------------------------------------------
  app.post('/v1/responses', async (c) => {
    const reqId = (c.get('requestId') as string) || `resp_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'Invalid JSON payload in request body'
      );
    }

    const canonicalReq = normalizeOpenAIResponses(rawBody, reqId);
    const provider = await resolveProvider(canonicalReq.model);

    const canonicalRes = await provider.execute(canonicalReq, c.req.raw.signal);
    const responsesOutput = serializeOpenAIResponse(canonicalRes);
    return c.json(responsesOutput);
  });
}
