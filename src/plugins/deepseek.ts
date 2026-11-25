import { safeFetch } from '../core/safe-fetch';
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
  CanonicalStopReason,
  CanonicalUsage,
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { parseSSEStream } from '../utils/sse-parser';
import { serializeOpenAIMessages } from '../engine/dialect/serializer';
import { globalSessionAffinityStore, type SessionAffinityStore } from '../core/session-affinity';
import { globalCredentialResolver, type CredentialResolver } from '../core/credential-resolver';
import { globalAccountPool } from '../pool/account-pool';

export interface ChromeSessionExport {
  userToken?: string;
  token?: string;
  sessionId?: string;
  cookies?: Record<string, string> | string;
  cookie?: Record<string, string> | string;
  userAgent?: string;
  hif_dliq?: string;
  hif_leim?: string;
}

/**
 * Natural language & header parser for 429 Retry-After values.
 */
export function parseDeepSeekRetryAfter(
  headerValue?: string | null,
  bodyText?: string | null
): number {
  if (headerValue) {
    const trimmed = headerValue.trim();
    if (!isNaN(Number(trimmed)) && Number(trimmed) > 0) {
      return Math.ceil(Number(trimmed));
    }
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate)) {
      const diffSec = Math.ceil((parsedDate - Date.now()) / 1000);
      return diffSec > 0 ? diffSec : 30;
    }
  }

  const text = `${bodyText || ''} ${headerValue || ''}`;

  const hoursMatch = text.match(/try\s+again\s+in\s+(\d+)\s*hours?/i);
  if (hoursMatch) return parseInt(hoursMatch[1], 10) * 3600;

  const minutesMatch = text.match(/try\s+again\s+in\s+(\d+)\s*minutes?/i);
  if (minutesMatch) return parseInt(minutesMatch[1], 10) * 60;

  const secondsMatch = text.match(/try\s+again\s+in\s+(\d+)\s*(?:seconds?|secs?)/i);
  if (secondsMatch) return parseInt(secondsMatch[1], 10);

  return 30; // Default fallback
}

/**
 * Parses Chrome session/cookie export formats into a valid StoredAccount.
 */
export function parseDeepSeekChromeSession(
  accountId: string,
  data: ChromeSessionExport
): StoredAccount {
  const token = (data.userToken || data.token || '').trim();

  // If token is missing, attempt to extract userToken from cookie string
  let extractedToken = token;
  const rawCookies = data.cookies ?? data.cookie ?? '';
  if (!extractedToken && typeof rawCookies === 'string') {
    const match = rawCookies.match(/(?:^|;\s*)userToken=([^;]+)/);
    if (match) {
      extractedToken = decodeURIComponent(match[1].trim());
    }
  }

  if (!extractedToken) {
    throw new Error('Invalid DeepSeek session export: missing userToken');
  }

  const cookieString =
    typeof rawCookies === 'string'
      ? rawCookies.replace(/[\r\n\0]+/g, '').trim()
      : Object.entries(rawCookies || {})
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

  return {
    id: accountId,
    providerId: 'deepseek',
    authType: 'cookie_pool',
    credentials: {
      accessToken: extractedToken,
      cookies: cookieString,
      customData: {
        sessionId: data.sessionId || `session_${Date.now()}`,
        ...(data.userAgent ? { userAgent: data.userAgent } : {}),
        ...(data.hif_dliq ? { hif_dliq: data.hif_dliq } : {}),
        ...(data.hif_leim ? { hif_leim: data.hif_leim } : {}),
      },
    },
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorCount: 0,
  };
}

/**
 * Streaming state machine to extract and preserve `<think>...</think>` tokens
 * across SSE chunk boundaries without emitting the raw tags as text.
 */
export class StreamingThinkingExtractor {
  private inThinking = false;
  private buffer = '';

  constructor(
    private readonly onThinkingDelta: (delta: string) => void,
    private readonly onTextDelta: (delta: string) => void
  ) {}

