import { z } from 'zod';

// ============================================================================
// Canonical Client Dialects & Roles
// ============================================================================

export type ClientDialect = 'openai-chat' | 'anthropic-messages' | 'openai-responses';

export const ClientDialectSchema = z.enum([
  'openai-chat',
  'anthropic-messages',
  'openai-responses',
]);

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';

export const CanonicalRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

// ============================================================================
// Canonical Content Parts
// ============================================================================

export interface CanonicalTextPart {
  type: 'text';
  text: string;
  cacheControl?: { type: 'ephemeral' };
}

export const CanonicalTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cacheControl: z.object({ type: z.literal('ephemeral') }).optional(),
});

export interface CanonicalImagePart {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    mediaType: string;
    data: string;
  };
}

export const CanonicalImagePartSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.enum(['base64', 'url']),
    mediaType: z.string(),
    data: z.string(),
  }),
});

export interface CanonicalThinkingPart {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export const CanonicalThinkingPartSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});

export interface CanonicalRedactedThinkingPart {
  type: 'redacted_thinking';
  data: string;
}

export const CanonicalRedactedThinkingPartSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});

export interface CanonicalToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown> | string;
}

export const CanonicalToolUsePartSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.union([z.record(z.unknown()), z.string()]),
});

export interface CanonicalToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  content: string | CanonicalContentPart[];
  isError?: boolean;
}

export const CanonicalToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  content: z.union([z.string(), z.array(z.lazy(() => CanonicalContentPartSchema))]),
  isError: z.boolean().optional(),
});

export type CanonicalContentPart =
  | CanonicalTextPart
  | CanonicalImagePart
  | CanonicalThinkingPart
  | CanonicalRedactedThinkingPart
  | CanonicalToolUsePart
  | CanonicalToolResultPart;

export const CanonicalContentPartSchema: z.ZodType<CanonicalContentPart> = z.lazy(() =>
  z.discriminatedUnion('type', [
    CanonicalTextPartSchema,
    CanonicalImagePartSchema,
    CanonicalThinkingPartSchema,
    CanonicalRedactedThinkingPartSchema,
    CanonicalToolUsePartSchema,
    CanonicalToolResultPartSchema,
  ])
);

// ============================================================================
// Canonical Message
// ============================================================================

export interface CanonicalMessage {
  role: CanonicalRole;
  content: string | CanonicalContentPart[];
  name?: string;
  toolCallId?: string; // Set when role === 'tool' (OpenAI format)
}

export const CanonicalMessageSchema = z.object({
  role: CanonicalRoleSchema,
  content: z.union([z.string(), z.array(CanonicalContentPartSchema)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
});

// ============================================================================
// Canonical Tools & Choice
// ============================================================================

export interface CanonicalToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export const CanonicalToolFunctionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().optional(),
});

export interface CanonicalToolDefinition {
  type: 'function';
  function: CanonicalToolFunction;
}

export const CanonicalToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: CanonicalToolFunctionSchema,
});

export type CanonicalToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export const CanonicalToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
    }),
  }),
]);

// ============================================================================
// Canonical Thinking & Request Configuration
// ============================================================================

export interface CanonicalThinkingConfig {
  type: 'enabled' | 'disabled' | 'adaptive';
  budgetTokens?: number;
}

export const CanonicalThinkingConfigSchema = z.object({
  type: z.enum(['enabled', 'disabled', 'adaptive']).or(z.string()),
  budgetTokens: z.number().int().positive().optional(),
});

