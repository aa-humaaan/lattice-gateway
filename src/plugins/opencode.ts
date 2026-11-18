import fs from 'node:fs';
import path from 'node:path';
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
  CanonicalToolDefinition,
  CanonicalToolChoice,
  CanonicalContentPart,
  CanonicalStopReason,
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { parseSSEStream } from '../utils/sse-parser';
import { serializeOpenAIMessages } from '../engine/dialect/serializer';
import { globalCredentialResolver, type CredentialResolver } from '../core/credential-resolver';
import { globalAccountPool } from '../pool/account-pool';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ZenGateToolDefinition {
  name: string;
  description: string;
  parameters_chat: Record<string, unknown>;
  parameters_responses?: Record<string, unknown>;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

// Backward-compatible interface
export interface ZenGateTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

// ============================================================================
// Authentic OpenCode Session & Tracing ID Generators
// Bit-inverted descending timestamp algorithm matching kit.MintZenSessionID
// ============================================================================

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const HEX_DIGITS = '0123456789abcdef';

/** Sentinel bearer for anonymous free-tier traffic (opencode CLI anonymous account). */
const ZEN_ANONYMOUS_KEY = 'public';
/** CLI v2 user-agent; older gateway UA strings are a non-CLI fingerprint. */
const ZEN_USER_AGENT = 'opencode/latest/2.2.7/cli';

/** The CLI appends this to its system prompt; the free tier requires the
 *  "Working directory:" line inside an <env> block. Value is not validated. */
export function zenEnvBlock(): string {
  return `<env>\n  Working directory: ${process.cwd()}\n</env>`;
}

function hasEnvMarker(text: string): boolean {
  return text.includes('<env>') && text.includes('Working directory:');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as any).text) : ''))
      .join('\n');
  }
  return '';
}

/** Append the env marker to the first system/developer message, or prepend a
 *  system message when the client sent none. Never duplicates an existing
 *  marker and never mutates the caller's messages. */
export function ensureZenEnvMarker(messages: any[]): any[] {
  if (
    messages.some(
      (m) =>
        (m?.role === 'system' || m?.role === 'developer') && hasEnvMarker(textOf(m.content))
    )
  ) {
    return messages;
  }
  const out = messages.map((m) => ({ ...m }));
  const system = out.find((m) => m.role === 'system' || m.role === 'developer');
  if (system) {
    if (typeof system.content === 'string') {
      system.content = `${system.content}\n\n${zenEnvBlock()}`;
    } else if (Array.isArray(system.content)) {
      system.content = [...system.content, { type: 'text', text: zenEnvBlock() }];
    } else {
      system.content = zenEnvBlock();
    }
  } else {
    out.unshift({ role: 'system', content: zenEnvBlock() });
  }
  return out;
}

let lastTimestamp = 0n;
let counter = 0n;

/**
 * Mint a descending ID matching official OpenCode CLI format:
 * prefix (4 chars) + 12 lowercase hex + 14 random base62 characters = 30 chars.
 * Matches: ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
 */
export function mintDescendingId(prefix = 'ses_'): string {
  const now = BigInt(Date.now());
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0n;
  }
  counter++;

  // Low 48 bits: (now << 12 | counter) & 0xFFFFFFFFFFFF
  const val = ((now << 12n) | counter) & 0xffffffffffffn;
  const inv = 0xffffffffffffn - val;

  let hexPart = '';
  for (let i = 0; i < 6; i++) {
    const shift = BigInt(40 - 8 * i);
    const byte = Number((inv >> shift) & 0xffn);
    hexPart += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f];
  }

  const randBytes = crypto.getRandomValues(new Uint8Array(14));
  let randPart = '';
  for (let i = 0; i < 14; i++) {
    randPart += BASE62_CHARS[randBytes[i] % 62];
  }

  return prefix + hexPart + randPart;
}

export function mintZenSessionId(): string {
  return mintDescendingId('ses_');
}

export function isValidZenSessionId(s: string): boolean {
  if (typeof s !== 'string' || s.length !== 30 || !s.startsWith('ses_')) {
    return false;
  }
  for (let i = 4; i < 16; i++) {
    const c = s[i];
    if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) return false;
  }
  for (let i = 16; i < 30; i++) {
    const c = s[i];
    if (
      (c < '0' || c > '9') &&
      (c < 'A' || c > 'Z') &&
      (c < 'a' || c > 'z')
    ) {
      return false;
    }
  }
  return true;
}

function randomHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates official OpenCode b3 and traceparent tracing headers.
 * b3: <32hex>-<16hex>-1-<16hex> (traceID-spanID-sampled-parentSpanID)
 * traceparent: 00-<32hex>-<16hex>-01
 */
export function generateTracingHeaders(): { b3: string; traceparent: string } {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const parentSpanId = randomHex(8);

  return {
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

// ============================================================================
// Gate Tools Definitions Loader
// ============================================================================

export function loadZenGateTools(customPath?: string): ZenGateToolDefinition[] {
  const candidatePaths = [
    customPath,
    process.env.ZEN_GATE_TOOLS_PATH,
    path.join(__dirname, 'zen_gate_tools.json'),
    path.join(process.cwd(), 'src', 'plugins', 'zen_gate_tools.json'),
  ].filter(Boolean) as string[];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 12) {
          return parsed as ZenGateToolDefinition[];
        }
      }
    } catch {
      // ignore and try next path
    }
  }

  // Fallback to static minimal 12 specs if file is unavailable
  return getFallbackGateTools();
}

function getFallbackGateTools(): ZenGateToolDefinition[] {
  const names = [
    'edit', 'glob', 'grep', 'question', 'read', 'shell',
    'skill', 'subagent', 'webfetch', 'websearch', 'write', 'execute'
  ];
  return names.map((name) => ({
    name,
    description: `OpenCode Zen gate tool: ${name}`,
    parameters_chat: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: [],
    },
  }));
}

// ============================================================================
// Provider Plugin Implementation
// ============================================================================

export class OpenCodeProviderPlugin implements ProviderPlugin {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode Zen Provider Plugin';
  readonly description = 'Keyless anonymous and API-key free model inference gateway';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['anonymous', 'api_key'] as const;

  public cachedGateTools: ZenGateToolDefinition[] = [];
  public currentSessionId?: string;
  public currentParentSessionId?: string;
  public sessionResetCount = 0;
  public account?: StoredAccount;

  constructor(
    defaultBaseUrl = 'https://opencode.ai/inference/openai/v1',
    account?: StoredAccount,
    private readonly credentialResolver: CredentialResolver = globalCredentialResolver
  ) {
    this.defaultBaseUrl = defaultBaseUrl;
    this.account = account;
    this.resetSession();
    this.cachedGateTools = loadZenGateTools();
  }

  setAccount(account: StoredAccount): void {
    this.account = account;
  }

  /**
   * Mints authentic anonymous session IDs for both x-opencode-session-id
   * and x-opencode-parent-session-id matching ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
   */
  mintSession(): { sessionId: string; parentSessionId: string } {
    this.currentSessionId = mintZenSessionId();
    this.currentParentSessionId = mintZenSessionId();
    return {
      sessionId: this.currentSessionId,
      parentSessionId: this.currentParentSessionId,
    };
  }

  /**
   * Resets the active session and increments reset count (triggered on 403 FreeTierError).
   */
  resetSession(): void {
    this.mintSession();
    this.sessionResetCount++;
  }

  /**
   * Clear session explicitly (for testing session mint on next request).
   */
  clearSession(): void {
    this.currentSessionId = undefined;
    this.currentParentSessionId = undefined;
    this.sessionResetCount++;
  }