  public processChunk(text: string): void {
    if (!text) return;
    this.buffer += text;

    while (this.buffer.length > 0) {
      if (!this.inThinking) {
        const thinkOpenIdx = this.buffer.indexOf('<think>');
        if (thinkOpenIdx !== -1) {
          if (thinkOpenIdx > 0) {
            this.onTextDelta(this.buffer.slice(0, thinkOpenIdx));
          }
          this.buffer = this.buffer.slice(thinkOpenIdx + 7);
          this.inThinking = true;
          continue;
        }

        const partialLen = this.getPartialTagLength(this.buffer, '<think>');
        if (partialLen > 0) {
          const safeLen = this.buffer.length - partialLen;
          if (safeLen > 0) {
            this.onTextDelta(this.buffer.slice(0, safeLen));
            this.buffer = this.buffer.slice(safeLen);
          }
          break;
        } else {
          this.onTextDelta(this.buffer);
          this.buffer = '';
          break;
        }
      } else {
        const thinkCloseIdx = this.buffer.indexOf('</think>');
        if (thinkCloseIdx !== -1) {
          if (thinkCloseIdx > 0) {
            this.onThinkingDelta(this.buffer.slice(0, thinkCloseIdx));
          }
          this.buffer = this.buffer.slice(thinkCloseIdx + 8);
          this.inThinking = false;
          continue;
        }

        const partialLen = this.getPartialTagLength(this.buffer, '</think>');
        if (partialLen > 0) {
          const safeLen = this.buffer.length - partialLen;
          if (safeLen > 0) {
            this.onThinkingDelta(this.buffer.slice(0, safeLen));
            this.buffer = this.buffer.slice(safeLen);
          }
          break;
        } else {
          this.onThinkingDelta(this.buffer);
          this.buffer = '';
          break;
        }
      }
    }
  }

  public flush(): void {
    if (this.buffer.length > 0) {
      if (this.inThinking) {
        this.onThinkingDelta(this.buffer);
      } else {
        this.onTextDelta(this.buffer);
      }
      this.buffer = '';
    }
  }

  private getPartialTagLength(text: string, tag: string): number {
    const maxCheck = Math.min(text.length, tag.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      const suffix = text.slice(-len);
      if (tag.startsWith(suffix)) {
        return len;
      }
    }
    return 0;
  }
}

export class DeepSeekPoolPlugin implements ProviderPlugin {
  readonly id = 'deepseek';
  readonly displayName = 'DeepSeek Web Pool Plugin';
  readonly description = 'Chrome cookie & token pool for DeepSeek V3 and R1 reasoning models';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['cookie_pool', 'api_key'] as const;

  public accounts: StoredAccount[] = [];
  public activeIndex = 0;

  public get currentAccountIndex(): number {
    return this.activeIndex;
  }
  public set currentAccountIndex(val: number) {
    this.activeIndex = val;
  }

