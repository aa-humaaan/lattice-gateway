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
import { serializeOpenAIMessages } from '../engine/dialect/serializer';
import { logger } from '../utils/logger';

export const KILO_DEFAULT_BASE_URL = 'https://ai-gateway.kilo.ai/api/v1';

export interface KiloDeviceAuthResponse {
  user_code: string;
  device_code: string;
  verification_uri: string;
  expires_in?: number;
  interval?: number;
}

export interface KiloTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

export const KILO_CURATED_MODELS: ModelDescriptor[] = [
  {
    id: 'kilo/code-fast:free',
    name: 'Kilo Code Fast (Free Tier)',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'fast', 'coding'],
  },
  {
    id: 'kilo/qwen-2.5-coder:free',
    name: 'Kilo Qwen 2.5 Coder Free',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'coding'],
  },
  {
    id: 'kilo/free-model:free',
    name: 'Kilo Free Model',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free'],
  },
  {
    id: 'kilo/nvidia/nemotron-3.5-super-vl:free',
    name: 'NVIDIA Nemotron 3.5 Super VL Free',
    providerId: 'kilo',
    ownedBy: 'nvidia',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'vision', 'reasoning'],
  },
  {
    id: 'kilo/cohere/north-mini-code:free',
    name: 'Cohere North Mini Code Free',
    providerId: 'kilo',
    ownedBy: 'cohere',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'coding'],
  },
  {
    id: 'kilo/kilo-auto/free',
    name: 'Kilo Auto Free Router',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'auto'],
  },
  {
    id: 'kilo/deepseek-r1:free',
    name: 'DeepSeek R1 Free (via Kilo)',
    providerId: 'kilo',
    ownedBy: 'deepseek',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'reasoning'],
  },
  {
    id: 'kilo/deepseek-v3:free',
    name: 'DeepSeek V3 Free (via Kilo)',
    providerId: 'kilo',
    ownedBy: 'deepseek',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'coding'],
  },
  {
    id: 'kilo/claude-3-7-sonnet',
    name: 'Kilo Claude 3.7 Sonnet',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['reasoning', 'coding', 'flagship'],
  },
  {
    id: 'kilo/claude-3-5-sonnet',
    name: 'Kilo Claude 3.5 Sonnet',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['coding', 'flagship'],
  },
  {
    id: 'kilo/gpt-4o',
    name: 'Kilo GPT-4o Flagship',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['multimodal', 'general'],
  },
  {
    id: 'kilo/stealth/glyph-cluster',
    name: 'Kilo Stealth Glyph Cluster',
    providerId: 'kilo',
    ownedBy: 'kilo',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: false,
    tags: ['debug', 'cluster'],
  },
  {
    id: 'kilo/particle-ai/particle-1:free',
    name: 'Particle AI Particle 1 Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'particle-ai',
    created: 1731693600,
    contextWindow: 1048576,
    maxOutputTokens: 16384,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', '1m', 'fast'],
  },
  {
    id: 'kilo/baidu/ernie-5.5-flash-preview:free',
    name: 'Baidu Ernie 5.5 Flash Preview Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'baidu',
    created: 1731693600,
    contextWindow: 1024000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', '1m', 'preview'],
  },
  {
    id: 'kilo/nvidia/nemotron-3.5-lightning:free',
    name: 'NVIDIA Nemotron 3.5 Lightning Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'nvidia',
    created: 1731693600,
    contextWindow: 1000000,
    maxOutputTokens: 16384,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', '1m', 'lightning'],
  },
  {
    id: 'kilo/inclusionai/ling-3.2-flash:free',
    name: 'InclusionAI Ling 3.2 Flash Free (1M Context)',
    providerId: 'kilo',
    ownedBy: 'inclusionai',
    created: 1731693600,
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', '1m'],
  },
  {
    id: 'kilo/liquid/lfm-3-1.7b:free',
    name: 'Liquid LFM 3 1.7B Free',
    providerId: 'kilo',
    ownedBy: 'liquid',
    created: 1731693600,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'tiny', 'ultra-fast'],
  },
  {
    id: 'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'NVIDIA Nemotron 3 Ultra 550B Free',
    providerId: 'kilo',
    ownedBy: 'nvidia',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'massive'],
  },
  {
    id: 'kilo/qwen/qwen-2.5-72b-instruct:free',
    name: 'Qwen 2.5 72B Instruct Free',
    providerId: 'kilo',
    ownedBy: 'qwen',
    created: 1731693600,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsStreaming: true,
    isFree: true,
    tags: ['free', 'coding', 'qwen'],
  },
];

