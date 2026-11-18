import type {
  ProviderPlugin,
  ModelDescriptor,
  StoredAccount,
  HealthCheckResult,
  ErrorClassificationResult,
} from '../core/types/plugin';
import { globalAccountPool } from '../pool/account-pool';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { parseSSEStream } from '../utils/sse-parser';
import { serializeOpenAIMessages } from '../engine/dialect/serializer';
import { globalSessionAffinityStore, type SessionAffinityStore } from '../core/session-affinity';
import { globalCredentialResolver, type CredentialResolver } from '../core/credential-resolver';
import { failFastNetworkError } from '../utils/network-error';

// ============================================================================
// Genuine Production Constants & URLs (Audited from cline-proxy-main)
// ============================================================================

export const WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';
export const WORKOS_DEVICE_AUTH_URL = 'https://api.workos.com/user_management/authorize/device';
export const WORKOS_AUTHENTICATE_URL = 'https://api.workos.com/user_management/authenticate';
export const CLINE_API_BASE = 'https://api.cline.bot/api/v1';
export const CLINE_CHAT_URL = 'https://api.cline.bot/api/v1/chat/completions';
export const CLINE_CLIENT_VERSION = '3.0.70';
export const CLINE_CORE_VERSION = '0.0.92';

// Failover attempts before returning error
export const CLINE_FAILOVER_ATTEMPTS = 3;

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

export interface WorkOSTokenResponse {
  access_token: string;
  refresh_token: string;
}

export interface ClineAuthResponse {
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt?: number | string;
    userInfo?: {
      email?: string;
      id?: string;
    };
  };
}

export interface ClineRefreshResponse {
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt?: number | string;
  };
}

// ============================================================================
// Quota & Rate Limit Parsing Utilities
// ============================================================================

export const CLINE_QUOTA_KEYWORDS = [
  'quota exceeded',
  'quota exhausted',
  'exceeded your quota',
  'insufficient quota',
  'insufficient credit',
  'insufficient balance',
  'out of credit',
  'out of credits',
  'no credits',
  'no credit left',
  'daily limit reach',
  'daily limit exceed',
  'monthly limit reach',
  'monthly limit exceed',
  'usage limit reach',
  'usage limit exceed',
  'credit limit reach',
  'billing hard limit',
  'free tier limit',
] as const;

export function isClineQuotaExhausted(body: string): boolean {
  const low = body.toLowerCase();
  return CLINE_QUOTA_KEYWORDS.some((kw) => low.includes(kw));
}

export function parseHumanDurationSeconds(s: string): number {
  if (!s) return 0;
  let totalSeconds = 0;
  const regex = /(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:inutes?|ins?)?|s(?:econds?|ecs?)?)/gi;
  let match: RegExpExecArray | null;
  let matchedAny = false;
  while ((match = regex.exec(s)) !== null) {
    matchedAny = true;
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('d')) {
      totalSeconds += val * 86400;
    } else if (unit.startsWith('h')) {
      totalSeconds += val * 3600;
    } else if (unit.startsWith('m')) {
      totalSeconds += val * 60;
    } else if (unit.startsWith('s')) {
      totalSeconds += val;
    }
  }
  return matchedAny ? totalSeconds : 0;
}

export function parseClineRetryAfter(
  headerValue?: string | null,
  bodyText?: string | null
): number {
  if (headerValue) {
    const trimmed = headerValue.trim();
    const num = Number(trimmed);
    if (!isNaN(num) && num > 0) {
      return num;
    }
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate)) {
      const diffSec = Math.ceil((parsedDate - Date.now()) / 1000);
      if (diffSec > 0) return diffSec;
    }
  }

  const text = (bodyText || '') + ' ' + (headerValue || '');

  // Look for "Try again in ..."
  const idx = text.search(/try\s+again\s+in/i);
  if (idx >= 0) {
    const after = text.substring(idx + 12);
    const endIdx = after.search(/["\n\r}]/);
    const segment = endIdx >= 0 ? after.substring(0, endIdx) : after;
    const dur = parseHumanDurationSeconds(segment);
    if (dur > 0) return dur;
  }

  // Quota exhausted check (18 hours fallback)
  if (bodyText && isClineQuotaExhausted(bodyText)) {
    return 18 * 3600;
  }

  return 30; // Default fallback
}

export function parseClineExpiry(exp: unknown): number {
  if (typeof exp === 'number') {
    return exp < 10_000_000_000 ? exp * 1000 : exp;
  }
  if (typeof exp === 'string') {
    const parsed = Date.parse(exp);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now() + 3600_000;
}

// ============================================================================
// Authentic WorkOS & Cline Auth Flow Implementation
// ============================================================================

export async function startWorkosDeviceAuth(
  clientId = WORKOS_CLIENT_ID,
  authUrl = WORKOS_DEVICE_AUTH_URL
): Promise<DeviceAuthResponse> {
  const form = new URLSearchParams();
  form.set('client_id', clientId);

  const res = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`WorkOS device auth failed (${res.status}): ${errText}`);
  }

  return (await res.json()) as DeviceAuthResponse;
}

