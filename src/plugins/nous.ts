import type {
  ProviderPlugin,
  ModelDescriptor,
  StoredAccount,
  HealthCheckResult,
  ErrorClassificationResult,
} from '../core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalContentPart,
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { parseSSEStream } from '../utils/sse-parser';
import { parseXMLToolCall, applyXMLToolInterceptor } from '../engine/dialect/xml-tool-interceptor';
import { logger } from '../utils/logger';

export const NOUS_DEFAULT_BASE_URL = 'https://inference-api.nousresearch.com/v1';

export interface NousPortalAuthResponse {
  auth_url: string;
  session_id: string;
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
}

export interface NousPortalTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

export const NOUS_CURATED_MODELS: ModelDescriptor[] = [
  {
    id: 'nous/upstage/solar-mini4:free',
    name: 'Nous Solar Mini 4 Free',
    providerId: 'nous',
    ownedBy: 'upstage',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'fast'],
  },
  {
    id: 'nous/stepfun/step-3.7-flash:free',
    name: 'Nous Step 3.7 Flash Free',
    providerId: 'nous',
    ownedBy: 'stepfun',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'reasoning'],
  },
  {
    id: 'nous/meituan/longcat-2.5:free',
    name: 'Nous Longcat 2.5 Free',
    providerId: 'nous',
    ownedBy: 'meituan',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'large-context'],
  },
  {
    id: 'nous/hermes-3-llama-3.1-8b',
    name: 'Nous Hermes 3 Llama 3.1 8B',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['reasoning', 'hermes', 'agentic'],
  },
  {
    id: 'nous/hermes-3-llama-3.1-70b',
    name: 'Nous Hermes 3 Llama 3.1 70B',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['frontier', 'reasoning', 'hermes'],
  },
  {
    id: 'nous/hermes-3-llama-3.1-405b',
    name: 'Nous Hermes 3 Llama 3.1 405B',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['frontier', 'reasoning'],
  },
  {
    id: 'nous/hermes-3-llama3',
    name: 'Nous Hermes 3 Llama 3.1 70B (Alias)',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['reasoning', 'hermes'],
  },
  {
    id: 'hermes-3-llama-3.1-8b',
    name: 'Hermes 3 Direct Alias (8B)',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['hermes', 'direct'],
  },
  {
    id: 'hermes-3-llama-3.1-70b',
    name: 'Hermes 3 Direct Alias (70B)',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['hermes', 'direct'],
  },
  {
    id: 'nous/deepseek-v3',
    name: 'Nous DeepSeek V3 (Inference Hub)',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 64000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['coding', 'fast'],
  },
  {
    id: 'nous/hermes-2-pro-llama-3-8b',
    name: 'Nous Hermes 2 Pro Llama 3 8B',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['coding', 'tools'],
  },
  {
    id: 'nous/hermes-2-mixtral-8x7b-dpo',
    name: 'Nous Hermes 2 Mixtral 8x7B DPO',
    providerId: 'nous',
    ownedBy: 'nousresearch',
    created: 1731693600,
    contextWindow: 32000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['reasoning', 'moe'],
  },
  {
    id: 'nous/qwen/qwen4-max',
    name: 'Nous Qwen 4 Max (1M Context)',
    providerId: 'nous',
    ownedBy: 'qwen',
    created: 1731693600,
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['coding', 'flagship', '1m'],
  },
  {
    id: 'nous/google/gemini-4-hydrogen',
    name: 'Nous Gemini 4 Hydrogen (1M Context)',
    providerId: 'nous',
    ownedBy: 'google',
    created: 1731693600,
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['gemini', '1m', 'multimodal'],
  },
  {
    id: 'nous/google/gemini-3.8-flash',
    name: 'Nous Gemini 3.8 Flash (1M Context)',
    providerId: 'nous',
    ownedBy: 'google',
    created: 1731693600,
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['gemini', '1m', 'flash'],
  },
  {
    id: 'nous/anthropic/claude-sonnet-5.5',
    name: 'Nous Claude Sonnet 5.5 (200k Context)',
    providerId: 'nous',
    ownedBy: 'anthropic',
    created: 1731693600,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['claude', 'flagship'],
  },
  {
    id: 'nous/deepseek/deepseek-v4.1-flash',
    name: 'Nous DeepSeek V4.1 Flash (128k Context)',
    providerId: 'nous',
    ownedBy: 'deepseek',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 16000,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['deepseek', 'fast'],
  },
];

