import type {
  ProviderPlugin,
  ModelDescriptor,
  StoredAccount,
  HealthCheckResult,
} from '../core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalContentPart,
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { parseSSEStream } from '../utils/sse-parser';
import { serializeOpenAIMessages } from '../engine/dialect/serializer';
import { logger } from '../utils/logger';
import { globalCredentialResolver, type CredentialResolver } from '../core/credential-resolver';

export const FREELLMAPI_DEFAULT_BASE_URL = 'http://127.0.0.1:31415/v1';
export const FREELLMAPI_DEFAULT_KEY =
  process.env.FREELLMAPI_API_KEY ||
  'freellmapi-125efd5db1eb4442d5e5eee4da89ad23bbb9a8198e61799e';

export class FreeLLMAPIProviderPlugin implements ProviderPlugin {
  readonly id = 'freellmapi';
  readonly displayName = 'FreeLLMAPI Local Free Engine';
  readonly description = 'High-throughput local aggregator on port 31415 serving 80+ zero-cost frontier routes';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['api_key'] as const;

  public account?: StoredAccount;
  public cachedModels: ModelDescriptor[] = [];

  constructor(
    defaultBaseUrl = FREELLMAPI_DEFAULT_BASE_URL,
    account?: StoredAccount,
    private readonly credentialResolver: CredentialResolver = globalCredentialResolver
  ) {
    this.defaultBaseUrl = defaultBaseUrl;
    if (account) {
      this.account = account;
    } else {
      this.account = {
        id: 'acc_freellmapi_local',
        providerId: 'freellmapi',
        authType: 'api_key',
        credentials: {
          apiKey: FREELLMAPI_DEFAULT_KEY,
          baseUrl: defaultBaseUrl,
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      };
    }
  }

  setAccount(account: StoredAccount): void {
    this.account = account;
  }

  getAccount(): StoredAccount | undefined {
    return this.account;
  }

  private resolveUrl(endpoint: 'chat' | 'models'): string {
    const cleanBase = this.defaultBaseUrl.replace(/\/+$/, '');
    if (endpoint === 'chat') {
      return cleanBase.endsWith('/chat/completions')
        ? cleanBase
        : `${cleanBase}/chat/completions`;
    }
    return cleanBase.endsWith('/models') ? cleanBase : `${cleanBase}/models`;
  }

  private buildHeaders(): Record<string, string> {
    const creds = this.credentialResolver.credentialsFor(this.account);
    const key =
      creds.apiKey ||
      process.env.FREELLMAPI_API_KEY ||
      FREELLMAPI_DEFAULT_KEY;
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    };
  }

