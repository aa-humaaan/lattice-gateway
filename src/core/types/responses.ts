import { z } from 'zod';

// ============================================================================
// OpenAI Responses API Input Items
// ============================================================================

export const ResponsesInputMessageContentSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

export const ResponsesInputMessageSchema = z
  .object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([
      z.string(),
      z.array(ResponsesInputMessageContentSchema),
    ]),
  })
  .passthrough();

export const ResponsesFunctionCallOutputSchema = z
  .object({
    type: z.literal('function_call_output'),
    call_id: z.string(),
    output: z.string(),
  })
  .passthrough();

export const ResponsesInputItemSchema = z.union([
  ResponsesInputMessageSchema,
  ResponsesFunctionCallOutputSchema,
]);

export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;

// ============================================================================
// OpenAI Responses API Inbound Request Schema (POST /v1/responses)
// ============================================================================

export const OpenAIResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
    instructions: z.string().optional(),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.unknown()).optional(),
          strict: z.boolean().optional(),
        })
      )
      .optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({
          type: z.literal('function'),
          name: z.string(),
        }),
      ])
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional().default(false),
    metadata: z.record(z.unknown()).optional(),
    previous_response_id: z.string().optional(),
  })
  .passthrough();

export type OpenAIResponsesRequest = z.infer<typeof OpenAIResponsesRequestSchema>;

// ============================================================================
// OpenAI Responses API Outbound Non-Streaming Format
// ============================================================================

export interface ResponsesMessageOutputItem {
  id: string;
  type: 'message';
  status: 'completed' | 'in_progress' | 'incomplete';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

export interface ResponsesFunctionCallOutputItem {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

export type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItem;

export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'failed' | 'in_progress' | 'incomplete';
  model: string;
  output: ResponsesOutputItem[];
  usage: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  error?: {
    code: string;
    message: string;
  } | null;
}