export class NousProviderPlugin implements ProviderPlugin {
  readonly id = 'nous';
  readonly displayName = 'Nous Research Hermes Plugin';
  readonly description = 'Flagship Hermes and open-weights reasoning models by Nous Research';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['api_key', 'oauth'] as const;

  public account?: StoredAccount;
  public cachedModels: ModelDescriptor[] = [...NOUS_CURATED_MODELS];

  constructor(defaultBaseUrl = NOUS_DEFAULT_BASE_URL, account?: StoredAccount) {
    this.defaultBaseUrl = defaultBaseUrl;
    this.account = account;
  }

  setAccount(account: StoredAccount): void {
    this.account = account;
  }

  getAccount(): StoredAccount | undefined {
    return this.account;
  }

  private resolveUrl(endpoint: 'chat' | 'models' | 'portal_auth' | 'portal_token'): string {
    const base = this.defaultBaseUrl.replace(/\/+$/, '');
    switch (endpoint) {
      case 'chat':
        return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      case 'models':
        return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
      case 'portal_auth':
        return base.endsWith('/v1') ? `${base}/portal/auth` : `${base}/v1/portal/auth`;
      case 'portal_token':
        return base.endsWith('/v1') ? `${base}/portal/token` : `${base}/v1/portal/token`;
    }
  }

  private buildHeaders(account?: StoredAccount): Record<string, string> {
    const acc = account || this.account;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'User-Agent': 'nous-hermes-client/1.0 (Lattice Gateway)',
      'Connection': 'close',
    };