  async syncModels(): Promise<ModelDescriptor[]> {
    try {
      const url = this.resolveUrl('models');
      const res = await fetch(url, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
        if (list.length > 0) {
          const synced: ModelDescriptor[] = list
            .filter((m: any) => m.available !== false)
            .map((item: any) => {
              const rawId: string = item.id || item.name;
              const id = rawId.startsWith('freellmapi/') ? rawId : `freellmapi/${rawId}`;
              const ctx = item.context_window || item.context_length || 128000;
              return {
                id,
                name: item.name ? `${item.name} (FreeLLMAPI)` : `FreeLLMAPI ${rawId}`,
                providerId: 'freellmapi',
                ownedBy: item.owned_by || 'freellmapi',
                created: item.created || 1731693600,
                contextWindow: ctx,
                supportsThinking:
                  id.includes('r1') ||
                  id.includes('nemotron') ||
                  id.includes('opus') ||
                  id.includes('sonnet'),
                supportsTools: true,
                supportsStreaming: true,
                isFree: true,
                tags: ctx >= 1000000 ? ['free', '1m'] : ['free'],
              };
            });

          if (synced.length > 0) {
            this.cachedModels = synced;
            return synced;
          }
        }
      }
    } catch (err) {
      logger.debug(`[FreeLLMAPI] Dynamic models sync failed/skipped: ${err}`);
    }

    if (this.cachedModels.length === 0) {
      this.cachedModels = [
        {
          id: 'freellmapi/auto',
          name: 'FreeLLMAPI Auto (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m', 'auto'],
        },
        {
          id: 'freellmapi/claude-sonnet-4-5',
          name: 'FreeLLMAPI Claude Sonnet 4.5 Slot (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m', 'coding'],
        },
        {
          id: 'freellmapi/claude-opus-4-5',
          name: 'FreeLLMAPI Claude Opus 4.5 Slot (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m', 'reasoning'],
        },
        {
          id: 'freellmapi/claude-haiku-4-5',
          name: 'FreeLLMAPI Claude Haiku 4.5 Slot (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m', 'fast'],
        },
        {
          id: 'freellmapi/fusion',
          name: 'FreeLLMAPI Fusion Panel (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m'],
        },
        {
          id: 'freellmapi/nemotron-3.5-lightning',
          name: 'FreeLLMAPI Nemotron 3.5 Lightning (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m'],
        },
        {
          id: 'freellmapi/nemotron-3-ultra-550b',
          name: 'FreeLLMAPI Nemotron 3 Ultra 550B (1M Context)',
          providerId: 'freellmapi',
          ownedBy: 'freellmapi',
          created: 1731693600,
          contextWindow: 1048576,
          supportsThinking: true,
          supportsTools: true,
          supportsStreaming: true,
          isFree: true,
          tags: ['free', '1m'],
        },
      ];
    }
    return this.cachedModels;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.cachedModels.length === 0) {
      await this.syncModels();
    }
    return this.cachedModels;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const res = await fetch(this.resolveUrl('models'), {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      return {
        healthy: res.ok,
        latencyMs: Date.now() - start,
        checkedAt: Date.now(),
        message: res.ok ? 'FreeLLMAPI local server online' : `HTTP ${res.status}`,
      };
    } catch (err: any) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        checkedAt: Date.now(),
        message: `FreeLLMAPI offline: ${err.message}`,
      };
    }
  }

  private transformCanonicalResponse(data: any, req: CanonicalRequest): CanonicalResponse {
    const choice = data.choices?.[0];
    const canonicalId =
      req.clientDialect === 'anthropic-messages' || req.id.startsWith('msg_')
        ? req.id.startsWith('msg_')
          ? req.id
          : `msg_${req.id.replace(/^req_lat_/, '')}`
        : data.id || req.id;

    const contentParts: CanonicalContentPart[] = [];
    const stopReason = choice?.finish_reason || 'stop';
    const rawContent = choice?.message?.content || '';

    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
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
          id: tc.id || `call_freellm_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: tc.function?.name || 'unknown_tool',
          input: inputObj,
        });
      }
    } else {
      contentParts.push({ type: 'text', text: rawContent });
    }

    if (choice?.message?.reasoning || choice?.message?.reasoning_content) {
      contentParts.unshift({
        type: 'thinking',
        thinking: choice.message.reasoning || choice.message.reasoning_content,
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

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const model = req.model.replace(/^freellmapi\//, '');
    const url = this.resolveUrl('chat');

    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
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

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new GatewayError(
        res.status,
        String(res.status),
        `FreeLLMAPI upstream error (${res.status}): ${errText || res.statusText}`
      );
    }

    const data = (await res.json()) as any;
    return this.transformCanonicalResponse(data, req);
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const model = req.model.replace(/^freellmapi\//, '');
    const url = this.resolveUrl('chat');

    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
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
      const errText = await res.text().catch(() => '');
      throw new GatewayError(
        res.status,
        String(res.status),
        `FreeLLMAPI upstream stream error (${res.status}): ${errText || res.statusText}`
      );
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'FreeLLMAPI returned empty stream body');
    }

    const transformCanonicalResponse = this.transformCanonicalResponse.bind(this);
    const reqId = req.id;
    const reqModel = req.model;

    return (async function* () {
      let emittedStart = false;
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') break;
        let chunk: any;
        try {
          chunk = JSON.parse(sse.data);
        } catch {
          continue;
        }

        if (!emittedStart) {
          yield {
            type: 'stream_start',
            id: chunk.id || reqId,
            model: reqModel,
            created: chunk.created || Math.floor(Date.now() / 1000),
          };
          emittedStart = true;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.reasoning || delta.reasoning_content) {
          yield {
            type: 'thinking_delta',
            delta: delta.reasoning || delta.reasoning_content,
          };
        }

        if (delta.content) {
          completionTokens += Math.max(1, Math.ceil(delta.content.length / 4));
          yield {
            type: 'text_delta',
            delta: delta.content,
          };
        }

        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens || promptTokens;
          completionTokens = chunk.usage.completion_tokens || completionTokens;
        }
      }

      yield {
        type: 'stream_end',
        stopReason: 'stop',
        usage: {
          promptTokens: promptTokens || 15,
          completionTokens: completionTokens || 20,
          totalTokens: (promptTokens || 15) + (completionTokens || 20),
        },
      };
    })();
  }
}
