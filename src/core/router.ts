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
import { globalComboManager } from '../pool/combos';
import { globalAccountPool } from '../pool/account-pool';
import { estimatePromptTokens } from '../utils/token-estimator';
import {
  countPromptTokens,
  countCompletionTokens,
  countTextTokens,
} from '../utils/token-counter';
import { withIdleTimeout } from '../utils/idle-timeout';
import { withRequestDeadline } from '../utils/request-deadline';
import { globalPluginRegistry } from '../plugins/registry';
import { getGlobalModelPassportStore } from './model-passports';
import { deriveSessionKey } from './session-affinity';
import {
  observeCanonicalResponse,
  observeContextOverflow,
  observeStreamEvent,
} from './passport-observation';

export function registerRoutes(app: Hono<AppEnv>, context: ServerContext): void {
  const { config, plugins } = context;

  function observedPassportStore() {
    return getGlobalModelPassportStore(config.dataDir);
  }

  function isContextOverflow(err: unknown): boolean {
    if (!(err instanceof GatewayError)) return false;
    if (err.status !== 400 && err.status !== 422) return false;
    const message = (err.message || '').toLowerCase();
    return message.includes('context') || message.includes('token') || message.includes('length');
  }

  function requestHeaders(request: Request, requestId: string): Record<string, string> {
    const userAgent = request.headers.get('user-agent');
    return {
      'x-request-id': requestId,
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    };
  }

  // --------------------------------------------------------------------------
  // Liveness & Universal Health Probes (Docker, K8s, Claude Code, curl)
  // Mounted before admin wildcard to guarantee 200 OK JSON on all probe routes
  // --------------------------------------------------------------------------
  const healthResponse = (c: any) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      version: '0.1.0',
      timestamp: Date.now(),
    });
  };

  app.get('/healthz', healthResponse);
  app.get('/health', healthResponse);
  app.get('/api/health', healthResponse);
  app.get('/status', healthResponse);
  app.get('/api/status', healthResponse);
  app.get('/admin/api/status', healthResponse);
  app.get('/v1/health', healthResponse);
  app.get('/live', (c) => c.json({ live: true, status: 'ok' }));

  // Mount Admin Dashboard & Management REST APIs
  app.route('/', createAdminRouter());

  // --------------------------------------------------------------------------
  // GET /v1/models (Aggregated Model Catalog)
  // --------------------------------------------------------------------------
  app.get('/v1/models', async (c) => {
    const models = [];
    for (const plugin of plugins.values()) {
      if (globalPluginRegistry.has(plugin.id) && !globalPluginRegistry.isEnabled(plugin.id)) continue;
      const pluginModels = await plugin.listModels();
      const passportStore = getGlobalModelPassportStore(config.dataDir);
      for (const model of pluginModels) passportStore.observe(model, plugin.id);
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
      if (globalPluginRegistry.has(plugin.id) && !globalPluginRegistry.isEnabled(plugin.id)) continue;
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
    const aliased = MODEL_ALIASES[modelId] || modelId;

    // In single-provider environments (e.g. M1 mock provider dev/test),
    // route directly to the active provider.
    if (plugins.size === 1) {
      return { plugin: plugins.values().next().value!, resolvedModel: aliased };
    }

    // Handle client harnesses (e.g. OpenCode) prefixing the provider name "lattice/"
    let targetModel = aliased;
    if (targetModel.startsWith('lattice/')) {
      const remainder = targetModel.slice('lattice/'.length);
      const [firstSub] = remainder.split('/');

      // If remainder has a known sub-provider prefix or another lattice prefix:
      // e.g. "lattice/kilo/..." -> "kilo/...", "lattice/lattice/..." -> "lattice/..."
      if (plugins.has(firstSub) || firstSub === 'cline-free') {
        targetModel = remainder;
      } else {
        // Also check if remainder is a known model in the active catalog (e.g. "lattice/big-pickle")
        const modelMap = await getModelPluginMap();
        if (modelMap.has(remainder) && (!plugins.has('lattice') || !globalComboManager.isCombo(targetModel))) {
          targetModel = remainder;
        }
      }
    }

    // 1. Direct provider prefix match: "providerId/modelName"
    const [providerId] = targetModel.split('/');
    const enabled = (id: string) =>
      !globalPluginRegistry.has(id) || globalPluginRegistry.isEnabled(id);
    if (plugins.has(providerId) && enabled(providerId)) {
      return { plugin: plugins.get(providerId)!, resolvedModel: targetModel };
    }

    // 2. Direct plugin ID match (e.g. "mock", "kilo")
    if (plugins.has(targetModel) && enabled(targetModel)) {
      return { plugin: plugins.get(targetModel)!, resolvedModel: targetModel };
    }

    // 3. Catalog lookup: check if any active plugin provides this model
    const modelMap = await getModelPluginMap();
    if (modelMap.has(targetModel)) {
      return { plugin: modelMap.get(targetModel)!, resolvedModel: targetModel };
    }
    if (modelMap.has(modelId)) {
      return { plugin: modelMap.get(modelId)!, resolvedModel: modelId };
    }

    // 4. Model not found across active plugins â€” fail with HTTP 404
    throw new GatewayError(
      404,
      'model_not_found',
      `No active provider found for model: ${modelId} (resolved as ${targetModel})`
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

    const canonicalReq = normalizeOpenAIChat(rawBody, requestHeaders(c.req.raw, reqId));
    const sessionKey = deriveSessionKey(c.req.raw.headers, rawBody);
    if (sessionKey) canonicalReq.affinity = { sessionKey };
    const { plugin: provider, resolvedModel } = await resolveProvider(canonicalReq.model);
    canonicalReq.model = resolvedModel;

    // Real Tokenizer prompt counting at the gateway edge before forwarding
    const realPromptTokens = countPromptTokens(canonicalReq).total;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      let canonicalRes: Awaited<ReturnType<typeof provider.execute>>;
      try {
        canonicalRes = await withRequestDeadline(
          provider.execute(canonicalReq, c.req.raw.signal),
          config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1_800_000,
          provider.id
        );
      } catch (err) {
        if (isContextOverflow(err)) {
          observeContextOverflow(observedPassportStore(), canonicalReq.model, realPromptTokens);
        }
        throw err;
      }
      observeCanonicalResponse(observedPassportStore(), canonicalReq.model, canonicalRes);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const promptTokens = canonicalRes.usage?.promptTokens || realPromptTokens;
      const completionTokens =
        canonicalRes.usage?.completionTokens ||
        countCompletionTokens(canonicalRes.content);
      globalAccountPool.recordProviderUsage(provider.id, promptTokens, completionTokens);
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
        estimated: !canonicalRes.usage,
      });
      const openAIResponse = serializeOpenAIChat(canonicalRes);
      return c.json(openAIResponse);
    }

    // Streaming Branch
    const requestTimeoutMs = config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1800000;
    const idleTimeoutMs = config.idleTimeoutMs || config.defaultIdleTimeoutMs || 120000;

    const upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);
    const timedEvents = withIdleTimeout(cleanEvents, {
      idleTimeoutMs,
      requestTimeoutMs,
      signal: c.req.raw.signal,
    });

    async function* tappedOpenAIStream() {
      let finalPrompt = realPromptTokens;
      let upstreamCompletionTokens: number | undefined;
      let streamStatus = 200;
      let accumulatedOutput = '';

      try {
        for await (const event of timedEvents) {
          observeStreamEvent(observedPassportStore(), canonicalReq.model, event);
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            accumulatedOutput += event.delta;
          } else if (event.type === 'tool_call_delta') {
            if (event.argumentsDelta) {
              accumulatedOutput += event.argumentsDelta;
            }
          } else if (event.type === 'usage') {
            if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
            if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
          } else if (event.type === 'stream_end' && event.usage) {
            if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
            if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
          } else if (event.type === 'stream_error') {
            streamStatus = event.error?.status ?? 502;
          }
          yield event;
        }
      } finally {
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        const finalCompletion =
          upstreamCompletionTokens !== undefined
            ? upstreamCompletionTokens
            : (accumulatedOutput.length > 0 ? countTextTokens(accumulatedOutput) : 0);

        if (streamStatus === 200) {
          globalAccountPool.recordProviderUsage(provider.id, finalPrompt, finalCompletion);
        }
        broadcastLog({
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/chat/completions',
          provider: provider.id,
          model: canonicalReq.model,
          status: streamStatus,
          latencyMs,
          promptTokens: finalPrompt,
          completionTokens: finalCompletion,
          totalTokens: finalPrompt + finalCompletion,
          estimated: upstreamCompletionTokens === undefined,
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

    const canonicalReq = normalizeAnthropicMessages(rawBody, requestHeaders(c.req.raw, reqId));
    const sessionKey = deriveSessionKey(c.req.raw.headers, rawBody);
    if (sessionKey) canonicalReq.affinity = { sessionKey };
    const { plugin: provider, resolvedModel } = await resolveProvider(canonicalReq.model);
    canonicalReq.model = resolvedModel;

    // Real Tokenizer prompt counting at the gateway edge before forwarding
    const realPromptTokens = countPromptTokens(canonicalReq).total;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      let canonicalRes: Awaited<ReturnType<typeof provider.execute>>;
      try {
        canonicalRes = await withRequestDeadline(
          provider.execute(canonicalReq, c.req.raw.signal),
          config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1_800_000,
          provider.id
        );
      } catch (err) {
        if (isContextOverflow(err)) {
          observeContextOverflow(observedPassportStore(), canonicalReq.model, realPromptTokens);
        }
        throw err;
      }
      observeCanonicalResponse(observedPassportStore(), canonicalReq.model, canonicalRes);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const promptTokens = canonicalRes.usage?.promptTokens || realPromptTokens;
      const completionTokens =
        canonicalRes.usage?.completionTokens ||
        countCompletionTokens(canonicalRes.content);
      globalAccountPool.recordProviderUsage(provider.id, promptTokens, completionTokens);
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
        estimated: !canonicalRes.usage,
      });
      const anthropicResponse = serializeAnthropicMessage(canonicalRes);
      return c.json(anthropicResponse);
    }

    // Streaming Branch
    const requestTimeoutMs = config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1800000;
    const idleTimeoutMs = config.idleTimeoutMs || config.defaultIdleTimeoutMs || 120000;

    const upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);
    const timedEvents = withIdleTimeout(cleanEvents, {
      idleTimeoutMs,
      requestTimeoutMs,
      signal: c.req.raw.signal,
    });

    async function* tappedAnthropicStream() {
      let finalPrompt = realPromptTokens;
      let upstreamCompletionTokens: number | undefined;
      let streamStatus = 200;
      let accumulatedOutput = '';

      try {
        for await (const event of timedEvents) {
          observeStreamEvent(observedPassportStore(), canonicalReq.model, event);
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            accumulatedOutput += event.delta;
          } else if (event.type === 'tool_call_delta') {
            if (event.argumentsDelta) {
              accumulatedOutput += event.argumentsDelta;
            }
          } else if (event.type === 'usage') {
            if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
            if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
          } else if (event.type === 'stream_end' && event.usage) {
            if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
            if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
          } else if (event.type === 'stream_error') {
            streamStatus = event.error?.status ?? 502;
          }
          yield event;
        }
      } finally {
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        const finalCompletion =
          upstreamCompletionTokens !== undefined
            ? upstreamCompletionTokens
            : (accumulatedOutput.length > 0 ? countTextTokens(accumulatedOutput) : 0);

        if (streamStatus === 200) {
          globalAccountPool.recordProviderUsage(provider.id, finalPrompt, finalCompletion);
        }
        broadcastLog({
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/messages',
          provider: provider.id,
          model: canonicalReq.model,
          status: streamStatus,
          latencyMs,
          promptTokens: finalPrompt,
          completionTokens: finalCompletion,
          totalTokens: finalPrompt + finalCompletion,
          estimated: upstreamCompletionTokens === undefined,
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

    const canonicalReq = normalizeOpenAIResponses(rawBody, requestHeaders(c.req.raw, reqId));
    const sessionKey = deriveSessionKey(c.req.raw.headers, rawBody);
    if (sessionKey) canonicalReq.affinity = { sessionKey };
    const { plugin: provider, resolvedModel } = await resolveProvider(canonicalReq.model);
    canonicalReq.model = resolvedModel;

    // Real Tokenizer prompt counting at the gateway edge before forwarding
    const realPromptTokens = countPromptTokens(canonicalReq).total;

    let canonicalRes: Awaited<ReturnType<typeof provider.execute>>;
    try {
      canonicalRes = await withRequestDeadline(
        provider.execute(canonicalReq, c.req.raw.signal),
        config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1_800_000,
        provider.id
      );
    } catch (err) {
      if (isContextOverflow(err)) {
        observeContextOverflow(observedPassportStore(), canonicalReq.model, realPromptTokens);
      }
      throw err;
    }
    observeCanonicalResponse(observedPassportStore(), canonicalReq.model, canonicalRes);
    const latencyMs = Math.max(1, Date.now() - reqStartTime);
    const promptTokens = canonicalRes.usage?.promptTokens || realPromptTokens;
    const completionTokens =
      canonicalRes.usage?.completionTokens ||
      countCompletionTokens(canonicalRes.content);
    globalAccountPool.recordProviderUsage(provider.id, promptTokens, completionTokens);
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
      estimated: !canonicalRes.usage,
    });
    const responsesOutput = serializeOpenAIResponse(canonicalRes);
    return c.json(responsesOutput);
  });
}