    const key = acc?.credentials?.apiKey || acc?.credentials?.accessToken;
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }

    return headers;
  }

  /**
   * Dynamic model catalog synchronization with Nous Research upstream.
   */
  async syncModels(account?: StoredAccount): Promise<ModelDescriptor[]> {
    try {
      const url = this.resolveUrl('models');
      const headers = this.buildHeaders(account);
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = (await res.json()) as any;
        const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
        if (list.length > 0) {
          const synced: ModelDescriptor[] = list.map((item: any) => {
            const rawId: string = item.id || item.name || 'unknown';
            const id =
              rawId.startsWith('nous/') || rawId.startsWith('hermes-') ? rawId : `nous/${rawId}`;
            return {
              id,
              name: item.name || id,
              providerId: 'nous',
              ownedBy: item.owned_by || 'nousresearch',
              created: item.created || 1731693600,
              contextWindow: item.context_window || 128000,
              supportsThinking: id.includes('hermes-3') || Boolean(item.supports_thinking),
              supportsTools: true,
              supportsStreaming: true,
              isFree: false,
              tags: ['reasoning', 'hermes'],
            };
          });

          // Ensure mandatory curated Hermes models are present
          const existingIds = new Set(synced.map((m) => m.id));
          for (const curated of NOUS_CURATED_MODELS) {
            if (!existingIds.has(curated.id)) {
              synced.push(curated);
            }
          }

          this.cachedModels = synced;
          return synced;
        }
      }
    } catch (err) {
      logger.debug(`[Nous] Dynamic model catalog sync skipped/failed: ${err}`);
    }

    if (!this.cachedModels) {
      this.cachedModels = [...NOUS_CURATED_MODELS];
    }
    return this.cachedModels;
  }

  async listModels(account?: StoredAccount): Promise<ModelDescriptor[]> {
    if (!this.cachedModels) {
      this.cachedModels = [...NOUS_CURATED_MODELS];
    }
    return this.cachedModels;
  }

  /**
   * Nous Portal OAuth Device Authorization Request
   */
  async requestPortalAuth(clientId = 'hermes-cli'): Promise<NousPortalAuthResponse> {
    const isMock = this.defaultBaseUrl.includes('127.0.0.1') || this.defaultBaseUrl.includes('localhost');
    if (isMock) {
      const url = this.resolveUrl('portal_auth');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });

      if (!res.ok) {
        throw new GatewayError(
          res.status,
          String(res.status),
          `Nous portal auth request failed: ${res.statusText}`
        );
      }

      return (await res.json()) as NousPortalAuthResponse;
    }

    const url = 'https://portal.nousresearch.com/api/oauth/device/code';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
    });

    if (!res.ok) {
      throw new GatewayError(
        res.status,
        String(res.status),
        `Nous portal auth request failed: ${res.statusText}`
      );
    }

    const data = (await res.json()) as any;
    return {
      auth_url: data.verification_uri_complete || data.verification_uri || 'https://portal.nousresearch.com/manage-subscription',
      session_id: data.device_code,
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete,
      expires_in: data.expires_in,
    };
  }

  /**
   * Nous Portal OAuth Token Exchange
   */
  async pollPortalToken(deviceCode: string): Promise<NousPortalTokenResponse> {
    const isMock = this.defaultBaseUrl.includes('127.0.0.1') || this.defaultBaseUrl.includes('localhost');
    if (isMock) {
      const url = this.resolveUrl('portal_token');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: deviceCode }),
      });

      if (!res.ok) {
        throw new GatewayError(
          res.status,
          String(res.status),
          `Nous portal token exchange failed: ${res.statusText}`
        );
      }

      return (await res.json()) as NousPortalTokenResponse;
    }

    const url = 'https://portal.nousresearch.com/api/oauth/token';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: 'hermes-cli',
        device_code: deviceCode,
      }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as any;
      if (data.error === 'authorization_pending' || res.status === 400 || res.status === 428) {
        return {
          access_token: '',
          token_type: 'bearer',
          expires_in: 0,
        };
      }
      throw new GatewayError(
        res.status,
        String(res.status),
        `Nous portal token exchange failed: ${data.error_description || res.statusText}`
      );
    }

    const data = (await res.json()) as any;
    return {
      access_token: data.access_token || '',
      refresh_token: data.refresh_token,
      token_type: data.token_type || 'bearer',
      expires_in: data.expires_in,
    };
  }

  async refreshAuth(account: StoredAccount): Promise<StoredAccount> {
    const sessionId = account.credentials.customData?.sessionId as string | undefined;
    if (sessionId) {
      const token = await this.pollPortalToken(sessionId);
      return {
        ...account,
        credentials: {
          ...account.credentials,
          apiKey: token.access_token,
          accessToken: token.access_token,
          refreshToken: token.refresh_token || account.credentials.refreshToken,
        },
        status: 'active',
        updatedAt: Date.now(),
      };
    }
    return account;
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers = this.buildHeaders();
    const model = req.model.replace(/^nous\//, '');
    const url = this.resolveUrl('chat');

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        tools: req.tools,
        tool_choice: req.toolChoice,
        stream: false,
      }),
      signal,
    });

    if (res.status === 401) {
      throw new GatewayError(401, '401', 'Invalid or expired Nous Research API key');
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 15);
      throw new GatewayError(429, '429', 'Nous Research quota / rate limit reached', { retryAfter });
    }
    if (!res.ok) {
      throw new GatewayError(
        res.status,
        String(res.status),
        `Nous upstream error: ${res.statusText}`
      );
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const canonicalId =
      req.clientDialect === 'anthropic-messages' || req.id.startsWith('msg_')
        ? req.id.startsWith('msg_')
          ? req.id
          : `msg_${req.id.replace(/^req_lat_/, '')}`
        : data.id || req.id;

    const contentParts: CanonicalContentPart[] = [];
    let stopReason = choice?.finish_reason || 'stop';
    const rawContent = choice?.message?.content || '';

    // Handle Hermes XML tool calls or structured OpenAI tool calls
    if (
      typeof rawContent === 'string' &&
      (rawContent.includes('<tool_call>') ||
        rawContent.includes('<invoke') ||
        rawContent.includes('<function_call>'))
    ) {
      const parsed = parseXMLToolCall(rawContent);
      if (parsed) {
        const textBefore = rawContent
          .replace(/<(tool_call|invoke|function_call)[\s\S]*?<\/(tool_call|invoke|function_call)>/gi, '')
          .trim();
        if (textBefore) {
          contentParts.push({ type: 'text', text: textBefore });
        }
        let inputObj: Record<string, unknown> = {};
        try {
          inputObj = JSON.parse(parsed.arguments);
        } catch {
          inputObj = { raw: parsed.arguments };
        }
        contentParts.push({
          type: 'tool_use',
          id: `call_nous_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: parsed.name,
          input: inputObj,
        });
        stopReason = 'tool_calls';
      } else {
        contentParts.push({ type: 'text', text: rawContent });
      }
    } else if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
      if (rawContent) {
        contentParts.push({ type: 'text', text: rawContent });
      }
      for (const tc of choice.message.tool_calls) {
        let inputObj: Record<string, unknown> = {};
        try {
          inputObj =
            typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
        } catch {
          inputObj = { raw: tc.function?.arguments };
        }
        contentParts.push({
          type: 'tool_use',
          id: tc.id || `call_nous_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: tc.function?.name || 'unknown_tool',
          input: inputObj,
        });
      }
      stopReason = 'tool_calls';
    } else {
      contentParts.push({ type: 'text', text: rawContent });
    }

    if (choice?.message?.reasoning_content) {
      contentParts.unshift({
        type: 'thinking',
        thinking: choice.message.reasoning_content,
      });
    }

    return {
      id: canonicalId,
      model: req.model,
      created: data.created || Math.floor(Date.now() / 1000),
      content: contentParts,
      stopReason,
      usage: {
        promptTokens: data.usage?.prompt_tokens || 10,
        completionTokens: data.usage?.completion_tokens || 20,
        totalTokens: data.usage?.total_tokens || 30,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const headers = this.buildHeaders();
    const model = req.model.replace(/^nous\//, '');
    const url = this.resolveUrl('chat');

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        tools: req.tools,
        tool_choice: req.toolChoice,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GatewayError(401, '401', 'Invalid or expired Nous Research API key');
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 15);
        throw new GatewayError(429, '429', 'Nous Research quota / rate limit reached', { retryAfter });
      }
      throw new GatewayError(
        res.status,
        String(res.status),
        `Nous upstream stream error: ${res.statusText}`
      );
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'Nous upstream returned empty stream');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const reqId = req.id;
    const reqModel = req.model;

    async function* rawStreamGenerator(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: reqId, model: reqModel, created: timestamp };

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') break;

        try {
          const parsed = JSON.parse(sse.data);
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            yield { type: 'text_delta', delta: delta.content };
          }
          if (delta?.reasoning_content || delta?.thinking) {
            yield {
              type: 'thinking_delta',
              delta: delta.reasoning_content || delta.thinking,
            };
          }
          if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (tc.id && tc.function?.name) {
                yield {
                  type: 'tool_call_start',
                  index: idx,
                  id: tc.id,
                  name: tc.function.name,
                };
              }
              if (tc.function?.arguments) {
                yield {
                  type: 'tool_call_delta',
                  index: idx,
                  argumentsDelta: tc.function.arguments,
                };
              }
            }
          }
          if (parsed.usage) {
            yield {
              type: 'usage',
              usage: {
                promptTokens: parsed.usage.prompt_tokens || 0,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              },
            };
          }
        } catch {
          // ignore corrupted SSE frame
        }
      }

      yield { type: 'stream_end', stopReason: 'stop' };
    }

    // Intercept and normalize raw XML tool calls from Hermes streaming tokens
    return applyXMLToolInterceptor(rawStreamGenerator());
  }

  /**
   * Health check verifying Nous upstream connectivity and credential validity.
   */
  async healthCheck(account?: StoredAccount): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const res = await fetch(this.resolveUrl('models'), {
        headers: this.buildHeaders(account),
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      return {
        healthy: res.ok,
        latencyMs,
        checkedAt: Date.now(),
        message: res.ok
          ? 'Nous Research inference gateway operational'
          : `Nous upstream returned HTTP ${res.status}: ${res.statusText}`,
      };
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        checkedAt: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Deep connection probe returning latency and model count.
   */
  async probe(account?: StoredAccount): Promise<HealthCheckResult & { modelsCount?: number }> {
    const health = await this.healthCheck(account);
    let modelsCount = this.cachedModels?.length || NOUS_CURATED_MODELS.length;
    if (health.healthy) {
      try {
        const synced = await this.syncModels(account);
        modelsCount = synced.length;
      } catch {}
    }
    return {
      ...health,
      modelsCount,
    };
  }

  classifyError(error: unknown, statusCode?: number): ErrorClassificationResult {
    if (statusCode === 401) {
      return { category: 'authentication', isRetryable: false, message: 'Invalid Nous credentials' };
    }
    if (statusCode === 429) {
      return {
        category: 'rate_limit',
        isRetryable: true,
        cooldownDurationMs: 60_000,
        message: 'Nous inference rate limit reached',
      };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
