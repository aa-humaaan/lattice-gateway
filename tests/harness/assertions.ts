/**
 * Domain-Specific Assertions for Lattice Gateway E2E Testing
 * 
 * Provides rigorous validators for:
 * - OpenAI chat completion responses & stream chunks
 * - Anthropic messages responses & 7-event SSE sequences
 * - Reasoning & thinking tokens extraction
 * - Function & tool-calling payloads
 * - Universal dialect error envelopes
 * - Stream termination ([DONE] / message_stop)
 */

import { expect } from 'bun:test';
import type { OpenAIStreamChunk, AnthropicSSEEvent } from './test-client';

/**
 * Validates that an OpenAI JSON chat completion response conforms to the standard specification
 */
export function assertOpenAISuccess(body: any): void {
  expect(body).toBeDefined();
  expect(typeof body).toBe('object');
  expect(body.id).toBeString();
  expect(body.object).toBe('chat.completion');
  expect(Array.isArray(body.choices)).toBeTrue();
  expect(body.choices.length).toBeGreaterThan(0);

  const choice = body.choices[0];
  expect(choice.message).toBeDefined();
  expect(choice.message.role).toBe('assistant');
  expect(choice.finish_reason).toBeDefined();
}

/**
 * Validates that an Anthropic JSON messages response conforms to the standard specification
 */
export function assertAnthropicSuccess(body: any): void {
  expect(body).toBeDefined();
  expect(typeof body).toBe('object');
  expect(body.id).toBeString();
  expect(body.type).toBe('message');
  expect(body.role).toBe('assistant');
  expect(Array.isArray(body.content)).toBeTrue();
  expect(body.content.length).toBeGreaterThan(0);
  expect(body.stop_reason).toBeDefined();
}

/**
 * Validates and extracts thinking tokens from Anthropic events/JSON or OpenAI reasoning_content chunks
 */
export function assertThinkingContent(contentOrEvents: any, expectedMinLength = 1): string {
  let accumulatedThinking = '';

  if (Array.isArray(contentOrEvents)) {
    // Array of SSE chunks or content blocks
    for (const item of contentOrEvents) {
      // 1. Anthropic SSE event (delta.thinking)
      if (item.delta && item.delta.type === 'thinking_delta' && item.delta.thinking) {
        accumulatedThinking += item.delta.thinking;
      }
      // 2. Anthropic JSON content block ({ type: 'thinking', thinking: '...' })
      else if (item.type === 'thinking' && item.thinking) {
        accumulatedThinking += item.thinking;
      }
      // 3. OpenAI SSE chunk (choices[0].delta.reasoning_content)
      else if (item.choices && item.choices[0]?.delta?.reasoning_content) {
        accumulatedThinking += item.choices[0].delta.reasoning_content;
      }
      // 4. OpenAI JSON message (choices[0].message.reasoning_content)
      else if (item.choices && item.choices[0]?.message?.reasoning_content) {
        accumulatedThinking += item.choices[0].message.reasoning_content;
      }
    }
  } else if (typeof contentOrEvents === 'object' && contentOrEvents !== null) {
    // Single JSON response object
    if (contentOrEvents.content && Array.isArray(contentOrEvents.content)) {
      for (const block of contentOrEvents.content) {
        if (block.type === 'thinking' && block.thinking) {
          accumulatedThinking += block.thinking;
        }
      }
    } else if (contentOrEvents.choices && contentOrEvents.choices[0]?.message?.reasoning_content) {
      accumulatedThinking += contentOrEvents.choices[0].message.reasoning_content;
    }
  }

  expect(accumulatedThinking.length).toBeGreaterThanOrEqual(expectedMinLength);
  return accumulatedThinking;
}

/**
 * Validates that tool calls or tool_use blocks were properly emitted
 */