  constructor(
    defaultBaseUrl = 'https://chat.deepseek.com/api/v0',
    initialAccounts?: StoredAccount[],
    private readonly affinityStore: SessionAffinityStore = globalSessionAffinityStore,
    private readonly credentialResolver: CredentialResolver = globalCredentialResolver
  ) {
    this.defaultBaseUrl = defaultBaseUrl.replace(/\/+$/, '');
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

  setAccount(account: StoredAccount): void {
    this.addAccount(account);
  }

  getActiveAccounts(): StoredAccount[] {
    const now = Date.now();
    return this.accounts.filter((a) => {
      // A cooldown is a deadline, not a permanent state. Recover the account
      // once it has elapsed so it can be selected again.
      if (a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil <= now) {
        a.status = 'active';
        a.cooldownUntil = undefined;
      }
      return a.status === 'active' && (!a.cooldownUntil || a.cooldownUntil <= now);
    });
  }

  getActiveAccount(): StoredAccount | undefined {
    const active = this.getActiveAccounts();
    if (active.length === 0) return undefined;
    const acc = active[this.activeIndex % active.length];
    this.activeIndex = (this.activeIndex + 1) % active.length;
    return acc;
  }

  getNextAccount(preferredId?: string, triedIds: Set<string> = new Set()): StoredAccount {
    const active = this.getActiveAccounts().filter((account) => !triedIds.has(account.id));
    if (active.length === 0) {
      const now = Date.now();
      const cooling = this.accounts.filter((a) => a.cooldownUntil && a.cooldownUntil > now);
      const minCooldown =
        cooling.length > 0 ? Math.min(...cooling.map((a) => a.cooldownUntil!)) : now + 30000;
      const retryAfter = Math.max(1, Math.ceil((minCooldown - now) / 1000));
      throw new GatewayError(429, '429', 'All DeepSeek accounts expired or rate-limited', {
        retryAfter,
      });
    }
    const preferred = preferredId ? active.find((account) => account.id === preferredId) : undefined;
    const acc = preferred ?? active[this.activeIndex % active.length];
    this.activeIndex++;
    return acc;
  }

  async solveChallenge(): Promise<string> {
    const base = this.defaultBaseUrl;
    const chalRes = await safeFetch(`${base}/api/v1/session/challenge`, {
      method: 'POST',
      headers: { Connection: 'close' },
    });
    if (!chalRes.ok) throw new Error('DeepSeek session challenge failed');
    const chalData = (await chalRes.json()) as any;
    const verifyRes = await safeFetch(`${base}/api/v1/session/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        challenge: chalData.challenge,
        solution: 'solved_nonce_proof',
      }),
    });
    if (!verifyRes.ok) throw new Error('DeepSeek session verification failed');
    const verifyData = (await verifyRes.json()) as any;
    const token = verifyData.session_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('DeepSeek session verification returned no session token');
    }
    return token;
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
      {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek R1 (Thinking)',
        providerId: 'deepseek',
        ownedBy: 'deepseek',
        created: 1731693600,
        contextWindow: 64000,
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: true,
        tags: ['reasoning', 'r1'],
      },
      {
        id: 'deepseek/deepseek-v3',
        name: 'DeepSeek V3',
        providerId: 'deepseek',
        ownedBy: 'deepseek',
        created: 1731693600,
        contextWindow: 64000,
        supportsThinking: false,
        supportsTools: true,
        supportsStreaming: true,
        isFree: true,
        tags: ['chat', 'v3'],
      },
    ];
  }

  private buildHeaders(account?: StoredAccount, clientUserAgent?: string): Record<string, string> {
    const acc = account || this.getActiveAccount();
    const creds = this.credentialResolver.credentialsFor(acc);
    const ua =
      clientUserAgent ||
      (creds.customData?.userAgent as string | undefined) ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      'x-client-platform': 'web',
      'x-client-version': '2.0.2',
      'x-client-locale': 'en_US',
      'x-client-timezone-offset': '14400',
      'x-app-version': '2.0.2',
      Origin: 'https://chat.deepseek.com',
      Referer: 'https://chat.deepseek.com/',
    };

    if (creds.accessToken) {
      headers['Authorization'] = `Bearer ${creds.accessToken}`;
    }

    if (creds.cookies) {
      headers['Cookie'] =
        typeof creds.cookies === 'string'
          ? creds.cookies.replace(/[\r\n\0]+/g, '').trim()
          : Object.entries(creds.cookies)
              .map(([k, v]) => `${k}=${v}`)
              .join('; ');
    }

    if (creds.customData?.hif_dliq) {
      headers['x-hif-dliq'] = String(creds.customData.hif_dliq);
    }
    if (creds.customData?.hif_leim) {
      headers['x-hif-leim'] = String(creds.customData.hif_leim);
    }

    return headers;
  }

  private getCompletionUrl(): string {
    const base = this.defaultBaseUrl;
    if (base.endsWith('/chat/completion') || base.endsWith('/chat/completions')) {
      return base;
    }
    if (base.includes('/api/v0') || base.includes('chat.deepseek.com')) {
      return `${base}/chat/completion`;
    }
    if (base.endsWith('/v1')) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }

  private isWebEndpoint(url: string): boolean {
    return url.includes('/api/v0') || url.includes('chat.deepseek.com');
  }

  private formatMessagesToPrompt(messages: CanonicalRequest['messages']): string {
    if (!messages || messages.length === 0) return '';
    if (messages.length === 1 && messages[0].role === 'user') {
      const c = messages[0].content;
      return typeof c === 'string' ? c : c.map((p) => ('text' in p ? p.text : '')).join('\n');
    }
    return messages
      .map((m) => {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => ('text' in p ? p.text : '')).join('\n');
        if (m.role === 'system') return `System: ${text}`;
        if (m.role === 'user') return `User: ${text}`;
        if (m.role === 'assistant') return `Assistant: ${text}`;
        return `${m.role}: ${text}`;
      })
      .join('\n\n');
  }

  private buildRequestBody(
    req: CanonicalRequest,
    account: StoredAccount | undefined,
    stream: boolean
  ): Record<string, unknown> {
    const model = req.model.replace(/^deepseek\//, '');
    const url = this.getCompletionUrl();

    if (this.isWebEndpoint(url)) {
      const isThinking =
        model.includes('reasoner') || model.includes('r1') || req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive';
      const prompt = this.formatMessagesToPrompt(req.messages);
      const sessionId = account?.credentials?.customData?.sessionId || `session_${Date.now()}`;
      return {
        chat_session_id: sessionId,
        parent_message_id: account?.credentials?.customData?.parentMessageId || null,
        model_type: 'default',
        prompt,
        ref_file_ids: [],
        thinking_enabled: isThinking,
        search_enabled: false,
        action: null,
        preempt: false,
        model,
        messages: req.messages,
        stream,
      };
    }

    return {
      model,
      messages: serializeOpenAIMessages(req.messages, req.systemPrompt),
      temperature: req.temperature,
      stream,
    };
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const activeAccounts = this.getActiveAccounts();
    if (activeAccounts.length === 0) {
      const now = Date.now();
      const cooling = this.accounts.filter((a) => a.cooldownUntil && a.cooldownUntil > now);
      const minCooldown =
        cooling.length > 0 ? Math.min(...cooling.map((a) => a.cooldownUntil!)) : now + 30000;
      const retryAfter = Math.max(1, Math.ceil((minCooldown - now) / 1000));
      throw new GatewayError(429, '429', 'All DeepSeek accounts expired or rate-limited', {
        retryAfter,
      });
    }

    const attempts = Math.max(1, activeAccounts.length);
    let lastError: any = null;
    const triedIds = new Set<string>();
    const sessionKey = req.affinity?.sessionKey;
    const preferredId = sessionKey ? this.affinityStore.getAccount(sessionKey, this.id) : undefined;
    const reservations: Array<() => void> = [];

    try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reservation = globalAccountPool.acquireAccount(activeAccounts, { preferredId, triedIds, signal });
      if (!reservation) continue;
      const account = reservation.account;
      reservations.push(reservation.release);
      triedIds.add(account.id);
      account.lastUsedAt = Date.now();
      req.accountId = account.id;

      const headers = this.buildHeaders(account, req.rawHeaders?.['user-agent']);
      const url = this.getCompletionUrl();
      const body = this.buildRequestBody(req, account, false);

      try {
        const res = await safeFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (res.status === 401 || res.status === 403) {
          account.status = 'expired';
          account.errorCount = (account.errorCount || 0) + 1;
          account.cooldownUntil = Date.now() + 10 * 60 * 1000;
          lastError = new GatewayError(
            res.status,
            String(res.status),
            `DeepSeek session token expired (HTTP ${res.status})`
          );
          if (this.getActiveAccounts().length > 0) {
            continue; // Auto-heal retry with next account
          }
          throw lastError;
        }

        if (res.status === 429) {
          const bodyText = await res.text().catch(() => '');
          const retryAfter = parseDeepSeekRetryAfter(res.headers.get('retry-after'), bodyText);
          account.status = 'cooldown';
          account.cooldownUntil = Date.now() + retryAfter * 1000;
          account.errorCount = (account.errorCount || 0) + 1;
          lastError = new GatewayError(429, '429', 'DeepSeek rate limit reached', { retryAfter });
          if (this.getActiveAccounts().length > 0) {
            continue; // Auto-heal retry with next account
          }
          throw lastError;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          throw new GatewayError(
            res.status,
            String(res.status),
            `DeepSeek error: ${errText || res.statusText}`
          );
        }

        account.errorCount = 0;
        if (sessionKey) this.affinityStore.pinAccount(sessionKey, this.id, account.id);
        const data = (await res.json()) as any;
        const choice = data.choices?.[0];

        const rawContent = choice?.message?.content || '';
        let thinkingText = choice?.message?.reasoning_content || '';
        let textContent = rawContent;

        // Extract <think>...</think> if present in content
        const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
          if (!thinkingText) {
            thinkingText = thinkMatch[1].trim();
          }
          textContent = rawContent.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
        }

        const contentParts: CanonicalContentPart[] = [];
        if (thinkingText) {
          contentParts.push({ type: 'thinking', thinking: thinkingText });
        }
        contentParts.push({ type: 'text', text: textContent });

        const canonicalId =
          req.clientDialect === 'anthropic-messages' || req.id.startsWith('msg_')
            ? (req.id.startsWith('msg_') ? req.id : `msg_${req.id.replace(/^req_lat_/, '')}`)
            : (data.id || req.id);

        return {
          id: canonicalId,
          model: req.model,
          created: data.created || Math.floor(Date.now() / 1000),
          content: contentParts,
          stopReason: choice?.finish_reason || 'stop',
          usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens ?? 0,
                completionTokens: data.usage.completion_tokens ?? 0,
                totalTokens: data.usage.total_tokens ?? 0,
                ...(data.usage.completion_tokens_details?.reasoning_tokens !== undefined
                  ? { reasoningTokens: data.usage.completion_tokens_details.reasoning_tokens }
                  : {}),
              }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true },
        };
      } catch (err) {
        if (
          err instanceof GatewayError &&
          (err.status === 401 || err.status === 403 || err.status === 429)
        ) {
          if (this.getActiveAccounts().length > 0) {
            continue;
          }
        }
        throw err;
      }
    }

    throw lastError || new GatewayError(500, '500', 'Failed to execute DeepSeek request');
    } finally {
      for (const release of reservations) release();
    }
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const activeAccounts = this.getActiveAccounts();
    if (activeAccounts.length === 0) {
      const now = Date.now();
      const cooling = this.accounts.filter((a) => a.cooldownUntil && a.cooldownUntil > now);
      const minCooldown =
        cooling.length > 0 ? Math.min(...cooling.map((a) => a.cooldownUntil!)) : now + 30000;
      const retryAfter = Math.max(1, Math.ceil((minCooldown - now) / 1000));
      throw new GatewayError(429, '429', 'All DeepSeek accounts in cooldown / rate limit reached', {
        retryAfter,
      });
    }

    const attempts = Math.max(1, activeAccounts.length);
    let lastError: any = null;
    let streamRes: Response | null = null;
    let servingAccount: StoredAccount | null = null;
    const triedIds = new Set<string>();
    const sessionKey = req.affinity?.sessionKey;
    const preferredId = sessionKey ? this.affinityStore.getAccount(sessionKey, this.id) : undefined;
    const reservations: Array<() => void> = [];
    let handedOff = false;

    try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reservation = globalAccountPool.acquireAccount(activeAccounts, { preferredId, triedIds, signal });
      if (!reservation) continue;
      const account = reservation.account;
      reservations.push(reservation.release);
      triedIds.add(account.id);
      account.lastUsedAt = Date.now();
      req.accountId = account.id;

      const headers = this.buildHeaders(account, req.rawHeaders?.['user-agent']);
      const url = this.getCompletionUrl();
      const body = this.buildRequestBody(req, account, true);

      try {
        const res = await safeFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (res.status === 401 || res.status === 403) {
          account.status = 'expired';
          account.errorCount = (account.errorCount || 0) + 1;
          account.cooldownUntil = Date.now() + 10 * 60 * 1000;
          lastError = new GatewayError(
            res.status,
            String(res.status),
            `DeepSeek web session expired (HTTP ${res.status})`
          );
          if (this.getActiveAccounts().length > 0) {
            continue;
          }
          throw lastError;
        }

        if (res.status === 429) {
          const bodyText = await res.text().catch(() => '');
          const retryAfter = parseDeepSeekRetryAfter(res.headers.get('retry-after'), bodyText);
          account.status = 'cooldown';
          account.cooldownUntil = Date.now() + retryAfter * 1000;
          account.errorCount = (account.errorCount || 0) + 1;
          lastError = new GatewayError(429, '429', 'DeepSeek rate limit reached', { retryAfter });
          if (this.getActiveAccounts().length > 0) {
            continue;
          }
          throw lastError;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          throw new GatewayError(
            res.status,
            String(res.status),
            `DeepSeek stream error: ${errText || res.statusText}`
          );
        }

        if (!res.body) {
          throw new GatewayError(502, 'bad_gateway', 'DeepSeek empty stream');
        }

        servingAccount = account;
        account.errorCount = 0;
        if (sessionKey) this.affinityStore.pinAccount(sessionKey, this.id, account.id);
        streamRes = res;
        break;
      } catch (err) {
        if (
          err instanceof GatewayError &&
          (err.status === 401 || err.status === 403 || err.status === 429)
        ) {
          if (this.getActiveAccounts().length > 0) {
            continue;
          }
        }
        throw err;
      }
    }

    if (!streamRes || !streamRes.body) {
      throw lastError || new GatewayError(500, '500', 'Failed to establish DeepSeek stream');
    }

    const res = streamRes;
    const timestamp = Math.floor(Date.now() / 1000);
    const reqId = req.id;
    const reqModel = req.model;

    const rawStream = (async function* (): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: reqId, model: reqModel, created: timestamp };

      const thinkingDeltas: string[] = [];
      const textDeltas: string[] = [];

      const extractor = new StreamingThinkingExtractor(
        (td) => thinkingDeltas.push(td),
        (cd) => textDeltas.push(cd)
      );

      let stopReason: CanonicalStopReason = 'stop';
      let usage: CanonicalUsage | undefined;
      let lastFragmentType: string | null = null;

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') break;

        try {
          const parsed = JSON.parse(sse.data);

          // 1. Direct OpenAI format delta
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            if (delta.reasoning_content) {
              yield { type: 'thinking_delta', delta: delta.reasoning_content };
            }
            if (delta.content) {
              extractor.processChunk(delta.content);
              while (thinkingDeltas.length > 0) {
                yield { type: 'thinking_delta', delta: thinkingDeltas.shift()! };
              }
              while (textDeltas.length > 0) {
                yield { type: 'text_delta', delta: textDeltas.shift()! };
              }
            }
            if (parsed.choices?.[0]?.finish_reason) {
              stopReason = parsed.choices[0].finish_reason;
            }
          }

          // 2. Native DeepSeek Web patch format (p & v)
          if (parsed.p !== undefined) {
            if (parsed.p === 'response/fragments/-1/content' && typeof parsed.v === 'string') {
              if (lastFragmentType === 'THINK' || lastFragmentType === 'REASONING') {
                yield { type: 'thinking_delta', delta: parsed.v };
              } else {
                extractor.processChunk(parsed.v);
                while (thinkingDeltas.length > 0) {
                  yield { type: 'thinking_delta', delta: thinkingDeltas.shift()! };
                }
                while (textDeltas.length > 0) {
                  yield { type: 'text_delta', delta: textDeltas.shift()! };
                }
              }
            }
            if (parsed.p === 'response/fragments' && Array.isArray(parsed.v)) {
              for (const frag of parsed.v) {
                if (frag && typeof frag === 'object') {
                  lastFragmentType = frag.type;
                  if ((frag.type === 'THINK' || frag.type === 'REASONING') && frag.content) {
                    yield { type: 'thinking_delta', delta: frag.content };
                  } else if (frag.content) {
                    extractor.processChunk(frag.content);
                    while (thinkingDeltas.length > 0) {
                      yield { type: 'thinking_delta', delta: thinkingDeltas.shift()! };
                    }
                    while (textDeltas.length > 0) {
                      yield { type: 'text_delta', delta: textDeltas.shift()! };
                    }
                  }
                }
              }
            }
          }

          // Native response object with fragments
          if (parsed.v?.response?.fragments && Array.isArray(parsed.v.response.fragments)) {
            for (const frag of parsed.v.response.fragments) {
              lastFragmentType = frag.type;
              if ((frag.type === 'THINK' || frag.type === 'REASONING') && frag.content) {
                yield { type: 'thinking_delta', delta: frag.content };
              } else if (frag.content) {
                extractor.processChunk(frag.content);
                while (thinkingDeltas.length > 0) {
                  yield { type: 'thinking_delta', delta: thinkingDeltas.shift()! };
                }
                while (textDeltas.length > 0) {
                  yield { type: 'text_delta', delta: textDeltas.shift()! };
                }
              }
            }
          }

          // Usage reporting
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens || 0,
              completionTokens: parsed.usage.completion_tokens || 0,
              totalTokens: parsed.usage.total_tokens || 0,
            };
            yield { type: 'usage', usage };
          }
        } catch {
          // ignore malformed SSE data lines
        }
      }

      // Flush remainder from extractor
      extractor.flush();
      while (thinkingDeltas.length > 0) {
        yield { type: 'thinking_delta', delta: thinkingDeltas.shift()! };
      }
      while (textDeltas.length > 0) {
        yield { type: 'text_delta', delta: textDeltas.shift()! };
      }

      yield { type: 'stream_end', stopReason, usage };
    })();

    handedOff = true;
    return (async function* (): AsyncGenerator<CanonicalStreamEvent> {
      try {
        yield* rawStream;
      } finally {
        for (const release of reservations) release();
      }
    })();
    } finally {
      if (!handedOff) for (const release of reservations) release();
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const active = this.getActiveAccounts();
    return {
      healthy: active.length > 0,
      checkedAt: Date.now(),
      message: `${active.length}/${this.accounts.length} DeepSeek sessions active`,
    };
  }

  classifyError(error: unknown, statusCode?: number): ErrorClassificationResult {
    if (statusCode === 401 || statusCode === 403) {
      return {
        category: 'authentication',
        isRetryable: false,
        message: 'DeepSeek cookies/session expired or forbidden',
      };
    }
    if (statusCode === 429) {
      return {
        category: 'rate_limit',
        isRetryable: true,
        cooldownDurationMs: 60_000,
        message: 'DeepSeek rate limit reached',
      };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
