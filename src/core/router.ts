import { Hono } from 'hono';
import { ServerContext, AppEnv } from './server';
import {
  normalizeOpenAIChat,
  normalizeAnthropicMessages,
  normalizeOpenAIResponses,
} from '../engine/dialect/normalizer';
import { assertProviderCapabilities } from '../engine/dialect/capabilities';
import {
  serializeOpenAIChat,
  serializeAnthropicMessage,
  serializeOpenAIResponse,
} from '../engine/dialect/serializer';
import {
  createOpenAISSEStream,
  createAnthropicSSEStream,
  createResponsesSSEStream,
} from '../engine/dialect/stream-adapter';
import { createXMLToolInterceptor } from '../engine/dialect/xml-tool-interceptor';
import { GatewayError } from './types/errors';
import { globalBreakerRegistry } from './breaker';
import { createAdminRouter, broadcastLog } from '../admin/admin-router';
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
import { createModelResolver, type ModelResolution } from '../utils/model-resolver';
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

  // Single per-request gate for every dialect, accounted or keyless. A gated
  // request never reached the provider, so it records no breaker outcome.
  function gateProvider(providerId: string): void {
    if (!globalBreakerRegistry.get(providerId).allow()) {
      throw new GatewayError(503, 'breaker_open', `Provider ${providerId} is circuit-broken`);
    }
  }

  // A stream settles the breaker exactly once, after delivery is known.
  function streamOutcomeRecorder(providerId: string) {
    const breaker = globalBreakerRegistry.get(providerId);
    let settled = false;
    return {
      get settled(): boolean { return settled; },
      succeed(): void {
        if (settled) return;
        settled = true;
        breaker.recordSuccess();
      },
      fail(error: unknown): void {
        if (settled) return;
        settled = true;
        breaker.recordFailure(error);
      },
    };
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
  // Provider Resolution — one catalog-driven resolver shared with combos/admin
  // --------------------------------------------------------------------------
  const resolver = createModelResolver(() => plugins.values());

  async function resolveProvider(modelId: string): Promise<ModelResolution> {
    if (plugins.size === 0) {
      throw new GatewayError(
        503,
        'service_unavailable',
        'No provider plugins are currently registered or active'
      );
    }
    return resolver.resolve(modelId);
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
    gateProvider(provider.id);
    assertProviderCapabilities(canonicalReq, provider);
    canonicalReq.model = resolvedModel;

    // Real Tokenizer prompt counting at the gateway edge before forwarding
    const realPromptTokens = countPromptTokens(canonicalReq).total;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      let canonicalRes: Awaited<ReturnType<typeof provider.execute>>;
      try {
        const deadlineController = new AbortController();
        canonicalRes = await withRequestDeadline(
          provider.execute(canonicalReq, deadlineController.signal),
          config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1_800_000,
          provider.id,
          deadlineController,
          c.req.raw.signal
        );
      } catch (err) {
        globalBreakerRegistry.get(provider.id).recordFailure(err);
        if (isContextOverflow(err)) {
          observeContextOverflow(observedPassportStore(), canonicalReq.model, realPromptTokens);
        }
        throw err;
      }
      globalBreakerRegistry.get(provider.id).recordSuccess();
      observeCanonicalResponse(observedPassportStore(), canonicalReq.model, canonicalRes);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const reportedUsage = canonicalRes.usage?.estimated === true ? undefined : canonicalRes.usage;
      const estimated = !reportedUsage;
      const promptTokens = reportedUsage ? reportedUsage.promptTokens : realPromptTokens;
      const completionTokens = reportedUsage
        ? reportedUsage.completionTokens
        : countCompletionTokens(canonicalRes.content);
      if (estimated) {
        canonicalRes.usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
      }
      const billedProviderId = canonicalReq.servedByProviderId ?? provider.id;
      if (canonicalReq.accountId) {
        globalAccountPool.recordTokenUsage(canonicalReq.accountId, promptTokens, completionTokens);
      } else {
        globalAccountPool.recordProviderUsage(billedProviderId, promptTokens, completionTokens);
      }
      broadcastLog({
        requestId: reqId,
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/chat/completions',
        provider: billedProviderId,
        accountId: canonicalReq.accountId,
        model: canonicalReq.model,
        status: 200,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated,
      });
      const openAIResponse = serializeOpenAIChat(canonicalRes);
      return c.json(openAIResponse);
    }

    // Streaming Branch
    const requestTimeoutMs = config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1800000;
    const idleTimeoutMs = config.idleTimeoutMs || config.defaultIdleTimeoutMs || 120000;

    let upstreamEvents: Awaited<ReturnType<typeof provider.executeStream>>;
    try {
      upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    } catch (err) {
      globalBreakerRegistry.get(provider.id).recordFailure(err);
      throw err;
    }
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);
    const timedEvents = withIdleTimeout(cleanEvents, {
      idleTimeoutMs,
      requestTimeoutMs,
      signal: c.req.raw.signal,
    });

    async function* tappedOpenAIStream() {
      const outcome = streamOutcomeRecorder(provider.id);
      const billedProviderId = canonicalReq.servedByProviderId ?? provider.id;
      let finalPrompt = realPromptTokens;
      let upstreamCompletionTokens: number | undefined;
      let streamStatus = 200;
      let accumulatedOutput = '';
      let sawStreamEnd = false;

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
          } else if (event.type === 'stream_end') {
            sawStreamEnd = true;
            if (event.usage) {
              if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
              if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
            }
          } else if (event.type === 'stream_error') {
            streamStatus = event.error?.status ?? 502;
            outcome.fail(
              new GatewayError(streamStatus, 'upstream_error', event.error?.message ?? 'upstream stream failed')
            );
          }
          yield event;
        }
      } catch (err) {
        outcome.fail(err);
        throw err;
      } finally {
        // A client abort ends iteration without a stream_end; nothing was
        // delivered, so record no usage and no success log entry.
        if (c.req.raw.signal.aborted) return;
        if (!outcome.settled) {
          if (sawStreamEnd && streamStatus === 200) {
            outcome.succeed();
          } else {
            outcome.fail(
              new GatewayError(
                streamStatus === 200 ? 502 : streamStatus,
                'upstream_error',
                'upstream stream ended before completion'
              )
            );
          }
        }
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        const finalCompletion =
          upstreamCompletionTokens !== undefined
            ? upstreamCompletionTokens
            : (accumulatedOutput.length > 0 ? countTextTokens(accumulatedOutput) : 0);

        if (sawStreamEnd && streamStatus === 200) {
          if (canonicalReq.accountId) {
            globalAccountPool.recordTokenUsage(canonicalReq.accountId, finalPrompt, finalCompletion);
          } else {
            globalAccountPool.recordProviderUsage(billedProviderId, finalPrompt, finalCompletion);
          }
        }
        broadcastLog({
          requestId: reqId,
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/chat/completions',
          provider: billedProviderId,
          accountId: canonicalReq.accountId,
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
    gateProvider(provider.id);
    assertProviderCapabilities(canonicalReq, provider);
    canonicalReq.model = resolvedModel;

    // Real Tokenizer prompt counting at the gateway edge before forwarding
    const realPromptTokens = countPromptTokens(canonicalReq).total;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      let canonicalRes: Awaited<ReturnType<typeof provider.execute>>;
      try {
        const deadlineController = new AbortController();
        canonicalRes = await withRequestDeadline(
          provider.execute(canonicalReq, deadlineController.signal),
          config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1_800_000,
          provider.id,
          deadlineController,
          c.req.raw.signal
        );
      } catch (err) {
        globalBreakerRegistry.get(provider.id).recordFailure(err);
        if (isContextOverflow(err)) {
          observeContextOverflow(observedPassportStore(), canonicalReq.model, realPromptTokens);
        }
        throw err;
      }
      globalBreakerRegistry.get(provider.id).recordSuccess();
      observeCanonicalResponse(observedPassportStore(), canonicalReq.model, canonicalRes);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const reportedUsage = canonicalRes.usage?.estimated === true ? undefined : canonicalRes.usage;
      const estimated = !reportedUsage;
      const promptTokens = reportedUsage ? reportedUsage.promptTokens : realPromptTokens;
      const completionTokens = reportedUsage
        ? reportedUsage.completionTokens
        : countCompletionTokens(canonicalRes.content);
      if (estimated) {
        canonicalRes.usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
      }
      const billedProviderId = canonicalReq.servedByProviderId ?? provider.id;
      if (canonicalReq.accountId) {
        globalAccountPool.recordTokenUsage(canonicalReq.accountId, promptTokens, completionTokens);
      } else {
        globalAccountPool.recordProviderUsage(billedProviderId, promptTokens, completionTokens);
      }
      broadcastLog({
        requestId: reqId,
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/messages',
        provider: billedProviderId,
        accountId: canonicalReq.accountId,
        model: canonicalReq.model,
        status: 200,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated,
      });
      const anthropicResponse = serializeAnthropicMessage(canonicalRes);
      return c.json(anthropicResponse);
    }

    // Streaming Branch
    const requestTimeoutMs = config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1800000;
    const idleTimeoutMs = config.idleTimeoutMs || config.defaultIdleTimeoutMs || 120000;

    let upstreamEvents: Awaited<ReturnType<typeof provider.executeStream>>;
    try {
      upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    } catch (err) {
      globalBreakerRegistry.get(provider.id).recordFailure(err);
      throw err;
    }
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);
    const timedEvents = withIdleTimeout(cleanEvents, {
      idleTimeoutMs,
      requestTimeoutMs,
      signal: c.req.raw.signal,
    });

    async function* tappedAnthropicStream() {
      const outcome = streamOutcomeRecorder(provider.id);
      const billedProviderId = canonicalReq.servedByProviderId ?? provider.id;
      let finalPrompt = realPromptTokens;
      let upstreamCompletionTokens: number | undefined;
      let streamStatus = 200;
      let accumulatedOutput = '';
      let sawStreamEnd = false;

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
          } else if (event.type === 'stream_end') {
            sawStreamEnd = true;
            if (event.usage) {
              if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
              if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
            }
          } else if (event.type === 'stream_error') {
            streamStatus = event.error?.status ?? 502;
            outcome.fail(
              new GatewayError(streamStatus, 'upstream_error', event.error?.message ?? 'upstream stream failed')
            );
          }
          yield event;
        }
      } catch (err) {
        outcome.fail(err);
        throw err;
      } finally {
        // A client abort ends iteration without a stream_end; nothing was
        // delivered, so record no usage and no success log entry.
        if (c.req.raw.signal.aborted) return;
        if (!outcome.settled) {
          if (sawStreamEnd && streamStatus === 200) {
            outcome.succeed();
          } else {
            outcome.fail(
              new GatewayError(
                streamStatus === 200 ? 502 : streamStatus,
                'upstream_error',
                'upstream stream ended before completion'
              )
            );
          }
        }
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        const finalCompletion =
          upstreamCompletionTokens !== undefined
            ? upstreamCompletionTokens
            : (accumulatedOutput.length > 0 ? countTextTokens(accumulatedOutput) : 0);

        if (sawStreamEnd && streamStatus === 200) {
          if (canonicalReq.accountId) {
            globalAccountPool.recordTokenUsage(canonicalReq.accountId, finalPrompt, finalCompletion);
          } else {
            globalAccountPool.recordProviderUsage(billedProviderId, finalPrompt, finalCompletion);
          }
        }
        broadcastLog({
          requestId: reqId,
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/messages',
          provider: billedProviderId,
          accountId: canonicalReq.accountId,
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
    gateProvider(provider.id);
    assertProviderCapabilities(canonicalReq, provider);
    canonicalReq.model = resolvedModel;

    // Real Tokenizer prompt counting at the gateway edge before forwarding
    const realPromptTokens = countPromptTokens(canonicalReq).total;

    // Non-Streaming Branch
    if (!canonicalReq.stream) {
      let canonicalRes: Awaited<ReturnType<typeof provider.execute>>;
      try {
        const deadlineController = new AbortController();
        canonicalRes = await withRequestDeadline(
          provider.execute(canonicalReq, deadlineController.signal),
          config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1_800_000,
          provider.id,
          deadlineController,
          c.req.raw.signal
        );
      } catch (err) {
        globalBreakerRegistry.get(provider.id).recordFailure(err);
        if (isContextOverflow(err)) {
          observeContextOverflow(observedPassportStore(), canonicalReq.model, realPromptTokens);
        }
        throw err;
      }
      globalBreakerRegistry.get(provider.id).recordSuccess();
      observeCanonicalResponse(observedPassportStore(), canonicalReq.model, canonicalRes);
      const latencyMs = Math.max(1, Date.now() - reqStartTime);
      const reportedUsage = canonicalRes.usage?.estimated === true ? undefined : canonicalRes.usage;
      const estimated = !reportedUsage;
      const promptTokens = reportedUsage ? reportedUsage.promptTokens : realPromptTokens;
      const completionTokens = reportedUsage
        ? reportedUsage.completionTokens
        : countCompletionTokens(canonicalRes.content);
      if (estimated) {
        canonicalRes.usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
      }
      const billedProviderId = canonicalReq.servedByProviderId ?? provider.id;
      if (canonicalReq.accountId) {
        globalAccountPool.recordTokenUsage(canonicalReq.accountId, promptTokens, completionTokens);
      } else {
        globalAccountPool.recordProviderUsage(billedProviderId, promptTokens, completionTokens);
      }
      broadcastLog({
        requestId: reqId,
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/responses',
        provider: billedProviderId,
        accountId: canonicalReq.accountId,
        model: canonicalReq.model,
        status: 200,
        latencyMs,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated,
      });
      const responsesOutput = serializeOpenAIResponse(canonicalRes);
      return c.json(responsesOutput);
    }

    // Streaming Branch
    const requestTimeoutMs = config.requestTimeoutMs || config.defaultRequestTimeoutMs || 1800000;
    const idleTimeoutMs = config.idleTimeoutMs || config.defaultIdleTimeoutMs || 120000;

    let upstreamEvents: Awaited<ReturnType<typeof provider.executeStream>>;
    try {
      upstreamEvents = await provider.executeStream(canonicalReq, c.req.raw.signal);
    } catch (err) {
      globalBreakerRegistry.get(provider.id).recordFailure(err);
      throw err;
    }
    const interceptor = createXMLToolInterceptor();
    const cleanEvents = interceptor.transform(upstreamEvents);
    const timedEvents = withIdleTimeout(cleanEvents, {
      idleTimeoutMs,
      requestTimeoutMs,
      signal: c.req.raw.signal,
    });

    async function* tappedResponsesStream() {
      const outcome = streamOutcomeRecorder(provider.id);
      const billedProviderId = canonicalReq.servedByProviderId ?? provider.id;
      let finalPrompt = realPromptTokens;
      let upstreamCompletionTokens: number | undefined;
      let streamStatus = 200;
      let accumulatedOutput = '';
      let sawStreamEnd = false;

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
          } else if (event.type === 'stream_end') {
            sawStreamEnd = true;
            if (event.usage) {
              if (event.usage.promptTokens) finalPrompt = event.usage.promptTokens;
              if (event.usage.completionTokens) upstreamCompletionTokens = event.usage.completionTokens;
            }
          } else if (event.type === 'stream_error') {
            streamStatus = event.error?.status ?? 502;
            outcome.fail(
              new GatewayError(streamStatus, 'upstream_error', event.error?.message ?? 'upstream stream failed')
            );
          }
          yield event;
        }
      } catch (err) {
        outcome.fail(err);
        throw err;
      } finally {
        // A client abort ends iteration without a stream_end; nothing was
        // delivered, so record no usage and no success log entry.
        if (c.req.raw.signal.aborted) return;
        if (!outcome.settled) {
          if (sawStreamEnd && streamStatus === 200) {
            outcome.succeed();
          } else {
            outcome.fail(
              new GatewayError(
                streamStatus === 200 ? 502 : streamStatus,
                'upstream_error',
                'upstream stream ended before completion'
              )
            );
          }
        }
        const latencyMs = Math.max(1, Date.now() - reqStartTime);
        const finalCompletion =
          upstreamCompletionTokens !== undefined
            ? upstreamCompletionTokens
            : (accumulatedOutput.length > 0 ? countTextTokens(accumulatedOutput) : 0);

        if (sawStreamEnd && streamStatus === 200) {
          if (canonicalReq.accountId) {
            globalAccountPool.recordTokenUsage(canonicalReq.accountId, finalPrompt, finalCompletion);
          } else {
            globalAccountPool.recordProviderUsage(billedProviderId, finalPrompt, finalCompletion);
          }
        }
        broadcastLog({
          requestId: reqId,
          timestamp: Date.now(),
          method: 'POST',
          path: '/v1/responses',
          provider: billedProviderId,
          accountId: canonicalReq.accountId,
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

    const sseStream = createResponsesSSEStream(tappedResponsesStream(), {
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
}







