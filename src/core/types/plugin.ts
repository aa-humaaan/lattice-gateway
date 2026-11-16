import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from './canonical';

// ============================================================================
// Auth & Account Archetypes
// ============================================================================

export type AuthType = 'oauth' | 'cookie_pool' | 'api_key' | 'anonymous';

export type AccountStatus =
  | 'active'
  | 'cooldown'
  | 'suspended'
  | 'expired'
  | 'invalid';

export interface StoredAccount {
  id: string;
  providerId: string;
  authType: AuthType;
  credentials: {
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
    cookies?: Record<string, string> | string;
    organizationId?: string;
    email?: string;
    baseUrl?: string;
    accountId?: string;
    customData?: Record<string, unknown>;
  };
  status: AccountStatus;
  cooldownUntil?: number;        // Epoch ms
  cooldownReason?: string;
  createdAt: number;             // Epoch ms
  updatedAt: number;             // Epoch ms
  lastUsedAt?: number;           // Epoch ms
  errorCount: number;
  rateLimitResetAt?: number;     // Epoch ms
}

// ============================================================================
// Model Descriptors & Catalog
// ============================================================================

export interface ModelDescriptor {
  id: string;                    // Normalized ID (e.g., "kilo/claude-3-7-sonnet" or "big-pickle")
  name: string;                  // User-facing display name
  providerId?: string;           // Plugin ID owner
  ownedBy?: string;              // OpenAI owned_by field
  created?: number;              // Epoch seconds
  contextWindow?: number;        // Maximum input context length
  maxOutputTokens?: number;      // Maximum output token limit
  supportsThinking?: boolean;    // Supports chain-of-thought / thinking blocks
  supportsTools?: boolean;       // Supports structured tool/function calling
  supportsStreaming?: boolean;   // Supports SSE streaming
  isFree?: boolean;              // Tagged free-tier model
  tags?: string[];               // e.g., ["reasoning", "flagship", "coding"]
}

// ============================================================================
// Plugin Health & Request Configuration
// ============================================================================

export interface HealthCheckResult {
  healthy: boolean;
  latencyMs?: number;
  message?: string;
  checkedAt: number;
}

export interface UpstreamRequestConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface ErrorClassificationResult {
  category:
    | 'invalid_request'
    | 'authentication'
    | 'permission_denied'
    | 'not_found'
    | 'rate_limit'
    | 'upstream_error'
    | 'bad_gateway'
    | 'service_unavailable'
    | 'gateway_timeout';
  isRetryable: boolean;
  cooldownDurationMs?: number;
  message: string;
}

// ============================================================================
// ProviderPlugin Core Interface Contract
// ============================================================================

export interface ProviderPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly defaultBaseUrl: string;
  readonly supportedAuthTypes?: readonly AuthType[];

  // Catalog Discovery
  listModels(account?: StoredAccount): Promise<ModelDescriptor[]>;

  // Execution Handlers (Milestone 1 Core)
  execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse>;
  executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>>;

  // Lifecycle & Infrastructure Hooks (Milestone 2+)
  initialize?(context: { dataDir: string; logger: unknown }): Promise<void>;
  shutdown?(): Promise<void>;
  healthCheck?(account?: StoredAccount): Promise<HealthCheckResult>;
  refreshAuth?(account: StoredAccount): Promise<StoredAccount>;
  classifyError?(
    error: unknown,
    statusCode?: number,
    responseBody?: string,
    account?: StoredAccount
  ): ErrorClassificationResult;
}
