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

export function parseClineRetryAfter(headerValue?: string | null, bodyText?: string | null): number {
  if (headerValue && !isNaN(Number(headerValue))) {
    return Number(headerValue);
  }

  const text = (bodyText || '') + ' ' + (headerValue || '');

  const hoursMatch = text.match(/try\s+again\s+in\s+(\d+)\s*hours?/i);
  if (hoursMatch) {
    return parseInt(hoursMatch[1], 10) * 3600;
  }

  const minutesMatch = text.match(/try\s+again\s+in\s+(\d+)\s*minutes?/i);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10) * 60;
  }

  const secondsMatch = text.match(/try\s+again\s+in\s+(\d+)\s*(?:seconds?|secs?)/i);
  if (secondsMatch) {
    return parseInt(secondsMatch[1], 10);
  }

  return 30; // Default fallback
}

export class ClinePoolPlugin implements ProviderPlugin {
  readonly id = 'cline';
  readonly displayName = 'Cline Pool Upstream Plugin';
  readonly description = 'WorkOS OAuth pooled free & pass accounts for Cline IDEs';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['oauth', 'api_key'] as const;

  public accounts: StoredAccount[] = [];
  private activeAccountIndex = 0;

  constructor(defaultBaseUrl = 'https://api.cline.bot/v1', initialAccounts?: StoredAccount[]) {
    this.defaultBaseUrl = defaultBaseUrl;
    if (initialAccounts) {
      this.accounts = [...initialAccounts];
    }
  }

  addAccount(account: StoredAccount): void {
    const existingIdx = this.accounts.findIndex((a) => a.id === account.id);
    if (existingIdx >= 0) {
      this.accounts[existingIdx] = account;
    } else {
      this.accounts.push(account);
    }
  }

  getActiveAccount(): StoredAccount | undefined {
    const now = Date.now();
    const active = this.accounts.filter(
      (a) => a.status === 'active' && (!a.cooldownUntil || a.cooldownUntil <= now)
    );
    if (active.length === 0) return undefined;
    this.activeAccountIndex = (this.activeAccountIndex + 1) % active.length;
    return active[this.activeAccountIndex];
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'cline/claude-3-7-sonnet',
        name: 'Cline Claude 3.7 Sonnet',
        providerId: 'cline',
        ownedBy: 'cline',
        created: 1731693600,
        contextWindow: 200000,
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: false,
        tags: ['reasoning', 'coding'],
      },
      {
        id: 'cline/sonnet-agent',
        name: 'Cline Sonnet Autonomous Agent',
        providerId: 'cline',
        ownedBy: 'cline',
        created: 1731693600,
        contextWindow: 200000,
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: false,
        tags: ['coding', 'tools'],
      },
      {
        id: 'cline-free/mimo-v2.6-flash',
        name: 'Cline Free Mimo V2.6 Flash',
        providerId: 'cline',
        ownedBy: 'cline',
        created: 1731693600,
        contextWindow: 128000,
        supportsThinking: false,
        supportsTools: true,
        supportsStreaming: true,
        isFree: true,
        tags: ['free', 'fast'],
      },
    ];
  }

  private buildHeaders(account?: StoredAccount): Record<string, string> {
    const acc = account || this.getActiveAccount();
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
    const account = this.getActiveAccount();
    if (!account && this.accounts.length > 0) {
      throw new GatewayError(429, '429', 'All Cline accounts are currently in cooldown', { retryAfter: 30 });
    }

    const headers = this.buildHeaders(account);
    const model = req.model.replace(/^cline(-free)?\//, '');

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
      if (account) {
        account.status = 'invalid';
      }
      throw new GatewayError(401, '401', 'Cline WorkOS OAuth token invalid or expired');
    }

    if (res.status === 429) {
      const bodyText = await res.text().catch(() => '');
      const retryAfter = parseClineRetryAfter(res.headers.get('retry-after'), bodyText);
      if (account) {
        account.status = 'cooldown';
        account.cooldownUntil = Date.now() + retryAfter * 1000;
        account.cooldownReason = bodyText || 'Rate limit exceeded';
      }
      throw new GatewayError(429, '429', `Cline account quota exceeded: ${bodyText}`, { retryAfter });
    }

    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `Cline upstream error: ${res.statusText}`);
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
    const account = this.getActiveAccount();
    if (!account && this.accounts.length > 0) {
      throw new GatewayError(429, '429', 'All Cline accounts are in cooldown', { retryAfter: 30 });
    }

    const headers = this.buildHeaders(account);
    const model = req.model.replace(/^cline(-free)?\//, '');

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
      if (res.status === 401) {
        if (account) account.status = 'invalid';
        throw new GatewayError(401, '401', 'Cline token expired');
      }
      if (res.status === 429) {
        const bodyText = await res.text().catch(() => '');
        const retryAfter = parseClineRetryAfter(res.headers.get('retry-after'), bodyText);
        if (account) {
          account.status = 'cooldown';
          account.cooldownUntil = Date.now() + retryAfter * 1000;
        }
        throw new GatewayError(429, '429', `Cline rate limit reached`, { retryAfter });
      }
      throw new GatewayError(res.status, String(res.status), `Cline upstream stream error: ${res.statusText}`);
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'Cline empty stream response');
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
    const active = this.accounts.filter((a) => a.status === 'active');
    return {
      healthy: active.length > 0,
      checkedAt: Date.now(),
      message: `${active.length}/${this.accounts.length} Cline accounts active`,
    };
  }

  classifyError(error: unknown, statusCode?: number): ErrorClassificationResult {
    if (statusCode === 401) {
      return { category: 'authentication', isRetryable: false, message: 'OAuth token invalid' };
    }
    if (statusCode === 429) {
      return { category: 'rate_limit', isRetryable: true, cooldownDurationMs: 3600_000, message: 'Cline daily/hourly limit' };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