export async function pollWorkosToken(
  deviceCode: string,
  options?: {
    interval?: number;
    expiresIn?: number;
    clientId?: string;
    authenticateUrl?: string;
    signal?: AbortSignal;
  }
): Promise<WorkOSTokenResponse> {
  const interval = options?.interval !== undefined ? options.interval : 5;
  const expiresIn = options?.expiresIn ?? 300;
  const clientId = options?.clientId ?? WORKOS_CLIENT_ID;
  const authenticateUrl = options?.authenticateUrl ?? WORKOS_AUTHENTICATE_URL;

  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = interval;

  while (Date.now() < deadline) {
    if (options?.signal?.aborted) {
      throw new Error('Device authorization polling aborted');
    }

    const form = new URLSearchParams();
    form.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    form.set('device_code', deviceCode);
    form.set('client_id', clientId);

    const res = await fetch(authenticateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: options?.signal,
    });

    const data = (await res.json().catch(() => ({}))) as any;

    if (res.ok && data.access_token) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      };
    }

    if (data.error === 'authorization_pending') {
      await new Promise((r) => setTimeout(r, currentInterval * 1000));
      continue;
    }

    if (data.error === 'slow_down') {
      currentInterval += 5;
      await new Promise((r) => setTimeout(r, currentInterval * 1000));
      continue;
    }

    const desc = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`WorkOS polling error: ${desc}`);
  }

  throw new Error('Device authorization expired (timeout)');
}

export async function registerWithCline(
  workosAccess: string,
  workosRefresh: string,
  apiBase = CLINE_API_BASE
): Promise<ClineAuthResponse> {
  const url = apiBase.endsWith('/auth/register') ? apiBase : `${apiBase.replace(/\/+$/, '')}/auth/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: workosAccess,
      refreshToken: workosRefresh,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Cline registration failed (${res.status}): ${errText}`);
  }

  return (await res.json()) as ClineAuthResponse;
}