export function assertToolCallsEmitted(
  resOrEvents: any,
  expectedFunctionName?: string
): Array<{ name: string; arguments: any }> {
  const discoveredTools: Array<{ name: string; arguments: any }> = [];

  if (Array.isArray(resOrEvents)) {
    // Array of chunks or events
    for (const item of resOrEvents) {
      // Anthropic SSE event: content_block_start with type: tool_use
      if (item.content_block?.type === 'tool_use') {
        discoveredTools.push({
          name: item.content_block.name,
          arguments: item.content_block.input ?? {},
        });
      }
      // Anthropic SSE event: input_json_delta
      if (item.delta?.type === 'input_json_delta' && item.delta.partial_json) {
        if (discoveredTools.length > 0) {
          const last = discoveredTools[discoveredTools.length - 1];
          try {
            last.arguments = JSON.parse(item.delta.partial_json);
          } catch {}
        }
      }
      // OpenAI SSE chunk: choices[0].delta.tool_calls
      if (item.choices && item.choices[0]?.delta?.tool_calls) {
        for (const tc of item.choices[0].delta.tool_calls) {
          if (tc.function?.name) {
            discoveredTools.push({
              name: tc.function.name,
              arguments: tc.function.arguments || '',
            });
          } else if (tc.function?.arguments && discoveredTools.length > 0) {
            const last = discoveredTools[discoveredTools.length - 1];
            if (typeof last.arguments === 'string') {
              last.arguments += tc.function.arguments;
            }
          }
        }
      }
    }
  } else if (typeof resOrEvents === 'object' && resOrEvents !== null) {
    // OpenAI JSON response: choices[0].message.tool_calls
    if (resOrEvents.choices && resOrEvents.choices[0]?.message?.tool_calls) {
      for (const tc of resOrEvents.choices[0].message.tool_calls) {
        discoveredTools.push({
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    }
    // Anthropic JSON response: content blocks with type: 'tool_use'
    if (resOrEvents.content && Array.isArray(resOrEvents.content)) {
      for (const block of resOrEvents.content) {
        if (block.type === 'tool_use') {
          discoveredTools.push({
            name: block.name,
            arguments: block.input,
          });
        }
      }
    }
  }

  // Normalize string arguments to JSON if parseable
  for (const tool of discoveredTools) {
    if (typeof tool.arguments === 'string' && tool.arguments.trim().startsWith('{')) {
      try {
        tool.arguments = JSON.parse(tool.arguments);
      } catch {}
    }
  }

  expect(discoveredTools.length).toBeGreaterThan(0);
  if (expectedFunctionName) {
    const matched = discoveredTools.some((t) => t.name === expectedFunctionName);
    expect(matched).toBeTrue();
  }

  return discoveredTools;
}

/**
 * Validates dialect-specific error envelopes (OpenAI vs Anthropic)
 */
export function assertDialectError(
  data: any,
  dialect: 'openai' | 'anthropic',
  expectedStatus?: number
): void {
  expect(data).toBeDefined();

  if (dialect === 'openai') {
    expect(data.error).toBeDefined();
    expect(typeof data.error.message).toBe('string');
    expect(data.error.message.length).toBeGreaterThan(0);
    if (expectedStatus) {
      if (typeof data.error.code === 'number') {
        expect(data.error.code).toBe(expectedStatus);
      } else if (typeof data.error.code === 'string' && !isNaN(Number(data.error.code))) {
        expect(Number(data.error.code)).toBe(expectedStatus);
      }
    }
  } else if (dialect === 'anthropic') {
    expect(data.type).toBe('error');
    expect(data.error).toBeDefined();
    expect(typeof data.error.type).toBe('string');
    expect(typeof data.error.message).toBe('string');
    expect(data.error.message.length).toBeGreaterThan(0);
  }
}

/**
 * Validates that an SSE stream reached proper completion
 */
export function assertStreamDone(events: (OpenAIStreamChunk | AnthropicSSEEvent)[]): void {
  expect(Array.isArray(events)).toBeTrue();
  expect(events.length).toBeGreaterThan(0);

  // Check if Anthropic message_stop was received
  const hasAnthropicStop = events.some(
    (e: any) => e.event === 'message_stop' || e.type === 'message_stop'
  );

  // Check if OpenAI finish_reason was set
  const hasOpenAIFinish = events.some(
    (e: any) => e.choices && e.choices[0]?.finish_reason !== null && e.choices[0]?.finish_reason !== undefined
  );

  expect(hasAnthropicStop || hasOpenAIFinish).toBeTrue();
}

/**
 * Validates the presence of a model ID in an aggregated /v1/models catalog
 */
export function assertModelPresent(catalog: any, modelId: string): void {
  expect(catalog).toBeDefined();
  expect(Array.isArray(catalog.data)).toBeTrue();
  const exists = catalog.data.some((m: any) => m.id === modelId);
  expect(exists).toBeTrue();
}

/**
 * Validates that a 429 response contains a valid Retry-After header
 */
export function assertRetryAfterHeader(
  headers: Response | Headers | Record<string, string>,
  expectedSeconds?: number
): void {
  const getHeader = (name: string): string | null => {
    if (headers && typeof (headers as any).headers?.get === 'function') {
      return (headers as any).headers.get(name);
    }
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name);
    }
    const record = headers as Record<string, string>;
    return record[name] ?? record[name.toLowerCase()] ?? null;
  };

  const retryAfter = getHeader('Retry-After');
  expect(retryAfter).not.toBeNull();
  const seconds = parseInt(retryAfter!, 10);
  expect(isNaN(seconds)).toBeFalse();
  expect(seconds).toBeGreaterThan(0);

  if (expectedSeconds !== undefined) {
    expect(seconds).toBe(expectedSeconds);
  }
}

/**
 * Validates that Anthropic SSE events include the canonical sequence
 */
export function assertAnthropicEventSequence(
  events: AnthropicSSEEvent[],
  expectedEvents: string[] = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']
): void {
  const actualEvents = events.map((e) => e.event || e.type).filter(Boolean);
  for (const expected of expectedEvents) {
    expect(actualEvents).toContain(expected);
  }
}