export interface CanonicalRequest {
  id: string;                                 // Gateway trace ID: "req_lat_..."
  clientDialect: ClientDialect;              // Inbound client protocol
  model: string;                              // Requested model or combo ID
  messages: CanonicalMessage[];               // Normalized message array
  systemPrompt?: string;                      // Extracted top-level system prompt
  systemContent?: Array<{ type: 'text'; text: string; cacheControl?: { type: 'ephemeral' } }>;
  tools?: CanonicalToolDefinition[];          // Normalized tool definitions
  toolChoice?: CanonicalToolChoice;           // Normalized tool choice
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  n?: number;
  logitBias?: Record<string, number>;
  user?: string;
  responseFormat?: {
    type: 'text' | 'json_object' | 'json_schema';
    jsonSchema?: Record<string, unknown>;
  };
  maxTokens?: number;
  stop?: string[];
  stream: boolean;
  streamOptions?: {
    includeUsage?: boolean;
  };
  thinking?: CanonicalThinkingConfig;
  reasoningEffort?: 'low' | 'medium' | 'high';
  metadata?: Record<string, unknown>;
  rawHeaders?: Record<string, string>;
  affinity?: {
    sessionKey: string;
  };
  /** Account selected for execution; usage is charged to this id. */
  accountId?: string;
  /**
   * Provider that actually served the request. A virtual combo sets this to the
   * target provider it routed to, so the router can attribute usage, the ledger
   * and receipts to the real server instead of the combo itself.
   */
  servedByProviderId?: string;
}

export const CanonicalRequestSchema = z.object({
  id: z.string(),
  clientDialect: ClientDialectSchema,
  model: z.string().min(1),
  messages: z.array(CanonicalMessageSchema),
  systemPrompt: z.string().optional(),
  systemContent: z
    .array(
      z.object({
        type: z.literal('text'),
        text: z.string(),
        cacheControl: z.object({ type: z.literal('ephemeral') }).optional(),
      })
    )
    .optional(),
  tools: z.array(CanonicalToolDefinitionSchema).optional(),
  toolChoice: CanonicalToolChoiceSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  n: z.number().int().positive().optional(),
  logitBias: z.record(z.number()).optional(),
  user: z.string().optional(),
  responseFormat: z
    .object({
      type: z.enum(['text', 'json_object', 'json_schema']),
      jsonSchema: z.record(z.unknown()).optional(),
    })
    .optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  stream: z.boolean().default(false),
  streamOptions: z
    .object({
      includeUsage: z.boolean().optional(),
    })
    .optional(),
  thinking: CanonicalThinkingConfigSchema.optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  metadata: z.record(z.unknown()).optional(),
  rawHeaders: z.record(z.string()).optional(),
  affinity: z.object({ sessionKey: z.string() }).optional(),
});

// ============================================================================
// Canonical Outbound (Non-Streaming)
// ============================================================================

export type CanonicalStopReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error';

export const CanonicalStopReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
]);

export interface CanonicalUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  /** True when the upstream omitted usage and these counts are gateway estimates. */
  estimated?: boolean;
}

export const CanonicalUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  estimated: z.boolean().optional(),
});

export interface CanonicalResponse {
  id: string;
  model: string;
  created: number;
  content: CanonicalContentPart[];
  stopReason: CanonicalStopReason;
  usage: CanonicalUsage;
  rawProviderResponse?: unknown;
}

export const CanonicalResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  created: z.number(),
  content: z.array(CanonicalContentPartSchema),
  stopReason: CanonicalStopReasonSchema,
  usage: CanonicalUsageSchema,
  rawProviderResponse: z.unknown().optional(),
});

// ============================================================================
// Canonical Stream Events
// ============================================================================

export interface CanonicalError {
  code: string;
  message: string;
  status: number;
  param?: string | null;
  type: string;
}

export const CanonicalErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number().int(),
  param: z.string().nullable().optional(),
  type: z.string(),
});

export type CanonicalStreamEvent =
  | { type: 'stream_start'; id: string; model: string; created: number }
  | { type: 'thinking_delta'; delta: string; signature?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'tool_call_stop'; index: number }
  | { type: 'usage'; usage: CanonicalUsage }
  | { type: 'stream_end'; stopReason: CanonicalStopReason; usage?: CanonicalUsage }
  | { type: 'stream_error'; error: CanonicalError };
