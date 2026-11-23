import {
  CanonicalStreamEvent,
} from '../../core/types/canonical';
import {
  mapStopReasonToOpenAI,
  mapStopReasonToAnthropic,
} from './serializer';
import type { CanonicalStopReason } from '../../core/types/canonical';

export interface StreamAdapterOptions {
  keepaliveMs?: number;
  includeUsage?: boolean;
  signal?: AbortSignal;
}

/**
 * Creates OpenAI SSE Stream (POST /v1/chat/completions?stream=true)
 */
export function createOpenAISSEStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  options?: StreamAdapterOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const keepaliveMs = options?.keepaliveMs ?? 15000;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const resetKeepalive = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              if (keepaliveTimer) clearInterval(keepaliveTimer);
            }
          }
        }, keepaliveMs);
      };

      resetKeepalive();

      const enqueueChunk = (payload: unknown) => {
        resetKeepalive();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      let streamId = `chatcmpl_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      let model = 'default';
      let created = Math.floor(Date.now() / 1000);
      let roleEmitted = false;

      const ensureRoleEmitted = () => {
        if (!roleEmitted) {
          enqueueChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '' },
                finish_reason: null,
              },
            ],
          });
          roleEmitted = true;
        }
      };

      try {
        for await (const event of events) {
          if (options?.signal?.aborted || isClosed) break;

          switch (event.type) {
            case 'stream_start':
              streamId = event.id;
              model = event.model;
              created = event.created;
              ensureRoleEmitted();
              break;

            case 'thinking_delta':
              ensureRoleEmitted();
              enqueueChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: event.delta },
                    finish_reason: null,
                  },
                ],
              });
              break;

            case 'text_delta':
              ensureRoleEmitted();
              enqueueChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta },
                    finish_reason: null,
                  },
                ],
              });
              break;

            case 'tool_call_start':
              ensureRoleEmitted();
              enqueueChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: event.index,
                          id: event.id,
                          type: 'function',
                          function: {
                            name: event.name,
                            arguments: '',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
              break;

            case 'tool_call_delta':
              ensureRoleEmitted();
              enqueueChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: event.index,
                          function: {
                            arguments: event.argumentsDelta,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
              break;

            case 'tool_call_stop':
              // No explicit chunk in OpenAI SSE spec for tool call stop
              break;

            case 'usage':
              if (options?.includeUsage) {
                enqueueChunk({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [],
                  usage: {
                    prompt_tokens: event.usage.promptTokens,
                    completion_tokens: event.usage.completionTokens,
                    total_tokens: event.usage.totalTokens,
                    ...(event.usage.reasoningTokens
                      ? {
                          completion_tokens_details: {
                            reasoning_tokens: event.usage.reasoningTokens,
                          },
                        }
                      : {}),
                  },
                });
              }
              break;

            case 'stream_end': {
              const finishReason = mapStopReasonToOpenAI(event.stopReason);
              enqueueChunk({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: finishReason,
                  },
                ],
              });

              if (options?.includeUsage && event.usage) {
                enqueueChunk({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [],
                  usage: {
                    prompt_tokens: event.usage.promptTokens,
                    completion_tokens: event.usage.completionTokens,
                    total_tokens: event.usage.totalTokens,
                    ...(event.usage.reasoningTokens
                      ? {
                          completion_tokens_details: {
                            reasoning_tokens: event.usage.reasoningTokens,
                          },
                        }
                      : {}),
                  },
                });
              }
              break;
            }

            case 'stream_error':
              enqueueChunk({
                error: {
                  message: event.error.message,
                  type: event.error.type,
                  code: event.error.code,
                },
              });
              // Clients wait for [DONE]; without it an error stream hangs forever.
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              return;
          }
        }

        // Emit terminal token
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        controller.error(err);
      } finally {
        isClosed = true;
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      isClosed = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });
}

/**
 * Creates Anthropic SSE Stream (POST /v1/messages?stream=true)
 * Implements strict content block state machine with thinking, text, and tool_use blocks.
 */
export function createAnthropicSSEStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  options?: StreamAdapterOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const keepaliveMs = options?.keepaliveMs ?? 15000;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const resetKeepalive = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              if (keepaliveTimer) clearInterval(keepaliveTimer);
            }
          }
        }, keepaliveMs);
      };

      resetKeepalive();

      const emitEvent = (eventType: string, payload: unknown) => {
        resetKeepalive();
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`)
        );
      };

      let messageId = `msg_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      let model = 'default';
      let messageStarted = false;
      let currentBlockIndex = -1;
      let activeBlockType: 'thinking' | 'text' | 'tool_use' | null = null;
      // Parallel tool calls interleave their deltas, so each canonical tool
      // index owns its own open content block rather than sharing one cursor.
      const toolBlocks = new Map<number, { blockIndex: number; open: boolean; hasDelta: boolean }>();
      let fallbackToolKey = -1;
      let totalOutputTokens = 0;
      let hasNonThinkingStarted = false;

      const ensureMessageStarted = (id?: string, mdl?: string) => {
        if (messageStarted) return;
        if (id) messageId = id;
        if (mdl) model = mdl;
        emitEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        });
        messageStarted = true;
      };

      const closeActiveBlock = () => {
        if (activeBlockType !== null && currentBlockIndex >= 0) {
          if (activeBlockType === 'thinking') {
            hasNonThinkingStarted = true;
          }
          emitEvent('content_block_stop', {
            type: 'content_block_stop',
            index: currentBlockIndex,
          });
          activeBlockType = null;
        }
      };

      const closeToolBlock = (key: number) => {
        const block = toolBlocks.get(key);
        if (!block?.open) return;
        emitEvent('content_block_stop', { type: 'content_block_stop', index: block.blockIndex });
        block.open = false;
        toolBlocks.delete(key);
      };

      const closeAllToolBlocks = () => {
        // Emit stops in block-index order even when upstream omits tool_call_stop.
        const ordered = Array.from(toolBlocks.entries()).sort(
          (a, b) => a[1].blockIndex - b[1].blockIndex
        );
        for (const [key] of ordered) closeToolBlock(key);
      };

      try {
        for await (const event of events) {
          if (options?.signal?.aborted || isClosed) break;

          switch (event.type) {
            case 'stream_start':
              ensureMessageStarted(event.id, event.model);
              break;

            case 'thinking_delta': {
              ensureMessageStarted();

              // Invariant: Thinking blocks may ONLY appear at index 0 before non-thinking content.
              if (hasNonThinkingStarted) {
                if (toolBlocks.size > 0) {
                  // An open tool block owns the stream; suppress thinking text
                  // so tool arguments are never corrupted (ADV-1.5).
                  break;
                }

                if (activeBlockType === 'text') {
                  emitEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: currentBlockIndex,
                    delta: { type: 'text_delta', text: event.delta },
                  });
                  totalOutputTokens++;
                } else if (activeBlockType === null) {
                  // After tool or text block closed, open a new text block instead of thinking (ADV-1.4)
                  currentBlockIndex++;
                  activeBlockType = 'text';
                  emitEvent('content_block_start', {
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: { type: 'text', text: '' },
                  });
                  emitEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: currentBlockIndex,
                    delta: { type: 'text_delta', text: event.delta },
                  });
                  totalOutputTokens++;
                }
                break;
              }

              if (activeBlockType !== 'thinking') {
                closeActiveBlock();
                currentBlockIndex++;
                activeBlockType = 'thinking';
                emitEvent('content_block_start', {
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: { type: 'thinking', thinking: '' },
                });
              }

              emitEvent('content_block_delta', {
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: { type: 'thinking_delta', thinking: event.delta },
              });

              if (event.signature) {
                emitEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'signature_delta', signature: event.signature },
                });
              }
              totalOutputTokens++;
              break;
            }

            case 'text_delta': {
              ensureMessageStarted();
              hasNonThinkingStarted = true;
              if (activeBlockType !== 'text') {
                closeActiveBlock();
                currentBlockIndex++;
                activeBlockType = 'text';
                emitEvent('content_block_start', {
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' },
                });
              }

              emitEvent('content_block_delta', {
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: { type: 'text_delta', text: event.delta },
              });
              totalOutputTokens++;
              break;
            }

            case 'tool_call_start': {
              ensureMessageStarted();
              hasNonThinkingStarted = true;
              closeActiveBlock();
              // A tool that has already streamed arguments is sequential;
              // auto-close it when the next tool starts. Tools still waiting
              // for their first delta stay open so parallel calls can interleave.
              for (const [openKey, openBlock] of Array.from(toolBlocks.entries())) {
                if (openBlock.open && openBlock.hasDelta) closeToolBlock(openKey);
              }
              currentBlockIndex++;
              const key = event.index;
              toolBlocks.set(key, { blockIndex: currentBlockIndex, open: true, hasDelta: false });
              fallbackToolKey = key;
              emitEvent('content_block_start', {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: event.id,
                  name: event.name,
                  input: {},
                },
              });
              break;
            }

            case 'tool_call_delta': {
              const key = event.index ?? fallbackToolKey;
              const block = toolBlocks.get(key);
              if (block?.open) {
                block.hasDelta = true;
                emitEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: block.blockIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: event.argumentsDelta,
                  },
                });
                totalOutputTokens++;
              }
              break;
            }

            case 'tool_call_stop': {
              closeToolBlock(event.index ?? fallbackToolKey);
              break;
            }

            case 'usage':
              if (event.usage.completionTokens) {
                totalOutputTokens = event.usage.completionTokens;
              }
              break;

            case 'stream_end': {
              ensureMessageStarted();
              closeActiveBlock();
              closeAllToolBlocks();

              const stopReason = mapStopReasonToAnthropic(event.stopReason);
              emitEvent('message_delta', {
                type: 'message_delta',
                delta: {
                  stop_reason: stopReason,
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: event.usage?.completionTokens ?? totalOutputTokens,
                },
              });

              emitEvent('message_stop', {
                type: 'message_stop',
              });
              break;
            }

            case 'stream_error': {
              closeActiveBlock();
              emitEvent('error', {
                type: 'error',
                error: {
                  type: event.error.type || 'api_error',
                  message: event.error.message,
                },
              });
              return;
            }
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        isClosed = true;
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      isClosed = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });
}

// ============================================================================
// OpenAI Responses API SSE Stream (POST /v1/responses?stream=true)
// Implements JSON-over-SSE per OpenAI Responses API spec
// ============================================================================

export function createResponsesSSEStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  options?: StreamAdapterOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const keepaliveMs = options?.keepaliveMs ?? 15000;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let isClosed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const resetKeepalive = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              if (keepaliveTimer) clearInterval(keepaliveTimer);
            }
          }
        }, keepaliveMs);
      };

      resetKeepalive();

      const enqueueData = (eventType: string, payload: unknown) => {
        resetKeepalive();
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`)
        );
      };

      let responseId = `resp_lat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      let model = 'default';
      let created = Math.floor(Date.now() / 1000);
      let hasOutputStarted = false;
      let stopReason: CanonicalStopReason = 'stop';
      let sequence = 0;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      const nextSequence = () => ++sequence;
      const outputItems: any[] = [];
      let itemIndexCounter = 0;

      // OpenAI Responses protocol (fetched 2026-11-20):
      // https://developers.openai.com/api/reference/resources/responses/streaming-events
      // Event `type` fields and SSE `event:` names are the same full name.
      let reasoningItemId: string | undefined;
      let reasoningIndex = -1;
      let reasoningText = '';
      let textItemId: string | undefined;
      let textIndex = -1;
      let textAccumulator = '';
      let toolCallId: string | undefined; // provider tool-call id, preserved as call_id
      let toolItemId: string | undefined;
      let toolIndex = -1;
      let toolName: string | undefined;
      let toolArguments = '';

      const enqueue = (type: string, payload: Record<string, unknown>) => {
        enqueueData(type, { ...payload, type, sequence_number: nextSequence() });
      };

      const responseShell = (status: string) => ({
        id: responseId,
        object: 'response',
        created_at: created,
        status,
        model,
        output: [] as any[],
      });

      const ensureResponseCreated = () => {
        if (hasOutputStarted) return;
        hasOutputStarted = true;
        enqueue('response.created', { response: responseShell('in_progress') });
      };

      const ensureReasoningItem = () => {
        if (reasoningItemId) return;
        reasoningItemId = `rsn_${responseId}_${itemIndexCounter}`;
        reasoningIndex = itemIndexCounter++;
        enqueue('response.output_item.added', {
          output_index: reasoningIndex,
          item: { id: reasoningItemId, type: 'reasoning', summary: [], status: 'in_progress' },
        });
      };

      const ensureTextItem = () => {
        if (textItemId) return;
        textItemId = `msg_${responseId}_${itemIndexCounter}`;
        textIndex = itemIndexCounter++;
        enqueue('response.output_item.added', {
          output_index: textIndex,
          item: {
            id: textItemId,
            type: 'message',
            role: 'assistant',
            content: [],
            status: 'in_progress',
          },
        });
      };

      const flushReasoning = () => {
        if (!reasoningItemId) return;
        const item = {
          id: reasoningItemId,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: reasoningText }],
          status: 'completed',
        };
        outputItems.push(item);
        enqueue('response.output_item.done', { output_index: reasoningIndex, item });
        reasoningItemId = undefined;
        reasoningIndex = -1;
        reasoningText = '';
      };

      const flushText = () => {
        if (!textItemId) return;
        const item = {
          id: textItemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: textAccumulator, annotations: [], logprobs: [] }],
        };
        outputItems.push(item);
        enqueue('response.output_item.done', { output_index: textIndex, item });
        textItemId = undefined;
        textIndex = -1;
        textAccumulator = '';
      };

      const flushToolCall = () => {
        if (!toolCallId || toolName === undefined) {
          toolCallId = undefined;
          return;
        }
        const item = {
          id: toolItemId,
          type: 'function_call',
          call_id: toolCallId,
          name: toolName,
          arguments: toolArguments,
          status: 'completed',
        };
        outputItems.push(item);
        enqueue('response.output_item.done', { output_index: toolIndex, item });
        toolCallId = undefined;
        toolItemId = undefined;
        toolIndex = -1;
        toolName = undefined;
        toolArguments = '';
      };

      const completedResponse = (status: string) => ({
        ...responseShell(status),
        output: outputItems,
        usage: {
          total_tokens: totalPromptTokens + totalCompletionTokens,
          input_tokens: totalPromptTokens,
          output_tokens: totalCompletionTokens,
        },
      });

      try {
        for await (const event of events) {
          if (options?.signal?.aborted || isClosed) break;

          switch (event.type) {
            case 'stream_start':
              responseId = event.id;
              model = event.model;
              created = event.created;
              ensureResponseCreated();
              break;

            case 'thinking_delta': {
              ensureResponseCreated();
              ensureReasoningItem();
              reasoningText += event.delta;
              enqueue('response.reasoning_summary_text.delta', {
                item_id: reasoningItemId,
                output_index: reasoningIndex,
                summary_index: 0,
                delta: event.delta,
              });
              break;
            }

            case 'text_delta': {
              ensureResponseCreated();
              ensureTextItem();
              textAccumulator += event.delta;
              enqueue('response.output_text.delta', {
                item_id: textItemId,
                output_index: textIndex,
                content_index: 0,
                delta: event.delta,
                logprobs: [],
              });
              break;
            }

            case 'tool_call_start': {
              ensureResponseCreated();
              flushReasoning();
              flushText();
              // event.id is the provider's tool-call id; keep it as call_id so
              // the client can echo it in function_call_output (F-02).
              toolCallId = event.id;
              toolItemId = `item_${event.id}`;
              toolName = event.name;
              toolArguments = '';
              toolIndex = itemIndexCounter++;
              enqueue('response.output_item.added', {
                output_index: toolIndex,
                item: {
                  id: toolItemId,
                  type: 'function_call',
                  call_id: toolCallId,
                  name: event.name,
                  arguments: '',
                  status: 'in_progress',
                },
              });
              break;
            }

            case 'tool_call_delta': {
              if (toolCallId && toolName !== undefined) {
                toolArguments += event.argumentsDelta;
                enqueue('response.function_call_arguments.delta', {
                  item_id: toolItemId,
                  output_index: toolIndex,
                  delta: event.argumentsDelta,
                });
              }
              break;
            }

            case 'tool_call_stop':
              flushToolCall();
              break;

            case 'usage':
              totalPromptTokens = event.usage.promptTokens || totalPromptTokens;
              totalCompletionTokens = event.usage.completionTokens || totalCompletionTokens;
              break;

            case 'stream_end':
              stopReason = event.stopReason;
              flushReasoning();
              flushText();
              flushToolCall();
              ensureResponseCreated();
              enqueue('response.completed', {
                response: completedResponse(stopReason === 'error' ? 'failed' : 'completed'),
              });
              break;

            case 'stream_error':
              ensureResponseCreated();
              enqueue('error', {
                code: event.error.code,
                message: event.error.message,
                param: event.error.param ?? null,
              });
              enqueue('response.failed', {
                response: {
                  ...completedResponse('failed'),
                  error: { code: event.error.code, message: event.error.message },
                },
              });
              return;
          }
        }

        if (!hasOutputStarted) {
          ensureResponseCreated();
          enqueue('response.completed', { response: completedResponse('completed') });
        }
      } catch (err) {
        controller.error(err);
      } finally {
        isClosed = true;
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {}
      }

    },    cancel() {
      isClosed = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });
}
