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
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { parseSSEStream } from '../utils/sse-parser';

export class NousProviderPlugin implements ProviderPlugin {
  readonly id = 'nous';
  readonly displayName = 'Nous Research Hermes Plugin';
  readonly description = 'Flagship Hermes and open-weights reasoning models by Nous Research';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['api_key', 'oauth'] as const;

  public account?: StoredAccount;

  constructor(defaultBaseUrl = 'https://inference-api.nousresearch.com/v1', account?: StoredAccount) {
    this.defaultBaseUrl = defaultBaseUrl;
    this.account = account;
  }

  setAccount(account: StoredAccount): void {
    this.account = account;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'nous/hermes-3-llama3',
        name: 'Nous Hermes 3 Llama 3.1 70B',
        providerId: 'nous',
        ownedBy: 'nousresearch',
        created: 1731693600,
        contextWindow: 128000,
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: false,
        tags: ['reasoning', 'hermes', 'agentic'],
      },
      {
        id: 'nous/hermes-3-llama-3.1-405b',
        name: 'Nous Hermes 3 Llama 3.1 405B',
        providerId: 'nous',
        ownedBy: 'nousresearch',
        created: 1731693600,
        contextWindow: 128000,
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: false,
        tags: ['frontier', 'reasoning'],
      },
      {
        id: 'nous/deepseek-v3',
        name: 'Nous DeepSeek V3 (Inference Hub)',
        providerId: 'nous',
        ownedBy: 'nousresearch',
        created: 1731693600,
        contextWindow: 64000,
        supportsThinking: false,
        supportsTools: true,
        supportsStreaming: true,
        isFree: false,
        tags: ['coding', 'fast'],
      },
    ];
  }

  private buildHeaders(account?: StoredAccount): Record<string, string> {
    const acc = account || this.account;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (acc?.credentials?.apiKey) {
      headers['Authorization'] = `Bearer ${acc.credentials.apiKey}`;
    } else if (acc?.credentials?.accessToken) {
      headers['Authorization'] = `Bearer ${acc.credentials.accessToken}`;
    }

    return headers;
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers = this.buildHeaders();
    const model = req.model.replace(/^nous\//, '');

    const res = await fetch(`${this.defaultBaseUrl}/chat/completions`, {
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
      throw new GatewayError(res.status, String(res.status), `Nous upstream error: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const canonicalId =
      req.clientDialect === 'anthropic-messages' || req.id.startsWith('msg_')
        ? (req.id.startsWith('msg_') ? req.id : `msg_${req.id.replace(/^req_lat_/, '')}`)
        : (data.id || req.id);

    return {
      id: canonicalId,
      model: req.model,
      created: data.created || Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: choice?.message?.content || '' }],
      stopReason: choice?.finish_reason || 'stop',
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

    const res = await fetch(`${this.defaultBaseUrl}/chat/completions`, {
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
      if (res.status === 401) throw new GatewayError(401, '401', 'Invalid Nous API key');
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 15);
        throw new GatewayError(429, '429', 'Nous rate limit reached', { retryAfter });
      }
      throw new GatewayError(res.status, String(res.status), `Nous upstream stream error: ${res.statusText}`);
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'Nous upstream returned empty stream');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const reqId = req.id;
    const reqModel = req.model;

    return (async function* () {
      yield { type: 'stream_start', id: reqId, model: reqModel, created: timestamp };

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') break;

        try {
          const parsed = JSON.parse(sse.data);
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            yield { type: 'text_delta', delta: delta.content };
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
    })();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.defaultBaseUrl}/models`, {
        headers: this.buildHeaders(),
      });
      return {
        healthy: res.ok,
        latencyMs: Date.now() - start,
        checkedAt: Date.now(),
        message: res.ok ? 'OK' : `Status ${res.status}`,
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

  classifyError(error: unknown, statusCode?: number): ErrorClassificationResult {
    if (statusCode === 401) {
      return { category: 'authentication', isRetryable: false, message: 'Invalid credentials' };
    }
    if (statusCode === 429) {
      return { category: 'rate_limit', isRetryable: true, cooldownDurationMs: 60_000, message: 'Rate limited' };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
