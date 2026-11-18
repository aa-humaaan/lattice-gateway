import { z } from 'zod';

// ============================================================================
// Anthropic Content Blocks
// ============================================================================

export const AnthropicTextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    cache_control: z.object({ type: z.literal('ephemeral') }).optional(),
  })
  .passthrough();

export type AnthropicTextBlock = z.infer<typeof AnthropicTextBlockSchema>;

export const AnthropicImageBlockSchema = z
  .object({
    type: z.literal('image'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      data: z.string(),
    }),
  })
  .passthrough();

export type AnthropicImageBlock = z.infer<typeof AnthropicImageBlockSchema>;

export const AnthropicThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

export type AnthropicThinkingBlock = z.infer<typeof AnthropicThinkingBlockSchema>;

export const AnthropicRedactedThinkingBlockSchema = z
  .object({
    type: z.literal('redacted_thinking'),
    data: z.string(),
  })
  .passthrough();

export type AnthropicRedactedThinkingBlock = z.infer<
  typeof AnthropicRedactedThinkingBlockSchema
>;

export const AnthropicToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  })
  .passthrough();

export type AnthropicToolUseBlock = z.infer<typeof AnthropicToolUseBlockSchema>;

export const AnthropicToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z
      .union([
        z.string(),
        z.array(
          z.union([
            AnthropicTextBlockSchema,
            AnthropicImageBlockSchema,
          ])
        ),
      ])
      .optional(),
    is_error: z.boolean().optional(),
    cache_control: z.object({ type: z.literal('ephemeral') }).optional(),
  })
  .passthrough();

export type AnthropicToolResultBlock = z.infer<
  typeof AnthropicToolResultBlockSchema
>;

export const AnthropicContentBlockSchema = z.union([
  AnthropicTextBlockSchema,
  AnthropicImageBlockSchema,
  AnthropicThinkingBlockSchema,
  AnthropicRedactedThinkingBlockSchema,
  AnthropicToolUseBlockSchema,
  AnthropicToolResultBlockSchema,
]);

export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;

// ============================================================================
// Anthropic Messages
// ============================================================================

export const AnthropicMessageParamSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([
      z.string(),
      z.array(AnthropicContentBlockSchema),
    ]),
  })
  .passthrough();

export type AnthropicMessageParam = z.infer<typeof AnthropicMessageParamSchema>;

// ============================================================================
// Anthropic Tool Schemas
// ============================================================================

export const AnthropicToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()),
    cache_control: z.object({ type: z.literal('ephemeral') }).optional(),
  })
  .passthrough();

export type AnthropicTool = z.infer<typeof AnthropicToolSchema>;

export const AnthropicToolChoiceSchema = z.union([
  z.object({
    type: z.literal('auto'),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('any'),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
]);

export type AnthropicToolChoice = z.infer<typeof AnthropicToolChoiceSchema>;

// ============================================================================
// Inbound Request Schema (POST /v1/messages)
// ============================================================================

export const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(AnthropicMessageParamSchema).min(1),
    system: z
      .union([
        z.string(),
        z.array(AnthropicTextBlockSchema),
      ])
      .optional(),
    max_tokens: z.number().int().positive().optional().default(4096),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    thinking: z
      .object({
        type: z.enum(['enabled', 'disabled', 'adaptive']).or(z.string()),
        budget_tokens: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    tools: z.array(AnthropicToolSchema).optional(),
    tool_choice: AnthropicToolChoiceSchema.optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>;

// ============================================================================
// Outbound Non-Streaming Response Format
// ============================================================================

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'error'
  | null;

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ============================================================================
// Outbound SSE Streaming Event Schemas
// ============================================================================

export type AnthropicSSEEvent =
  | {
      type: 'message_start';
      message: {
        id: string;
        type: 'message';
        role: 'assistant';
        model: string;
        content: unknown[];
        stop_reason: null;
        stop_sequence: null;
        usage: { input_tokens: number; output_tokens: number };
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'thinking'; thinking: '' }
        | { type: 'text'; text: '' }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string }
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | {
      type: 'content_block_stop';
      index: number;
    }
  | {
      type: 'message_delta';
      delta: {
        stop_reason: AnthropicStopReason;
        stop_sequence: string | null;
      };
      usage: { output_tokens: number };
    }
  | {
      type: 'message_stop';
    }
  | {
      type: 'ping';
    };