export class KiloProviderPlugin implements ProviderPlugin {
  readonly id = 'kilo';
  readonly displayName = 'Kilo Code Upstream Plugin';
  readonly description = 'Universal AI router & free-tier gateway by Kilo Code';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['api_key', 'oauth'] as const;

  public account?: StoredAccount;
  public cachedModels: ModelDescriptor[] = [...KILO_CURATED_MODELS];

  constructor(defaultBaseUrl = KILO_DEFAULT_BASE_URL, account?: StoredAccount) {
    this.defaultBaseUrl = defaultBaseUrl;
    this.account = account;
  }

  setAccount(account: StoredAccount): void {
    this.account = account;
  }

  getAccount(): StoredAccount | undefined {
    return this.account;
  }

  private resolveUrl(endpoint: 'chat' | 'models' | 'device_code' | 'token'): string {
    const base = this.defaultBaseUrl.replace(/\/+$/, '');
    switch (endpoint) {
      case 'chat':
        return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      case 'models':
        return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
      case 'device_code':
        if (base.endsWith('/api/v1') || base.endsWith('/v1')) {
          return `${base}/auth/device/code`;
        }
        return `${base}/api/v1/auth/device/code`;
      case 'token':
        if (base.endsWith('/api/v1') || base.endsWith('/v1')) {
          return `${base}/auth/token`;
        }
        return `${base}/api/v1/auth/token`;
    }
  }

  private buildHeaders(account?: StoredAccount): Record<string, string> {
    const acc = account || this.account;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'User-Agent': 'kilo-code-client/1.0 (Lattice Gateway)',
    };

    const token = acc?.credentials?.apiKey || acc?.credentials?.accessToken;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const orgId =
      acc?.credentials?.organizationId ||
      (acc?.credentials?.customData?.organizationId as string | undefined);
    if (orgId) {
      headers['X-KiloCode-OrganizationId'] = orgId;
    }

