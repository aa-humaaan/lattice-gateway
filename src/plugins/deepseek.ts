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

export interface ChromeSessionExport {
  userToken: string;
  sessionId?: string;
  cookies: Record<string, string> | string;
}

export function parseDeepSeekChromeSession(
  accountId: string,
  data: ChromeSessionExport
): StoredAccount {
  if (!data.userToken) {
    throw new Error('Invalid DeepSeek session export: missing userToken');
  }

  const cookieString =
    typeof data.cookies === 'string'
      ? data.cookies
      : Object.entries(data.cookies || {})
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

  return {
    id: accountId,
    providerId: 'deepseek',
    authType: 'cookie_pool',
    credentials: {
      accessToken: data.userToken,
      cookies: cookieString,
      customData: {
        sessionId: data.sessionId || `session_${Date.now()}`,
      },
    },
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorCount: 0,
  };
}

export class DeepSeekPoolPlugin implements ProviderPlugin {
  readonly id = 'deepseek';
  readonly displayName = 'DeepSeek Web Pool Plugin';
  readonly description = 'Chrome cookie & token pool for DeepSeek V3 and R1 reasoning models';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['cookie_pool', 'api_key'] as const;

  public accounts: StoredAccount[] = [];
  private activeIndex = 0;

  constructor(defaultBaseUrl = 'https://chat.deepseek.com/api/v0', initialAccounts?: StoredAccount[]) {
    this.defaultBaseUrl = defaultBaseUrl;
    if (initialAccounts) {
      this.accounts = [...initialAccounts];
    }
  }

  addAccount(account: StoredAccount): void {
    const existing = this.accounts.findIndex((a) => a.id === account.id);
    if (existing >= 0) {
      this.accounts[existing] = account;
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
    this.activeIndex = (this.activeIndex + 1) % active.length;
    return active[this.activeIndex];
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'deepseek/deepseek-reasoner',
        name: 'DeepSeek R1 Reasoner (Web Pool)',
        providerId: 'deepseek',
        ownedBy: 'deepseek',
        created: 1731693600,
        contextWindow: 64000,
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: true,
        tags: ['reasoning', 'r1', 'thinking'],
      },
      {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek V3 Chat (Web Pool)',
        providerId: 'deepseek',
        ownedBy: 'deepseek',
        created: 1731693600,
        contextWindow: 64000,
        supportsThinking: false,
        supportsTools: true,
        supportsStreaming: true,
        isFree: true,
        tags: ['fast', 'chat', 'v3'],
      },
    ];
  }

  private buildHeaders(account?: StoredAccount): Record<string, string> {
    const acc = account || this.getActiveAccount();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    };

    if (acc?.credentials?.accessToken) {
      headers['Authorization'] = `Bearer ${acc.credentials.accessToken}`;
    }
    if (acc?.credentials?.cookies) {
      headers['Cookie'] =
        typeof acc.credentials.cookies === 'string'
          ? acc.credentials.cookies
          : Object.entries(acc.credentials.cookies)
              .map(([k, v]) => `${k}=${v}`)
              .join('; ');
    }

    return headers;
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const account = this.getActiveAccount();
    if (!account && this.accounts.length > 0) {
      throw new GatewayError(429, '429', 'All DeepSeek accounts are in cooldown', { retryAfter: 30 });
    }

    const headers = this.buildHeaders(account);
    const model = req.model.replace(/^deepseek\//, '');

    const res = await fetch(`${this.defaultBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        stream: false,
      }),
      signal,
    });

    if (res.status === 401) {
      if (account) account.status = 'expired';
      throw new GatewayError(401, '401', 'DeepSeek session token expired');
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 30);
      if (account) {
        account.status = 'cooldown';
        account.cooldownUntil = Date.now() + retryAfter * 1000;
      }
      throw new GatewayError(429, '429', 'DeepSeek rate limit reached', { retryAfter });
    }
    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `DeepSeek error: ${res.statusText}`);
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
      throw new GatewayError(429, '429', 'All DeepSeek accounts in cooldown', { retryAfter: 30 });
    }

    const headers = this.buildHeaders(account);
    const model = req.model.replace(/^deepseek\//, '');

    const res = await fetch(`${this.defaultBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      if (res.status === 401) {
        if (account) account.status = 'expired';
        throw new GatewayError(401, '401', 'DeepSeek web session expired');
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 30);
        if (account) {
          account.status = 'cooldown';
          account.cooldownUntil = Date.now() + retryAfter * 1000;
        }
        throw new GatewayError(429, '429', 'DeepSeek rate limit reached', { retryAfter });
      }
      throw new GatewayError(res.status, String(res.status), `DeepSeek stream error: ${res.statusText}`);
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'DeepSeek empty stream');
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

          // Preserve DeepSeek reasoning content if present
          if (delta?.reasoning_content) {
            yield { type: 'thinking_delta', delta: delta.reasoning_content };
          }
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
          // ignore
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
      message: `${active.length}/${this.accounts.length} DeepSeek sessions active`,
    };
  }

  classifyError(error: unknown, statusCode?: number): ErrorClassificationResult {
    if (statusCode === 401) {
      return { category: 'authentication', isRetryable: false, message: 'DeepSeek cookies expired' };
    }
    if (statusCode === 429) {
      return { category: 'rate_limit', isRetryable: true, cooldownDurationMs: 60_000, message: 'DeepSeek rate limit' };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
