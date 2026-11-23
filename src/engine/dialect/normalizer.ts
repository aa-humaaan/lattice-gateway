import {
  CanonicalRequest,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalToolDefinition,
  CanonicalToolChoice,
  CanonicalThinkingConfig,
} from '../../core/types/canonical';
import {
  OpenAIChatCompletionRequestSchema,
} from '../../core/types/openai';
import {
  AnthropicMessagesRequestSchema,
} from '../../core/types/anthropic';
import {
  OpenAIResponsesRequestSchema,
} from '../../core/types/responses';
import { GatewayError } from '../../core/types/errors';

function resolveTraceIdAndHeaders(
  rawHeadersOrReqId?: Record<string, string> | string,
  prefix = 'req_lat_'
): { traceId: string; rawHeaders?: Record<string, string> } {
  if (typeof rawHeadersOrReqId === 'string') {
    return {
      traceId: rawHeadersOrReqId,
      rawHeaders: { 'x-request-id': rawHeadersOrReqId },
    };
  }
  const headers = rawHeadersOrReqId ?? {};
  const traceId =
    headers['x-request-id'] ||
    `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return { traceId, rawHeaders: headers };
}

/**
 * Normalizes OpenAI /v1/chat/completions request into CanonicalRequest.
 */
export function normalizeOpenAIChat(
  body: unknown,
  rawHeadersOrReqId?: Record<string, string> | string
): CanonicalRequest {
  if (!body || typeof body !== 'object') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'Invalid OpenAI Chat request: body must be a JSON object'
    );
  }

  const parseResult = OpenAIChatCompletionRequestSchema.safeParse(body);
  if (!parseResult.success) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      `Invalid OpenAI Chat request: ${parseResult.error.message}`
    );
  }

  const req = parseResult.data;
  const { traceId, rawHeaders } = resolveTraceIdAndHeaders(rawHeadersOrReqId, 'chat_lat_');

  const canonicalMessages: CanonicalMessage[] = [];
  const systemPromptParts: string[] = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((p) => p.text).join('\n');
      if (text.trim()) {
        systemPromptParts.push(text.trim());
      }
      canonicalMessages.push({
        role: 'system',
        content: text,
        name: msg.name,
      });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        canonicalMessages.push({
          role: 'user',
          content: msg.content,
          name: msg.name,
        });
      } else {
        const parts: CanonicalContentPart[] = msg.content.map((p) => {
          if (p.type === 'text') {
            return { type: 'text', text: p.text };
          }
          const url = p.image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image',
                source: { type: 'base64', mediaType: match[1], data: match[2] },
              };
            }
          }
          return {
            type: 'image',
            source: { type: 'url', mediaType: 'image/jpeg', data: url },
          };
        });
        canonicalMessages.push({ role: 'user', content: parts, name: msg.name });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: CanonicalContentPart[] = [];
      if (msg.reasoning_content) {
        parts.push({ type: 'thinking', thinking: msg.reasoning_content });
      }
      if (msg.content) {
        parts.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let parsedInput: Record<string, unknown> | string = tc.function.arguments;
          try {
            parsedInput = JSON.parse(tc.function.arguments);
          } catch {
            // retain raw string if not JSON
          }
          parts.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      canonicalMessages.push({
        role: 'assistant',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
        name: msg.name,
      });
      continue;
    }

    if (msg.role === 'tool') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((p) => p.text).join('\n');
      canonicalMessages.push({
        role: 'tool',
        toolCallId: msg.tool_call_id,
        content: [
          {
            type: 'tool_result',
            toolCallId: msg.tool_call_id,
            content: text,
          },
        ],
      });
      continue;
    }
  }

  // Thinking config
  let thinkingConfig: CanonicalThinkingConfig | undefined;
  if (req.reasoning_effort) {
    thinkingConfig = { type: 'enabled' };
  }

  // Tools mapping
  let tools: CanonicalToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        strict: t.function.strict,
      },
    }));
  }

  // Tool choice mapping
  let toolChoice: CanonicalToolChoice | undefined;
  if (req.tool_choice) {
    if (typeof req.tool_choice === 'string') {
      toolChoice = req.tool_choice;
    } else if (req.tool_choice.type === 'function') {
      toolChoice = {
        type: 'function',
        function: { name: req.tool_choice.function.name },
      };
    }
  }

  const maxTokens = req.max_completion_tokens ?? req.max_tokens;

  return {
    id: traceId,
    clientDialect: 'openai-chat',
    model: req.model,
    messages: canonicalMessages,
    systemPrompt: systemPromptParts.length > 0 ? systemPromptParts.join('\n\n') : undefined,
    tools,
    toolChoice,
    temperature: req.temperature,
    topP: req.top_p,
    frequencyPenalty: req.frequency_penalty,
    presencePenalty: req.presence_penalty,
    seed: req.seed,
    n: req.n,
    logitBias: req.logit_bias,
    user: req.user,
    responseFormat: req.response_format
      ? {
          type: req.response_format.type,
          ...(req.response_format.json_schema
            ? { jsonSchema: req.response_format.json_schema }
            : {}),
        }
      : undefined,
    maxTokens,
    stop: typeof req.stop === 'string' ? [req.stop] : req.stop,
    stream: req.stream ?? false,
    streamOptions: req.stream_options ? { includeUsage: req.stream_options.include_usage } : undefined,
    thinking: thinkingConfig,
    reasoningEffort: req.reasoning_effort,
    rawHeaders,
  };
}

/**
 * Normalizes Anthropic /v1/messages request into CanonicalRequest.
 */
export function normalizeAnthropicMessages(
  body: unknown,
  rawHeadersOrReqId?: Record<string, string> | string
): CanonicalRequest {
  if (!body || typeof body !== 'object') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'Invalid Anthropic Messages request: body must be a JSON object'
    );
  }

  const parseResult = AnthropicMessagesRequestSchema.safeParse(body);
  if (!parseResult.success) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      `Invalid Anthropic Messages request: ${parseResult.error.message}`
    );
  }

  const req = parseResult.data;
  const { traceId, rawHeaders } = resolveTraceIdAndHeaders(rawHeadersOrReqId, 'msg_lat_');

  // Extract top-level system prompt
  let systemPrompt: string | undefined;
  if (typeof req.system === 'string') {
    systemPrompt = req.system.trim();
  } else if (Array.isArray(req.system)) {
    systemPrompt = req.system.map((s) => s.text).join('\n\n').trim();
  }

  const rawMessages: CanonicalMessage[] = [];

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      rawMessages.push({
        role: msg.role,
        content: msg.content,
      });
      continue;
    }

    const parts: CanonicalContentPart[] = [];
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          parts.push({
            type: 'text',
            text: block.text,
            cacheControl: block.cache_control ? { type: 'ephemeral' } : undefined,
          });
          break;
        case 'image':
          parts.push({
            type: 'image',
            source: {
              type: 'base64',
              mediaType: block.source.media_type,
              data: block.source.data,
            },
          });
          break;
        case 'thinking':
          parts.push({
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature,
          });
          break;
        case 'redacted_thinking':
          parts.push({
            type: 'redacted_thinking',
            data: block.data,
          });
          break;
        case 'tool_use':
          parts.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        case 'tool_result': {
          let toolResultContent: string | CanonicalContentPart[] = '';
          if (typeof block.content === 'string') {
            toolResultContent = block.content;
          } else if (Array.isArray(block.content)) {
            toolResultContent = block.content.map((b) => {
              if (b.type === 'text') {
                return { type: 'text', text: b.text };
              }
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  mediaType: b.source.media_type,
                  data: b.source.data,
                },
              };
            });
          }
          parts.push({
            type: 'tool_result',
            toolCallId: block.tool_use_id,
            content: toolResultContent,
            isError: block.is_error,
          });
          break;
        }
      }
    }

    rawMessages.push({
      role: msg.role,
      content: parts,
    });
  }

  // Merge adjacent same-role messages for Anthropic alternating compliance
  const canonicalMessages: CanonicalMessage[] = [];
  for (const msg of rawMessages) {
    if (canonicalMessages.length === 0) {
      canonicalMessages.push(msg);
      continue;
    }

    const prev = canonicalMessages[canonicalMessages.length - 1];
    if (prev.role === msg.role) {
      // Merge content
      if (typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = `${prev.content}\n\n${msg.content}`;
      } else {
        const prevParts: CanonicalContentPart[] = typeof prev.content === 'string'
          ? [{ type: 'text', text: prev.content }]
          : prev.content;
        const msgParts: CanonicalContentPart[] = typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : msg.content;
        prev.content = [...prevParts, ...msgParts];
      }
    } else {
      canonicalMessages.push(msg);
    }
  }

  // Tools mapping
  let tools: CanonicalToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Tool choice mapping
  let toolChoice: CanonicalToolChoice | undefined;
  if (req.tool_choice) {
    if (req.tool_choice.type === 'auto') {
      toolChoice = 'auto';
    } else if (req.tool_choice.type === 'any') {
      toolChoice = 'required';
    } else if (req.tool_choice.type === 'tool') {
      toolChoice = {
        type: 'function',
        function: { name: req.tool_choice.name },
      };
    }
  }

  // Thinking config & reasoning effort
  let thinkingConfig: CanonicalThinkingConfig | undefined;
  let reasoningEffort: 'low' | 'medium' | 'high' | undefined;

  if (req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive') {
    const budget = req.thinking.budget_tokens;
    thinkingConfig = {
      type: req.thinking.type === 'adaptive' ? 'adaptive' : 'enabled',
      budgetTokens: budget,
    };
    if (budget) {
      if (budget < 4000) reasoningEffort = 'low';
      else if (budget <= 16000) reasoningEffort = 'medium';
      else reasoningEffort = 'high';
    } else {
      reasoningEffort = 'high';
    }
  }

  return {
    id: traceId,
    clientDialect: 'anthropic-messages',
    model: req.model,
    messages: canonicalMessages,
    systemPrompt,
    tools,
    toolChoice,
    temperature: req.temperature,
    topP: req.top_p,
    topK: req.top_k,
    maxTokens: req.max_tokens,
    stop: req.stop_sequences,
    stream: req.stream ?? false,
    thinking: thinkingConfig,
    reasoningEffort,
    rawHeaders,
  };
}

/**
 * Normalizes OpenAI Responses /v1/responses request into CanonicalRequest.
 */
export function normalizeOpenAIResponses(
  body: unknown,
  rawHeadersOrReqId?: Record<string, string> | string
): CanonicalRequest {
  if (!body || typeof body !== 'object') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'Invalid OpenAI Responses request: body must be a JSON object'
    );
  }

  const parseResult = OpenAIResponsesRequestSchema.safeParse(body);
  if (!parseResult.success) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      `Invalid OpenAI Responses request: ${parseResult.error.message}`
    );
  }

  const req = parseResult.data;
  const { traceId, rawHeaders } = resolveTraceIdAndHeaders(rawHeadersOrReqId, 'resp_lat_');

  const canonicalMessages: CanonicalMessage[] = [];

  if (typeof req.input === 'string') {
    canonicalMessages.push({
      role: 'user',
      content: req.input,
    });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (item.type === 'message') {
        if (typeof item.content === 'string') {
          canonicalMessages.push({ role: item.role, content: item.content });
        } else {
          const parts: CanonicalContentPart[] = item.content.map((p) => {
            if (p.type === 'text') return { type: 'text', text: p.text };
            return {
              type: 'image',
              source: { type: 'url', mediaType: 'image/jpeg', data: p.image_url.url },
            };
          });
          canonicalMessages.push({ role: item.role, content: parts });
        }
      } else if (item.type === 'function_call') {
        canonicalMessages.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: item.arguments,
          }],
        });
      } else if (item.type === 'function_call_output') {
        canonicalMessages.push({
          role: 'tool',
          toolCallId: item.call_id,
          content: [
            {
              type: 'tool_result',
              toolCallId: item.call_id,
              content: item.output,
            },
          ],
        });
      }
    }
  }

  // Tools mapping
  let tools: CanonicalToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: t.strict,
      },
    }));
  }

  let toolChoice: CanonicalToolChoice | undefined;
  if (req.tool_choice) {
    if (typeof req.tool_choice === 'string') {
      toolChoice = req.tool_choice;
    } else if (req.tool_choice.type === 'function') {
      toolChoice = {
        type: 'function',
        function: { name: req.tool_choice.name },
      };
    }
  }

  return {
    id: traceId,
    clientDialect: 'openai-responses',
    model: req.model,
    messages: canonicalMessages,
    systemPrompt: req.instructions,
    tools,
    toolChoice,
    temperature: req.temperature,
    topP: req.top_p,
    maxTokens: req.max_output_tokens,
    stream: req.stream ?? false,
    rawHeaders,
  };
}
