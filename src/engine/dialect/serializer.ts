import {
  CanonicalResponse,
  CanonicalStopReason,
} from '../../core/types/canonical';
import {
  OpenAIChatCompletionResponse,
  OpenAIToolCall,
} from '../../core/types/openai';
import {
  AnthropicMessageResponse,
  AnthropicStopReason,
} from '../../core/types/anthropic';
import {
  OpenAIResponsesResponse,
  ResponsesOutputItem,
} from '../../core/types/responses';

export function mapStopReasonToOpenAI(
  stopReason: CanonicalStopReason
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  switch (stopReason) {
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'error':
    default:
      return 'stop';
  }
}

export function mapStopReasonToAnthropic(
  stopReason: CanonicalStopReason
): AnthropicStopReason {
  switch (stopReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    case 'stop':
    case 'error':
    default:
      return 'end_turn';
  }
}

/**
 * Serializes CanonicalResponse to standard OpenAI Chat Completion JSON response.
 */
export function serializeOpenAIChat(
  res: CanonicalResponse
): OpenAIChatCompletionResponse {
  let contentText = '';
  let reasoningText = '';
  const toolCalls: OpenAIToolCall[] = [];

  for (const part of res.content) {
    if (part.type === 'text') {
      contentText += part.text;
    } else if (part.type === 'thinking') {
      reasoningText += part.thinking;
    } else if (part.type === 'tool_use') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
        },
      });
    }
  }

  const finishReason = mapStopReasonToOpenAI(res.stopReason);

  return {
    id: res.id,
    object: 'chat.completion',
    created: res.created,
    model: res.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: contentText || null,
          reasoning_content: reasoningText || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: res.usage.promptTokens,
      completion_tokens: res.usage.completionTokens,
      total_tokens: res.usage.totalTokens,
      ...(res.usage.reasoningTokens
        ? {
            completion_tokens_details: {
              reasoning_tokens: res.usage.reasoningTokens,
            },
          }
        : {}),
      ...(res.usage.cachedTokens
        ? {
            prompt_tokens_details: {
              cached_tokens: res.usage.cachedTokens,
            },
          }
        : {}),
    },
  };
}

/**
 * Serializes CanonicalResponse to Anthropic Message JSON response.
 */
export function serializeAnthropicMessage(
  res: CanonicalResponse
): AnthropicMessageResponse {
  const contentBlocks: AnthropicMessageResponse['content'] = [];

  // Group thinking parts first (Anthropic requirement)
  let thinkingAccumulator = '';
  let thinkingSignature: string | undefined;

  for (const part of res.content) {
    if (part.type === 'thinking') {
      thinkingAccumulator += part.thinking;
      if (part.signature) thinkingSignature = part.signature;
    }
  }

  if (thinkingAccumulator) {
    contentBlocks.push({
      type: 'thinking',
      thinking: thinkingAccumulator,
      ...(thinkingSignature ? { signature: thinkingSignature } : {}),
    });
  }

  // Text parts
  let textAccumulator = '';
  for (const part of res.content) {
    if (part.type === 'text') {
      textAccumulator += part.text;
    }
  }

  // Ensure content is not empty for non-tool text turns
  if (textAccumulator || (contentBlocks.length === 0 && !res.content.some((p) => p.type === 'tool_use'))) {
    contentBlocks.push({
      type: 'text',
      text: textAccumulator,
    });
  }

  // Tool use parts
  for (const part of res.content) {
    if (part.type === 'tool_use') {
      let parsedInput: Record<string, unknown> = {};
      if (typeof part.input === 'string') {
        const trimmed = part.input.trim();
        if (!trimmed || trimmed === '{}') {
          parsedInput = {};
        } else {
          try {
            parsedInput = JSON.parse(trimmed);
          } catch {
            parsedInput = { raw: part.input };
          }
        }
      } else if (part.input && typeof part.input === 'object') {
        parsedInput = part.input as Record<string, unknown>;
      }

      contentBlocks.push({
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: parsedInput,
      });
    }
  }

  const stopReason = mapStopReasonToAnthropic(res.stopReason);

  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage.promptTokens,
      output_tokens: res.usage.completionTokens,
      cache_creation_input_tokens: res.usage.cacheCreationTokens || 0,
      cache_read_input_tokens: res.usage.cachedTokens || 0,
    },
  };
}

/**
 * Serializes CanonicalResponse to OpenAI Responses API JSON response.
 */
export function serializeOpenAIResponse(
  res: CanonicalResponse
): OpenAIResponsesResponse {
  const outputItems: ResponsesOutputItem[] = [];

  let textContent = '';
  for (const part of res.content) {
    if (part.type === 'text') {
      textContent += part.text;
    } else if (part.type === 'tool_use') {
      outputItems.push({
        id: `call_${part.id}`,
        type: 'function_call',
        call_id: part.id,
        name: part.name,
        arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
        status: 'completed',
      });
    }
  }

  if (textContent) {
    outputItems.unshift({
      id: `msg_${res.id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'text', text: textContent }],
    });
  }

  return {
    id: res.id,
    object: 'response',
    created_at: res.created,
    status: res.stopReason === 'error' ? 'failed' : 'completed',
    model: res.model,
    output: outputItems,
    usage: {
      total_tokens: res.usage.totalTokens,
      input_tokens: res.usage.promptTokens,
      output_tokens: res.usage.completionTokens,
      ...(res.usage.reasoningTokens
        ? {
            output_tokens_details: {
              reasoning_tokens: res.usage.reasoningTokens,
            },
          }
        : {}),
      ...(res.usage.cachedTokens
        ? {
            input_tokens_details: {
              cached_tokens: res.usage.cachedTokens,
            },
          }
        : {}),
    },
  };
}