    return headers;
  }

  /**
   * Dynamic model catalog synchronization with Kilo Code upstream.
   * Discovers online models (including :free models) and falls back to curated catalog if offline.
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
            const id = rawId.startsWith('kilo/') ? rawId : `kilo/${rawId}`;
            const isFree = id.includes(':free') || item.is_free === true;
            return {
              id,
              name: item.name || id,
              providerId: 'kilo',
              ownedBy: item.owned_by || 'kilo',
              created: item.created || 1731693600,
              contextWindow: item.context_window || (isFree ? 128000 : 200000),
              supportsThinking:
                id.includes('sonnet') ||
                id.includes('r1') ||
                id.includes('nemotron') ||
                Boolean(item.supports_thinking),
              supportsTools: true,
              supportsStreaming: true,
              isFree,
              tags: isFree ? ['free', 'coding'] : ['flagship', 'coding'],
            };
          });

          // Ensure mandatory curated :free models are present in catalog
          const existingIds = new Set(synced.map((m) => m.id));
          for (const curated of KILO_CURATED_MODELS) {
            if (!existingIds.has(curated.id)) {
              synced.push(curated);
            }
          }

          this.cachedModels = synced;
          return synced;
        }
      }
    } catch (err) {
      logger.debug(`[Kilo] Dynamic model catalog sync skipped/failed: ${err}`);
    }

    if (!this.cachedModels) {
      this.cachedModels = [...KILO_CURATED_MODELS];
    }
    return this.cachedModels;
  }

  async listModels(account?: StoredAccount): Promise<ModelDescriptor[]> {
    if (!this.cachedModels) {
      this.cachedModels = [...KILO_CURATED_MODELS];
    }
    return this.cachedModels;
  }

  /**
   * Kilo OAuth Device Code Authorization Request
   */
  async requestDeviceCode(clientId = 'kilo_client_app'): Promise<KiloDeviceAuthResponse> {
    const isMock = this.defaultBaseUrl.includes('127.0.0.1') || this.defaultBaseUrl.includes('localhost');
    if (isMock) {
      const url = this.resolveUrl('device_code');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });

      if (!res.ok) {
        throw new GatewayError(
          res.status,
          String(res.status),
          `Kilo device code request failed: ${res.statusText}`
        );
      }

      return (await res.json()) as KiloDeviceAuthResponse;
    }

    const url = 'https://api.kilo.ai/api/device-auth/codes';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      throw new GatewayError(
        res.status,
        String(res.status),
        `Kilo device code request failed: ${res.statusText}`
      );
    }

    const data = (await res.json()) as any;
    return {
      user_code: data.user_code,
      device_code: data.code || data.device_code,
      verification_uri: data.verificationUrl || `https://app.kilo.ai/device-auth?code=${data.user_code}`,
      expires_in: data.expiresIn || 600,
      interval: 3,
    };
  }

  /**
   * Kilo OAuth Device Code Token Exchange
   */
  async exchangeDeviceToken(code: string): Promise<KiloTokenResponse> {
    const isMock = this.defaultBaseUrl.includes('127.0.0.1') || this.defaultBaseUrl.includes('localhost');
    if (isMock) {
      const url = this.resolveUrl('token');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code,
        }),
      });

      if (!res.ok) {
        throw new GatewayError(
          res.status,
          String(res.status),
          `Kilo token exchange failed: ${res.statusText}`
        );
      }

      return (await res.json()) as KiloTokenResponse;
    }

    const url = `https://api.kilo.ai/api/device-auth/codes/${encodeURIComponent(code)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (res.status === 202) {
      // Still pending approval in browser
      return {
        access_token: '',
        token_type: 'bearer',
        expires_in: 0,
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new GatewayError(
        res.status,
        String(res.status),
        `Kilo token exchange failed: ${errText || res.statusText}`
      );
    }

    const data = (await res.json()) as any;
    const token = data.token || data.accessToken || data.access_token || (typeof data === 'string' ? data : '');
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: data.expiresIn || 86400 * 30,
    };
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers = this.buildHeaders();
    const model = req.model.replace(/^kilo\//, '');
    const url = this.resolveUrl('chat');

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: serializeOpenAIMessages(req.messages, req.systemPrompt),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        tools: req.tools && req.tools.length > 0 ? req.tools : undefined,
        tool_choice: req.toolChoice,
        stream: false,
      }),
      signal,
    });

    if (res.status === 401) {
      throw new GatewayError(401, '401', 'Invalid Kilo API key');
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 10);
      throw new GatewayError(429, '429', 'Kilo rate limit reached', { retryAfter });
    }
    if (!res.ok) {
      throw new GatewayError(
        res.status,
        String(res.status),
        `Kilo upstream error: ${res.statusText}`
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

    // Handle XML tool calls or structured tool_calls if emitted by Kilo models
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
          id: `call_kilo_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
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
          id: tc.id || `call_kilo_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
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
        completionTokens: data.usage?.completion_tokens || 15,
        totalTokens: data.usage?.total_tokens || 25,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const headers = this.buildHeaders();
    const model = req.model.replace(/^kilo\//, '');
    const url = this.resolveUrl('chat');

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: serializeOpenAIMessages(req.messages, req.systemPrompt),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        tools: req.tools && req.tools.length > 0 ? req.tools : undefined,
        tool_choice: req.toolChoice,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      if (res.status === 401) throw new GatewayError(401, '401', 'Invalid Kilo API key');
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 10);
        throw new GatewayError(429, '429', 'Kilo rate limit reached', { retryAfter });
      }
      throw new GatewayError(
        res.status,
        String(res.status),
        `Kilo upstream stream error: ${res.statusText}`
      );
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'Kilo upstream returned empty response stream');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const reqId = req.id;
    const reqModel = req.model;

    async function* rawStreamGenerator(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: reqId, model: reqModel, created: timestamp };

      let streamEnded = false;
      let hasToolCalls = false;
      let stopReason: 'stop' | 'tool_calls' | 'length' = 'stop';

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') {
          streamEnded = true;
          break;
        }

        try {
          const parsed = JSON.parse(sse.data);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          if (choice?.finish_reason) {
            if (choice.finish_reason === 'tool_calls') stopReason = 'tool_calls';
            else if (choice.finish_reason === 'length') stopReason = 'length';
            else if (choice.finish_reason === 'stop') stopReason = 'stop';
          }

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
            hasToolCalls = true;
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

      if (hasToolCalls) {
        stopReason = 'tool_calls';
      }

      yield { type: 'stream_end', stopReason };
    }

    return applyXMLToolInterceptor(rawStreamGenerator());
  }

  /**
   * Health check verifying Kilo upstream connectivity and credential validity.
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
          ? 'Kilo Code upstream operational'
          : `Kilo upstream returned HTTP ${res.status}: ${res.statusText}`,
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
    let modelsCount = this.cachedModels?.length || KILO_CURATED_MODELS.length;
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
      return { category: 'authentication', isRetryable: false, message: 'Invalid Kilo credentials' };
    }
    if (statusCode === 403) {
      return {
        category: 'permission_denied',
        isRetryable: false,
        message: 'Kilo organization permission denied',
      };
    }
    if (statusCode === 429) {
      return {
        category: 'rate_limit',
        isRetryable: true,
        cooldownDurationMs: 60_000,
        message: 'Kilo rate limit reached',
      };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
