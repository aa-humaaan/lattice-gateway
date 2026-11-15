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

export interface ZenGateTool {
  name: string;
  description: string;
}

export class OpenCodeProviderPlugin implements ProviderPlugin {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode Zen Provider Plugin';
  readonly description = 'Keyless anonymous and API-key free model inference gateway';
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes = ['anonymous', 'api_key'] as const;

  public cachedGateTools: ZenGateTool[] = [];
  public currentSessionId?: string;
  public currentParentSessionId?: string;
  public sessionResetCount = 0;

  constructor(defaultBaseUrl = 'https://opencode.ai/inference') {
    this.defaultBaseUrl = defaultBaseUrl;
    this.resetSession();
  }

  resetSession(): void {
    this.currentSessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.currentParentSessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.sessionResetCount++;
  }

  async fetchGateTools(): Promise<ZenGateTool[]> {
    if (this.cachedGateTools.length > 0) return this.cachedGateTools;

    try {
      const res = await fetch(`${this.defaultBaseUrl}/api/gate/tools`, {
        method: 'GET',
        headers: { 'Connection': 'close' },
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        this.cachedGateTools = data.tools || [];
      }
    } catch {
      // fallback default gate tools
      this.cachedGateTools = [
        { name: 'read', description: 'Read file contents from filesystem' },
        { name: 'write', description: 'Write content to filesystem' },
        { name: 'execute', description: 'Execute command line terminal' },
      ];
    }
    return this.cachedGateTools;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'big-pickle',
        name: 'OpenCode Big Pickle (Free)',
        providerId: 'opencode',
        ownedBy: 'opencode',
        created: 1731693600,
        contextWindow: 128000,
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
        contextWindow: 128000,
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
        supportsThinking: true,
        supportsTools: true,
        supportsStreaming: true,
        isFree: true,
        tags: ['free', 'reasoning', 'coding'],
      },
    ];
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-opencode-session-id': this.currentSessionId || 'ses_anon',
      'x-opencode-parent-session-id': this.currentParentSessionId || 'ses_parent',
      'Connection': 'keep-alive',
      'User-Agent': 'opencode-client/2.2.7 (bun-runtime; windows-amd64)',
    };
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const headers = this.buildHeaders();
    const model = req.model.replace(/^opencode\//, '');
    const gateTools = await this.fetchGateTools();

    // Merge client tools with gate tools
    const combinedTools = [
      ...(req.tools || []),
      ...gateTools.map((gt) => ({
        type: 'function' as const,
        function: {
          name: gt.name,
          description: gt.description,
          parameters: { type: 'object', properties: {} },
        },
      })),
    ];

    const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        tools: combinedTools.length > 0 ? combinedTools : undefined,
        stream: false,
      }),
      signal,
    });

    if (res.status === 403) {
      this.resetSession();
      throw new GatewayError(403, '403', 'OpenCode Zen anti-bot verification or session expired (auto-reset)');
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 20);
      throw new GatewayError(429, '429', 'OpenCode Zen free-tier rate limit', { retryAfter });
    }
    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `OpenCode Zen error: ${res.statusText}`);
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
    const model = req.model.replace(/^opencode\//, '');
    const gateTools = await this.fetchGateTools();

    const combinedTools = [
      ...(req.tools || []),
      ...gateTools.map((gt) => ({
        type: 'function' as const,
        function: {
          name: gt.name,
          description: gt.description,
          parameters: { type: 'object', properties: {} },
        },
      })),
    ];

    const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        temperature: req.temperature,
        tools: combinedTools.length > 0 ? combinedTools : undefined,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      if (res.status === 403) {
        this.resetSession();
        throw new GatewayError(403, '403', 'OpenCode Zen anti-bot verification failure (auto-reset)');
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 20);
        throw new GatewayError(429, '429', 'OpenCode Zen rate limit', { retryAfter });
      }
      throw new GatewayError(res.status, String(res.status), `OpenCode stream error: ${res.statusText}`);
    }

    if (!res.body) {
      throw new GatewayError(502, 'bad_gateway', 'OpenCode empty stream response');
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
          // ignore
        }
      }

      yield { type: 'stream_end', stopReason: 'stop' };
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
    if (statusCode === 403) {
      return { category: 'permission_denied', isRetryable: true, cooldownDurationMs: 5000, message: 'Session reset needed' };
    }
    if (statusCode === 429) {
      return { category: 'rate_limit', isRetryable: true, cooldownDurationMs: 120_000, message: 'OpenCode Zen rate limit' };
    }
    return {
      category: 'upstream_error',
      isRetryable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
