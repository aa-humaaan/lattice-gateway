import { z } from 'zod';

// ============================================================================
// OpenAI Tool Schemas
// ============================================================================

export const OpenAIToolFunctionSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  })
  .passthrough();

export const OpenAIToolSchema = z
  .object({
    type: z.literal('function'),
    function: OpenAIToolFunctionSchema,
  })
  .passthrough();

export type OpenAITool = z.infer<typeof OpenAIToolSchema>;

export const OpenAIToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
    }),
  }),
]);

export type OpenAIToolChoice = z.infer<typeof OpenAIToolChoiceSchema>;

// ============================================================================
// OpenAI Message Content Schemas
// ============================================================================

export const OpenAITextContentPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

export const OpenAIImageUrlContentPartSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  })
  .passthrough();

export const OpenAIContentPartSchema = z.union([
  OpenAITextContentPartSchema,
  OpenAIImageUrlContentPartSchema,
]);

export type OpenAIContentPart = z.infer<typeof OpenAIContentPartSchema>;

// ============================================================================
// OpenAI Tool Call in Assistant Message
// ============================================================================

export const OpenAIToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })
  .passthrough();

export type OpenAIToolCall = z.infer<typeof OpenAIToolCallSchema>;

// ============================================================================
// OpenAI Chat Messages
// ============================================================================

export const OpenAISystemMessageSchema = z
  .object({
    role: z.literal('system'),
    content: z.union([z.string(), z.array(OpenAITextContentPartSchema)]),
    name: z.string().optional(),
  })
  .passthrough();

export const OpenAIUserMessageSchema = z
  .object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(OpenAIContentPartSchema)]),
    name: z.string().optional(),
  })
  .passthrough();

export const OpenAIAssistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.union([z.string(), z.null()]).optional(),
    reasoning_content: z.union([z.string(), z.null()]).optional(),
    tool_calls: z.array(OpenAIToolCallSchema).optional(),
    refusal: z.union([z.string(), z.null()]).optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const OpenAIToolMessageSchema = z
  .object({
    role: z.literal('tool'),
    tool_call_id: z.string(),
    content: z.union([z.string(), z.array(OpenAITextContentPartSchema)]),
  })
  .passthrough();

export const OpenAIMessageSchema = z.discriminatedUnion('role', [
  OpenAISystemMessageSchema,
  OpenAIUserMessageSchema,
  OpenAIAssistantMessageSchema,
  OpenAIToolMessageSchema,
]);

export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;

// ============================================================================
// Inbound Request Schema (POST /v1/chat/completions)
// ============================================================================

export const OpenAIChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().positive().optional(),
    stream: z.boolean().optional().default(false),
    stream_options: z
      .object({
        include_usage: z.boolean().optional(),
      })
      .optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    logit_bias: z.record(z.number()).optional(),
    user: z.string().optional(),
    seed: z.number().int().optional(),
    tools: z.array(OpenAIToolSchema).optional(),
    tool_choice: OpenAIToolChoiceSchema.optional(),
    response_format: z
      .object({
        type: z.enum(['text', 'json_object', 'json_schema']),
        json_schema: z.record(z.unknown()).optional(),
      })
      .optional(),
    reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .passthrough();

export type OpenAIChatCompletionRequest = z.infer<
  typeof OpenAIChatCompletionRequestSchema
>;

// ============================================================================
// Outbound Non-Streaming Response Format
// ============================================================================

export interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCall[];
    refusal?: string | null;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | null;
  logprobs?: null;
}

export interface OpenAIUsageDetails {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  system_fingerprint?: string | null;
  choices: OpenAIChatCompletionChoice[];
  usage: OpenAIUsageDetails;
}

// ============================================================================
// Outbound SSE Streaming Chunk Format
// ============================================================================

export interface OpenAIChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  refusal?: string | null;
}

export interface OpenAIChatCompletionChunkChoice {
  index: number;
  delta: OpenAIChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | null;
  logprobs?: null;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  system_fingerprint?: string | null;
  choices: OpenAIChatCompletionChunkChoice[];
  usage?: OpenAIUsageDetails | null;
}

// ============================================================================
// Models Catalog Format (GET /v1/models)
// ============================================================================

export interface OpenAIModelItem {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission: unknown[];
  root: string;
  parent: null;
}

export interface OpenAIModelListResponse {
  object: 'list';
  data: OpenAIModelItem[];
}