  /**
   * Parse upstream Retry-After header (seconds integer or RFC HTTP date).
   */
  parseRetryAfter(header?: string | null): number {
    if (!header) return 20;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      const secs = parseInt(trimmed, 10);
      return secs > 0 ? secs : 20;
    }
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate)) {
      const deltaSec = Math.ceil((parsedDate - Date.now()) / 1000);
      return deltaSec > 0 ? deltaSec : 20;
    }
    return 20;
  }

  /** Turn an upstream 429 body into a clear, actionable message and cooldown reason. */
  private describeRateLimit(errorBody: string, retryAfter: number): string {
    let parsed: any;
    try {
      parsed = JSON.parse(errorBody);
    } catch {
      // Non-JSON upstream error — fall back to a generic message.
    }
    const type = parsed?.error?.type || parsed?.type || '';
    const upstream = parsed?.error?.message || '';
    if (type === 'FreeUsageLimitError' || /free usage limit reached/i.test(upstream)) {
      return `OpenCode free usage limit reached — connect with your own API key or subscribe to OpenCode Go (https://opencode.ai/go). Retry in ${retryAfter}s.`;
    }
    return `OpenCode Zen rate limit${upstream ? `: ${upstream}` : ''} (retry in ${retryAfter}s)`;
  }

  /**
   * Loads the 12 gate tools from disk or cache.
   */
  async fetchGateTools(): Promise<ZenGateToolDefinition[]> {
    if (this.cachedGateTools.length === 12) {
      return this.cachedGateTools;
    }
    this.cachedGateTools = loadZenGateTools();
    return this.cachedGateTools;
  }

  /**
   * Canonical model catalog for OpenCode Zen.
   */
  public cachedModels: ModelDescriptor[] = [
    {
      id: 'big-pickle',
      name: 'OpenCode Big Pickle (Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 200000,
      maxOutputTokens: 32000,
      supportsThinking: false,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'coding', 'fast'],
    },
    {
      id: 'mimo-v2.6-flash-free',
      name: 'Mimo V2.6 Flash (Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
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
      id: 'deepseek-v4.1-flash-free',
      name: 'DeepSeek V4.1 Flash (Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 128000,
      maxOutputTokens: 16000,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'reasoning', 'coding'],
    },
    {
      id: 'nemotron-3.5-lightning-free',
      name: 'Nemotron 3.5 Lightning (Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 262144,
      maxOutputTokens: 16384,
      supportsThinking: false,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'fast', 'large-context'],
    },
    {
      id: 'muse-spark-1.3-contributor-free',
      name: 'OpenCode Muse Spark 1.3 (1M Context Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'keyless', '1m', 'reasoning'],
    },
    {
      id: 'muse-spark-1.2-contributor-free',
      name: 'OpenCode Muse Spark 1.2 (1M Context Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'keyless', '1m', 'reasoning'],
    },
    {
      id: 'nemotron-3-ultra-free',
      name: 'OpenCode Nemotron 3 Ultra (1M Context Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      supportsThinking: true,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'keyless', '1m', 'massive'],
    },
    {
      id: 'ling-3.0-flash-fin-free',
      name: 'OpenCode Ling 3.0 Flash Fin (Free)',
      providerId: 'opencode',
      ownedBy: 'opencode',
      created: 1731693600,
      contextWindow: 262144,
      maxOutputTokens: 32768,
      supportsThinking: false,
      supportsTools: true,
      supportsStreaming: true,
      isFree: true,
      tags: ['free', 'keyless', 'fast'],
    },
  ];

  async listModels(): Promise<ModelDescriptor[]> {
    return this.cachedModels;
  }

  /**
   * Builds the CLI v2 gate headers. A fresh session is minted per call (the
   * official CLI does the same); the four session headers carry the same ID.
   * Anonymous traffic uses the "public" sentinel bearer — upstream rejects
   * requests with no Authorization header on the free tier.
   */
  public buildHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    this.mintSession();
    const { b3, traceparent } = generateTracingHeaders();

    const creds = this.credentialResolver.credentialsFor(this.account);
    const key = creds.apiKey || ZEN_ANONYMOUS_KEY;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'connection': 'keep-alive',
      'user-agent': ZEN_USER_AGENT,
      'authorization': `Bearer ${key}`,
      'b3': b3,
      'traceparent': traceparent,
      'x-opencode-session-id': this.currentSessionId!,
      'x-opencode-session': this.currentSessionId!,
      'x-session-affinity': this.currentSessionId!,
      'x-session-id': this.currentSessionId!,
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
    };

    const org = creds.organizationId || (creds as any).orgId;
    if (org) {
      headers['x-opencode-org-id'] = String(org);
    }

    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers[k.toLowerCase()] = v;
      }
    }

    return headers;
  }

  /**
   * Resolves the real chat completions URL.
   * Real base: https://opencode.ai/inference/openai/v1 -> https://opencode.ai/inference/openai/v1/chat/completions
   */
  public getChatEndpointUrl(): string {
    const base = ((this.account as any)?.baseUrl || (this.account?.credentials?.customData?.baseUrl as string | undefined) || this.defaultBaseUrl).replace(/\/+$/, '');
    if (base.endsWith('/chat/completions') || base.endsWith('/completions')) {
      return base;
    }
    return `${base}/chat/completions`;
  }

  /**
   * Converts the 12 gate tools to OpenAI function calling format.
   */
  public getOpenAIGateTools(): OpenAIToolDefinition[] {
    const tools = this.cachedGateTools.length === 12 ? this.cachedGateTools : loadZenGateTools();
    return tools.map((gt) => ({
      type: 'function' as const,
      function: {
        name: gt.name,
        description: gt.description,
        parameters: gt.parameters_chat,
        strict: false,
      },
    }));
  }

  /**
   * Injects gate tools and enforces tool_choice: "none" when client has no tools.
   */
  public mergeWithGateTools(
    clientTools?: CanonicalToolDefinition[],
    clientToolChoice?: CanonicalToolChoice
  ): { tools: any[]; toolChoice?: any } {
    const gateTools = this.getOpenAIGateTools();

    if (!clientTools || clientTools.length === 0) {
      // Client has no tools: inject all 12 gate tools and set tool_choice to "none"
      // to satisfy gate validator while preventing model hallucinations.
      return {
        tools: gateTools,
        toolChoice: clientToolChoice || 'none',
      };
    }

    // Merge: client tools first, followed by missing gate tools
    const merged: any[] = [];
    const provided = new Set<string>();

    for (const t of clientTools) {
      const name = t.function?.name || (t as any).name;
      if (name && !provided.has(name)) {
        provided.add(name);
        merged.push(t);
      }
    }

    for (const gt of gateTools) {
      if (!provided.has(gt.function.name)) {
        provided.add(gt.function.name);
        merged.push(gt);
      }
    }

    return {
      tools: merged,
      toolChoice: clientToolChoice,
    };
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers = this.buildHeaders();
    const endpoint = this.getChatEndpointUrl();
    const model = req.model.replace(/^opencode\//, '');
    const { tools, toolChoice } = this.mergeWithGateTools(req.tools, req.toolChoice);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: ensureZenEnvMarker(serializeOpenAIMessages(req.messages, req.systemPrompt)),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: toolChoice,
        stream: false,
      }),
      signal,
    });

    if (res.status === 403) {
      this.resetSession();
      let errorBody = '';
      try {
        errorBody = await res.text();
      } catch {
        // ignore
      }
      const isFreeTier =
        errorBody.toLowerCase().includes('freetier') ||
        errorBody.toLowerCase().includes('free tier');
      throw new GatewayError(
        403,
        'permission_denied',
        `OpenCode Zen ${isFreeTier ? 'FreeTierError' : 'anti-bot verification'} failure (auto-reset): ${errorBody || res.statusText}`,
        { providerId: this.id }
      );
    }

    if (res.status === 429) {
      const rawRetry = res.headers.get('retry-after');
      const retryAfter = this.parseRetryAfter(rawRetry);
      let errorBody = '';
      try {
        errorBody = await res.text();
      } catch {
        // ignore
      }
      const message = this.describeRateLimit(errorBody, retryAfter);
      if (this.account?.id) {
        globalAccountPool.reportRateLimit(this.account.id, retryAfter, message);
      }
      throw new GatewayError(
        429,
        'rate_limit',
        message,
        { retryAfter, retryAfterMs: retryAfter * 1000, providerId: this.id }
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new GatewayError(
        res.status,
        String(res.status),
        `OpenCode Zen upstream error: ${res.statusText} ${errText}`
      );
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const canonicalId =
      req.clientDialect === 'anthropic-messages' || req.id.startsWith('msg_')
        ? (req.id.startsWith('msg_') ? req.id : `msg_${req.id.replace(/^req_lat_/, '')}`)
        : (data.id || req.id);

    const contentParts: CanonicalContentPart[] = [];

    // Thinking / reasoning tokens
    if (choice?.message?.reasoning_content) {
      contentParts.push({
        type: 'thinking',
        thinking: choice.message.reasoning_content,
      });
    }

    // Text content
    if (choice?.message?.content) {
      contentParts.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    // Tool calls
    if (Array.isArray(choice?.message?.tool_calls)) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};
        } catch {
          args = { raw: tc.function?.arguments };
        }
        contentParts.push({
          type: 'tool_use',
          id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
          name: tc.function?.name || 'tool',
          input: args,
        });
      }
    }

    if (contentParts.length === 0) {
      contentParts.push({ type: 'text', text: '' });
    }

    const stopReason =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_calls'
        : choice?.finish_reason || 'stop';

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
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const headers = this.buildHeaders();
    const endpoint = this.getChatEndpointUrl();
    const model = req.model.replace(/^opencode\//, '');
    const { tools, toolChoice } = this.mergeWithGateTools(req.tools, req.toolChoice);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: ensureZenEnvMarker(serializeOpenAIMessages(req.messages, req.systemPrompt)),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: toolChoice,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!res.ok) {
      if (res.status === 403) {
        this.resetSession();
        let errorBody = '';
        try {
          errorBody = await res.text();
        } catch {
          // ignore
        }
        const isFreeTier =
          errorBody.toLowerCase().includes('freetier') ||
          errorBody.toLowerCase().includes('free tier');
        throw new GatewayError(
          403,
          'permission_denied',
          `OpenCode Zen ${isFreeTier ? 'FreeTierError' : 'anti-bot verification'} failure (auto-reset): ${errorBody || res.statusText}`,
          { providerId: this.id }
        );
      }
      if (res.status === 429) {
        const rawRetry = res.headers.get('retry-after');
        const retryAfter = this.parseRetryAfter(rawRetry);
        let errorBody = '';
        try {
          errorBody = await res.text();
        } catch {
          // ignore
        }
        const message = this.describeRateLimit(errorBody, retryAfter);
        if (this.account?.id) {
          globalAccountPool.reportRateLimit(this.account.id, retryAfter, message);
        }
        throw new GatewayError(
          429,
          'rate_limit',
          message,
          { retryAfter, retryAfterMs: retryAfter * 1000, providerId: this.id }
        );
      }
      const errText = await res.text().catch(() => '');
      throw new GatewayError(
        res.status,
        String(res.status),
        `OpenCode Zen stream error: ${res.statusText} ${errText}`
      );
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'OpenCode empty stream response');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const reqId = req.id;
    const reqModel = req.model;

    return (async function* () {
      yield { type: 'stream_start', id: reqId, model: reqModel, created: timestamp };

      let finishReason: string | undefined;

      for await (const sse of parseSSEStream(res.body!)) {
        if (sse.data === '[DONE]') break;

        try {
          const parsed = JSON.parse(sse.data);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          if (delta?.content) {
            yield { type: 'text_delta', delta: delta.content };
          }

          if (delta?.reasoning_content) {
            yield { type: 'thinking_delta', delta: delta.reasoning_content };
          }

          if (Array.isArray(delta?.tool_calls)) {
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
                reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
              },
            };
          }
        } catch {
          // ignore partial JSON parse errors
        }
      }

      const stopReason: CanonicalStopReason =
        finishReason === 'tool_calls'
          ? 'tool_calls'
          : finishReason === 'length'
            ? 'length'
            : finishReason === 'content_filter'
              ? 'content_filter'
              : 'stop';
      yield { type: 'stream_end', stopReason };
    })();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      checkedAt: Date.now(),
      message: `OpenCode Zen anonymous session active (${this.currentSessionId})`,
    };
  }

  classifyError(error: unknown, statusCode?: number): ErrorClassificationResult {
    const status = statusCode ?? (error instanceof GatewayError ? error.status : undefined);
    if (status === 403) {
      return {
        category: 'permission_denied',
        isRetryable: true,
        cooldownDurationMs: 5000,
        message: 'OpenCode Zen FreeTierError: session reset triggered',
      };
    }
    if (status === 429) {
      const retryAfterSec =
        error instanceof GatewayError && error.retryAfter ? error.retryAfter : 120;
      return {
        category: 'rate_limit',
        isRetryable: true,
        cooldownDurationMs: retryAfterSec * 1000,
        message: `OpenCode Zen rate limit (cooldown: ${retryAfterSec}s)`,
      };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
