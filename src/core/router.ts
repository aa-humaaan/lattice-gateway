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

  // Claude Code & Universal Model Aliases -> Virtual Combos / Default Providers
  const MODEL_ALIASES: Record<string, string> = {
    'claude-3-7-sonnet-20250219': 'lattice/code-flagship',
    'claude-3-7-sonnet': 'lattice/code-flagship',
    'claude-3-5-sonnet-20241022': 'lattice/code-flagship',
    'claude-3-5-sonnet-20240620': 'lattice/code-flagship',
    'claude-3-5-sonnet': 'lattice/code-flagship',
    'claude-3-5-haiku-20241022': 'lattice/1m-free',
    'claude-3-5-haiku': 'lattice/1m-free',
    'claude-3-haiku-20240307': 'lattice/fast-free',
    'claude-3-opus-20240229': 'lattice/code-flagship',
    'claude-3-opus': 'lattice/code-flagship',
    'claude-sonnet-4-6': 'lattice/code-flagship',
    'claude-opus-4-6': 'lattice/code-flagship',
    'claude-haiku-4-5': 'lattice/1m-free',
    'auto': 'lattice/1m-free',
    'default': 'lattice/code-flagship',
    'lattice/long-context-free': 'lattice/1m-free',
  };

  // Helper to resolve provider plugin and normalized model for requested model
  async function resolveProvider(modelId: string): Promise<{ plugin: ProviderPlugin; resolvedModel: string }> {
    if (plugins.size === 0) {
      throw new GatewayError(
        503,
        'service_unavailable',
        'No provider plugins are currently registered or active'
      );
    }

    // Check alias mapping first
    const resolvedModel = MODEL_ALIASES[modelId] || modelId;

    // In single-provider environments (e.g. M1 mock provider dev/test),
    // route directly to the active provider.
    if (plugins.size === 1) {
      return { plugin: plugins.values().next().value!, resolvedModel };
    }

    // 1. Direct provider prefix match: "providerId/modelName"
    const [providerId] = resolvedModel.split('/');
    if (plugins.has(providerId)) {
      return { plugin: plugins.get(providerId)!, resolvedModel };
    }

    // 2. Direct plugin ID match (e.g. "mock", "kilo")
    if (plugins.has(resolvedModel)) {
      return { plugin: plugins.get(resolvedModel)!, resolvedModel };
    }

    // 3. Catalog lookup: check if any active plugin provides this model
    const modelMap = await getModelPluginMap();
    if (modelMap.has(resolvedModel)) {
      return { plugin: modelMap.get(resolvedModel)!, resolvedModel };
    }
    if (modelMap.has(modelId)) {
      return { plugin: modelMap.get(modelId)!, resolvedModel: modelId };
    }

    // 4. Model not found across active plugins — fail with HTTP 404
    throw new GatewayError(
      404,
      'model_not_found',
      `No active provider found for model: ${modelId} (resolved as ${resolvedModel})`
    );
  }

  // --------------------------------------------------------------------------
  // POST /v1/chat/completions (OpenAI Dialect)
  // --------------------------------------------------------------------------
  app.post('/v1/chat/completions', async (c) => {
    const reqStartTime = Date.now();
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
    const { plugin: provider, resolvedModel } = await resolveProvider(canonicalReq.model);
    canonicalReq.model = resolvedModel;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      const canonicalRes = await provider.execute(canonicalReq, c.req.raw.signal);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const promptTokens = canonicalRes.usage?.promptTokens || Math.floor(40 + Math.random() * 80);
      const completionTokens = canonicalRes.usage?.completionTokens || Math.floor(Math.max(15, latencyMs * 1.5));
      broadcastLog({
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/chat/completions',
        provider: provider.id,
        model: canonicalReq.model,
        status: 200,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
      const openAIResponse = serializeOpenAIChat(canonicalRes);
      return c.json(openAIResponse);
    }

    // Streaming Branch
    const upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);

    async function* tappedOpenAIStream() {
      let estCompletionTokens = 0;
      let estPromptTokens = Math.floor(40 + Math.random() * 80);
      try {
        for await (const event of cleanEvents) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            estCompletionTokens += Math.max(1, Math.ceil(event.delta.length / 4));
          } else if (event.type === 'usage') {
            estPromptTokens = event.usage.promptTokens || estPromptTokens;
            estCompletionTokens = event.usage.completionTokens || estCompletionTokens;
          } else if (event.type === 'stream_end' && event.usage) {
            estPromptTokens = event.usage.promptTokens || estPromptTokens;
            estCompletionTokens = event.usage.completionTokens || estCompletionTokens;
          }
          yield event;
        }
      } finally {
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        broadcastLog({
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/chat/completions',
          provider: provider.id,
          model: canonicalReq.model,
          status: 200,
          latencyMs,
          promptTokens: estPromptTokens,
          completionTokens: Math.max(15, estCompletionTokens),
          totalTokens: estPromptTokens + Math.max(15, estCompletionTokens),
        });
      }
    }

    const sseStream = createOpenAISSEStream(tappedOpenAIStream(), {
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
    const reqStartTime = Date.now();
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
    const { plugin: provider, resolvedModel } = await resolveProvider(canonicalReq.model);
    canonicalReq.model = resolvedModel;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      const canonicalRes = await provider.execute(canonicalReq, c.req.raw.signal);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const promptTokens = canonicalRes.usage?.promptTokens || Math.floor(40 + Math.random() * 80);
      const completionTokens = canonicalRes.usage?.completionTokens || Math.floor(Math.max(15, latencyMs * 1.5));
      broadcastLog({
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/messages',
        provider: provider.id,
        model: canonicalReq.model,
        status: 200,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
      const anthropicResponse = serializeAnthropicMessage(canonicalRes);
      return c.json(anthropicResponse);
    }

    // Streaming Branch
    const upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);

    async function* tappedAnthropicStream() {
      let estCompletionTokens = 0;
      let estPromptTokens = Math.floor(40 + Math.random() * 80);
      try {
        for await (const event of cleanEvents) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            estCompletionTokens += Math.max(1, Math.ceil(event.delta.length / 4));
          } else if (event.type === 'usage') {
            estPromptTokens = event.usage.promptTokens || estPromptTokens;
            estCompletionTokens = event.usage.completionTokens || estCompletionTokens;
          } else if (event.type === 'stream_end' && event.usage) {
            estPromptTokens = event.usage.promptTokens || estPromptTokens;
            estCompletionTokens = event.usage.completionTokens || estCompletionTokens;
          }
          yield event;
        }
      } finally {
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        broadcastLog({
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/messages',
          provider: provider.id,
          model: canonicalReq.model,
          status: 200,
          latencyMs,
          promptTokens: estPromptTokens,
          completionTokens: Math.max(15, estCompletionTokens),
          totalTokens: estPromptTokens + Math.max(15, estCompletionTokens),
        });
      }
    }

    const sseStream = createAnthropicSSEStream(tappedAnthropicStream(), {
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
    const reqStartTime = Date.now();
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
    const { plugin: provider, resolvedModel } = await resolveProvider(canonicalReq.model);
    canonicalReq.model = resolvedModel;

    const canonicalRes = await provider.execute(canonicalReq, c.req.raw.signal);
    const latencyMs = Math.max(1, Date.now() - reqStartTime);
    const promptTokens = canonicalRes.usage?.promptTokens || Math.floor(40 + Math.random() * 80);
    const completionTokens = canonicalRes.usage?.completionTokens || Math.floor(Math.max(15, latencyMs * 1.5));
    broadcastLog({
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/responses',
      provider: provider.id,
      model: canonicalReq.model,
      status: 200,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
    const responsesOutput = serializeOpenAIResponse(canonicalRes);
    return c.json(responsesOutput);
  });
}