export async function refreshClineToken(
  refreshToken: string,
  apiBase = CLINE_API_BASE
): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }> {
  let url: string;
  if (apiBase.endsWith('/auth/refresh')) {
    url = apiBase;
  } else {
    const cleanBase = apiBase.replace(/\/+$/, '');
    url = cleanBase.endsWith('/api/v1')
      ? `${cleanBase}/auth/refresh`
      : `${cleanBase}/api/v1/auth/refresh`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken,
      grantType: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new GatewayError(res.status, String(res.status), `Cline token refresh failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as any;
  const accessToken = data.data?.accessToken || data.access_token || data.accessToken;
  const newRefreshToken =
    data.data?.refreshToken || data.refresh_token || data.refreshToken || refreshToken;
  const expiresAt = data.data?.expiresAt
    ? parseClineExpiry(data.data.expiresAt)
    : data.expires_in
    ? Date.now() + data.expires_in * 1000
    : undefined;

  if (!accessToken) {
    throw new GatewayError(500, '500', 'Cline refresh response missing access token');
  }

  return { accessToken, refreshToken: newRefreshToken, expiresAt };
}

// ============================================================================
// Cline Multi-Account Pool Provider Plugin
// ============================================================================

export class ClinePoolPlugin implements ProviderPlugin {
  readonly id = 'cline';
  readonly displayName = 'Cline Pool Upstream Plugin';
  readonly description = 'WorkOS OAuth pooled free & pass accounts for Cline IDEs';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['oauth', 'api_key'] as const;

  public accounts: StoredAccount[] = [];
  private activeAccountIndex = 0;

  constructor(
    defaultBaseUrl = CLINE_API_BASE,
    initialAccounts?: StoredAccount[],
    private readonly affinityStore: SessionAffinityStore = globalSessionAffinityStore,
    private readonly credentialResolver: CredentialResolver = globalCredentialResolver
  ) {
    this.defaultBaseUrl = defaultBaseUrl;
    if (initialAccounts && initialAccounts.length > 0) {
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

  setAccount(account: StoredAccount): void {
    this.addAccount(account);
  }

  removeAccount(id: string): boolean {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx >= 0) {
      this.accounts.splice(idx, 1);
      return true;
    }
    return false;
  }

  getAccount(id: string): StoredAccount | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  listAccounts(): StoredAccount[] {
    return [...this.accounts];
  }

  resetIndex(): void {
    this.activeAccountIndex = 0;
  }

  getActiveAccounts(): StoredAccount[] {
    const now = Date.now();
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && acc.cooldownUntil <= now) {
        acc.status = 'active';
        acc.cooldownUntil = undefined;
        acc.cooldownReason = undefined;
      }
    }
    return this.accounts.filter((a) => a.status === 'active');
  }

  getActiveAccount(excludingIds?: Set<string>, preferredId?: string): StoredAccount | undefined {
    let active = this.getActiveAccounts();
    if (excludingIds && excludingIds.size > 0) {
      active = active.filter((a) => !excludingIds.has(a.id));
    }
    if (active.length === 0) return undefined;
    const preferred = preferredId ? active.find((account) => account.id === preferredId) : undefined;
    if (preferred) return preferred;
    const acc = active[this.activeAccountIndex % active.length];
    this.activeAccountIndex++;
    return acc;
  }

  getNextAccount(excludingIds?: Set<string>): StoredAccount {
    const acc = this.getActiveAccount(excludingIds);
    if (!acc) {
      const lowestRetry = this.getLowestCooldownRemaining();
      throw new GatewayError(
        429,
        '429',
        'All Cline accounts are currently rate-limited or in cooldown',
        { retryAfter: lowestRetry }
      );
    }
    return acc;
  }

  getLowestCooldownRemaining(): number {
    const now = Date.now();
    let minWaitMs = 30_000;
    let found = false;
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && acc.cooldownUntil > now) {
        const diff = acc.cooldownUntil - now;
        if (!found || diff < minWaitMs) {
          minWaitMs = diff;
          found = true;
        }
      }
    }
    return Math.max(1, Math.ceil(minWaitMs / 1000));
  }

  async refreshToken(account: StoredAccount): Promise<StoredAccount> {
    const creds = this.credentialResolver.credentialsFor(account);
    const rt = creds.refreshToken;
    if (!rt) {
      throw new GatewayError(400, '400', `Account ${account.id} has no refreshToken to refresh`);
    }

    const refreshed = await refreshClineToken(rt, this.defaultBaseUrl);
    this.credentialResolver.storeCredential(account.id, 'accessToken', refreshed.accessToken);
    this.credentialResolver.storeCredential(account.id, 'refreshToken', refreshed.refreshToken);
    account.credentials.accessToken = refreshed.accessToken;
    account.credentials.refreshToken = refreshed.refreshToken;
    account.updatedAt = Date.now();
    return account;
  }

  async refreshAuth(account: StoredAccount): Promise<StoredAccount> {
    return this.refreshToken(account);
  }

  getChatUrl(): string {
    if (this.defaultBaseUrl.endsWith('/chat/completions')) {
      return this.defaultBaseUrl;
    }
    const cleanBase = this.defaultBaseUrl.replace(/\/+$/, '');
    if (cleanBase.endsWith('/api/v1') || cleanBase.endsWith('/v1')) {
      return `${cleanBase}/chat/completions`;
    }
    return `${cleanBase}/api/v1/chat/completions`;
  }

  buildHeaders(account?: StoredAccount, sessionId?: string): Record<string, string> {
    const acc = account || this.getActiveAccount();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `Cline/${CLINE_CLIENT_VERSION}`,
      'HTTP-Referer': 'https://cline.bot',
      'X-Title': 'Cline',
      'X-IS-MULTIROOT': 'false',
      'X-CLIENT-TYPE': 'cline-cli',
      'X-CLIENT-VERSION': CLINE_CLIENT_VERSION,
      'X-PLATFORM': 'cli',
      'X-PLATFORM-VERSION': CLINE_CLIENT_VERSION,
      'X-CORE-VERSION': CLINE_CORE_VERSION,
      'Connection': 'close',
    };

    if (sessionId) {
      headers['X-Task-ID'] = sessionId;
    }

    const creds = this.credentialResolver.credentialsFor(acc);
    const token = creds.accessToken || creds.apiKey;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  public cachedModels: ModelDescriptor[] = [
    {
      id: 'cline/claude-3-7-sonnet',
      name: 'Cline Claude 3.7 Sonnet',
      providerId: 'cline',
      ownedBy: 'cline',
      created: 1731693600,
      contextWindow: 200000,
      maxOutputTokens: 8192,
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
      maxOutputTokens: 8192,
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
      contextWindow: 200000,
      maxOutputTokens: 32000,
      supportsThinking: false,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'fast'],
    },
    {
      id: 'cline-free/step-5-preview',
      name: 'Cline Free Step-5 Preview',
      providerId: 'cline',
      ownedBy: 'cline',
      created: 1731693600,
      contextWindow: 1000000,
      maxOutputTokens: 8192,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'reasoning'],
    },
    {
      id: 'cline-free/solar-mini4',
      name: 'Cline Free Solar Mini 4',
      providerId: 'cline',
      ownedBy: 'cline',
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
      id: 'reflection/beam-free',
      name: 'Cline Free Beam 1.0 (1M Context)',
      providerId: 'cline',
      ownedBy: 'reflection',
      created: 1731693600,
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', '1m', 'reasoning'],
    },
    {
      id: 'poolside/laguna-s-2.1-free',
      name: 'Cline Free Laguna S 2.1',
      providerId: 'cline',
      ownedBy: 'poolside',
      created: 1731693600,
      contextWindow: 256000,
      maxOutputTokens: 32768,
      supportsThinking: false,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'fast'],
    },
  ];

  async listModels(): Promise<ModelDescriptor[]> {
    return this.cachedModels;
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const triedIds = new Set<string>();
    const maxAttempts = Math.max(1, Math.min(this.accounts.length, CLINE_FAILOVER_ATTEMPTS));
    let lastErr: unknown;
    const sessionKey = req.affinity?.sessionKey;
    const preferredId = sessionKey ? this.affinityStore.getAccount(sessionKey, this.id) : undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const account = this.getActiveAccount(triedIds, preferredId);
      if (!account) {
        if (lastErr) throw lastErr;
        const lowestRetry = this.getLowestCooldownRemaining();
        throw new GatewayError(
          429,
          '429',
          'All Cline accounts are currently rate-limited or suspended',
          { retryAfter: lowestRetry }
        );
      }
      triedIds.add(account.id);
      account.lastUsedAt = Date.now();

      const headers = this.buildHeaders(account, req.id);
      const model = req.model.replace(/^cline(-free)?\//, '');

      let res: Response;
      try {
        res = await fetch(this.getChatUrl(), {
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
      } catch (networkErr) {
        account.errorCount++;
        throw failFastNetworkError(networkErr);
      }

      // Handle 401 Unauthorized / Suspended
      if (res.status === 401) {
        account.status = 'suspended';
        account.errorCount++;
        lastErr = new GatewayError(401, '401', 'Cline account suspended or unauthorized');
        if (this.getActiveAccounts().some((candidate) => !triedIds.has(candidate.id))) {
          continue;
        }
        throw lastErr;
      }

      // Handle 429 Rate Limit Exceeded
      if (res.status === 429) {
        account.errorCount++;
        const rawBody = await res.text().catch(() => '');
        const retryAfter = parseClineRetryAfter(res.headers.get('retry-after'), rawBody);
        account.status = 'cooldown';
        account.cooldownUntil = Date.now() + retryAfter * 1000;
        account.cooldownReason = rawBody || 'Rate limit exceeded';

        globalAccountPool.reportRateLimit(account.id, retryAfter, rawBody || 'Cline rate limit');

        lastErr = new GatewayError(
          429,
          '429',
          `Cline rate limit exceeded. Retry in ${retryAfter}s`,
          { retryAfter }
        );
        continue;
      }

      if (!res.ok) {
        account.errorCount++;
        const errText = await res.text().catch(() => '');
        throw new GatewayError(res.status, String(res.status), `Cline upstream error: ${res.statusText} ${errText}`);
      }

      const data = (await res.json()) as any;
      if (sessionKey) this.affinityStore.pinAccount(sessionKey, this.id, account.id);
      return this.transformCanonicalResponse(data, req);
    }

    throw lastErr || new GatewayError(500, '500', 'Cline upstream execution exhausted all accounts');
  }

  private transformCanonicalResponse(data: any, req: CanonicalRequest): CanonicalResponse {
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
        completionTokens: data.usage?.completion_tokens || 15,
        totalTokens: data.usage?.total_tokens || 25,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const triedIds = new Set<string>();
    const maxAttempts = Math.max(1, Math.min(this.accounts.length, CLINE_FAILOVER_ATTEMPTS));
    let lastErr: unknown;
    const sessionKey = req.affinity?.sessionKey;
    const preferredId = sessionKey ? this.affinityStore.getAccount(sessionKey, this.id) : undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const account = this.getActiveAccount(triedIds, preferredId);
      if (!account) {
        if (lastErr) throw lastErr;
        const lowestRetry = this.getLowestCooldownRemaining();
        throw new GatewayError(
          429,
          '429',
          'All Cline accounts are in cooldown',
          { retryAfter: lowestRetry }
        );
      }
      triedIds.add(account.id);
      account.lastUsedAt = Date.now();

      const headers = this.buildHeaders(account, req.id);
      const model = req.model.replace(/^cline(-free)?\//, '');

      let res: Response;
      try {
        res = await fetch(this.getChatUrl(), {
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
      } catch (networkErr) {
        account.errorCount++;
        throw failFastNetworkError(networkErr);
      }

      if (res.status === 401) {
        account.status = 'suspended';
        account.errorCount++;
        lastErr = new GatewayError(401, '401', 'Cline token expired or suspended');
        if (this.getActiveAccounts().some((candidate) => !triedIds.has(candidate.id))) {
          continue;
        }
        throw lastErr;
      }

      if (res.status === 429) {
        account.errorCount++;
        const bodyText = await res.text().catch(() => '');
        const retryAfter = parseClineRetryAfter(res.headers.get('retry-after'), bodyText);
        account.status = 'cooldown';
        account.cooldownUntil = Date.now() + retryAfter * 1000;
        account.cooldownReason = bodyText || 'Rate limit reached';
        globalAccountPool.reportRateLimit(account.id, retryAfter, bodyText || 'Cline stream rate limit');
        lastErr = new GatewayError(429, '429', `Cline rate limit reached`, { retryAfter });
        continue;
      }

      if (!res.ok) {
        account.errorCount++;
        throw new GatewayError(res.status, String(res.status), `Cline upstream stream error: ${res.statusText}`);
      }

      if (!res.body) {
        throw new GatewayError(502, 'bad_gateway', 'Cline empty stream response');
      }

      if (sessionKey) this.affinityStore.pinAccount(sessionKey, this.id, account.id);
      return this.streamFromResponse(res, req);
    }

    throw lastErr || new GatewayError(500, '500', 'Cline upstream stream exhausted all accounts');
  }

  private streamFromResponse(
    res: Response,
    req: CanonicalRequest
  ): AsyncIterable<CanonicalStreamEvent> {
    const timestamp = Math.floor(Date.now() / 1000);
    const reqId = req.id;
    const reqModel = req.model;

    return (async function* () {
      yield { type: 'stream_start', id: reqId, model: reqModel, created: timestamp };

      let hasToolCalls = false;
      let stopReason: 'stop' | 'tool_calls' | 'length' = 'stop';

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') break;

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
          if (delta?.reasoning_content) {
            yield { type: 'thinking_delta', delta: delta.reasoning_content };
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
          // ignore malformed frame
        }
      }

      if (hasToolCalls) {
        stopReason = 'tool_calls';
      }

      yield { type: 'stream_end', stopReason };
    })();
  }

  async healthCheck(account?: StoredAccount): Promise<HealthCheckResult> {
    const active = this.getActiveAccounts();
    const target = account || active[0];

    return {
      healthy: active.length > 0,
      checkedAt: Date.now(),
      message: `${active.length}/${this.accounts.length} Cline accounts active${target ? ` (${target.id})` : ''}`,
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
