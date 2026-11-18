import {
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalMessage,
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
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' {
  switch (stopReason) {
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    case 'stop':
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
    case 'error':
      return 'error';
    case 'stop':
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
    ...(res.stopReason === 'error'
      ? { error: { code: 'generation_error', message: 'Generation failed' } }
      : {}),
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

/**
 * Serializes internal CanonicalMessage array to standard OpenAI-compatible messages array.
 * Robustly converts assistant tool_use, tool results, thinking blocks, and multi-part content.
 */
export function serializeOpenAIMessages(
  messages: CanonicalMessage[],
  systemPrompt?: string
): any[] {
  const result: any[] = [];

  if (systemPrompt && systemPrompt.trim()) {
    const hasInitialSystem = messages.length > 0 && messages[0].role === 'system';
    if (!hasInitialSystem) {
      result.push({ role: 'system', content: systemPrompt.trim() });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((p) => ('text' in p ? p.text : '')).join('\n')
          : String(msg.content ?? '');
      result.push({ role: 'system', content: text, ...(msg.name ? { name: msg.name } : {}) });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content, ...(msg.name ? { name: msg.name } : {}) });
        continue;
      }

      if (Array.isArray(msg.content)) {
        // Separate tool_result parts (from Anthropic /v1/messages) from other parts (text, image)
        const toolResults = msg.content.filter((p) => p.type === 'tool_result');
        const nonToolParts = msg.content.filter((p) => p.type !== 'tool_result');

        // Emit each tool_result as an individual OpenAI-compatible 'tool' message
        for (const tr of toolResults) {
          if (tr.type === 'tool_result') {
            let trText = '';
            if (typeof tr.content === 'string') {
              trText = tr.content;
            } else if (Array.isArray(tr.content)) {
              trText = tr.content
                .map((c) => {
                  if (typeof c === 'string') return c;
                  if (c && typeof c === 'object' && 'text' in c) return (c as any).text || '';
                  return JSON.stringify(c);
                })
                .join('\n');
            } else if (tr.content !== undefined && tr.content !== null) {
              trText = typeof tr.content === 'object' ? JSON.stringify(tr.content) : String(tr.content);
            }

            result.push({
              role: 'tool',
              tool_call_id: tr.toolCallId || 'call_default',
              content: trText,
            });
          }
        }

        // If there are other user parts (text, image), emit them as a subsequent user message
        if (nonToolParts.length > 0) {
          const hasImages = nonToolParts.some((p) => p.type === 'image');
          if (!hasImages) {
            const text = nonToolParts
              .map((p) => (p.type === 'text' ? p.text : ''))
              .filter(Boolean)
              .join('\n');
            if (text.trim() || toolResults.length === 0) {
              result.push({ role: 'user', content: text, ...(msg.name ? { name: msg.name } : {}) });
            }
          } else {
            const parts = nonToolParts.map((p) => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              if (p.type === 'image') {
                const url = p.source.type === 'base64'
                  ? `data:${p.source.mediaType};base64,${p.source.data}`
                  : p.source.data;
                return { type: 'image_url', image_url: { url } };
              }
              return { type: 'text', text: '' };
            });
            result.push({ role: 'user', content: parts, ...(msg.name ? { name: msg.name } : {}) });
          }
        }
        continue;
      }

      continue;
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content, ...(msg.name ? { name: msg.name } : {}) });
        continue;
      }

      if (Array.isArray(msg.content)) {
        let textAccumulator = '';
        let reasoningAccumulator = '';
        const toolCalls: any[] = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            textAccumulator += part.text;
          } else if (part.type === 'thinking') {
            reasoningAccumulator += part.thinking;
          } else if (part.type === 'tool_use') {
            toolCalls.push({
              id: part.id,
              type: 'function',
              function: {
                name: part.name,
                arguments: typeof part.input === 'string'
                  ? part.input
                  : JSON.stringify(part.input ?? {}),
              },
            });
          }
        }

        const assistantMsg: any = {
          role: 'assistant',
          content: textAccumulator || (toolCalls.length === 0 ? '' : null),
        };
        if (reasoningAccumulator) {
          assistantMsg.reasoning_content = reasoningAccumulator;
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        if (msg.name) {
          assistantMsg.name = msg.name;
        }
        result.push(assistantMsg);
        continue;
      }

      result.push({ role: 'assistant', content: null, ...(msg.name ? { name: msg.name } : {}) });
      continue;
    }

    if (msg.role === 'tool') {
      let textContent = '';
      let toolCallId = msg.toolCallId;

      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_result') {
            if (!toolCallId && part.toolCallId) toolCallId = part.toolCallId;
            if (typeof part.content === 'string') {
              textContent += part.content;
            } else if (Array.isArray(part.content)) {
              textContent += part.content.map((c) => ('text' in c ? c.text : '')).join('\n');
            }
          } else if (part.type === 'text') {
            textContent += part.text;
          }
        }
      }

      result.push({
        role: 'tool',
        tool_call_id: toolCallId || 'call_default',
        content: textContent,
      });
      continue;
    }
  }

  return result;
}
