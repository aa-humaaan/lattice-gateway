import {
  CanonicalStreamEvent,
} from '../../core/types/canonical';
import {
  mapStopReasonToOpenAI,
  mapStopReasonToAnthropic,
} from './serializer';

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
                if (activeBlockType === 'tool_use') {
                  // Inside active tool_use block: suppress delta to avoid corrupting tool arguments with text_delta (ADV-1.5)
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
              currentBlockIndex++;
              activeBlockType = 'tool_use';
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
              if (activeBlockType === 'tool_use') {
                emitEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
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
              if (activeBlockType === 'tool_use') {
                closeActiveBlock();
              }
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
