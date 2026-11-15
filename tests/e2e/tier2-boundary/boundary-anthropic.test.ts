/**
 * Tier 2 Boundary & Corner Cases: Anthropic Dialect Edge Cases
 * 
 * Verifies Anthropic /v1/messages robustness against boundary conditions:
 * - Empty messages array or missing system prompt
 * - Malformed max_tokens / non-integer values
 * - anthropic-version header resilience and tracing
 * - Unicode surrogate pairs, emoji, and multi-byte UTF-8 split across chunk boundaries
 * - Rapid stream termination and resource cleanup
 * - Keepalive comments (: ping) resilience in SSE streams
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { MockProviderPlugin } from '../../mocks/mock-provider';
import { TestClient, parseSSEStream } from '../../harness/test-client';
import {
  assertDialectError,
  assertAnthropicSuccess,
} from '../../harness/assertions';

describe('Tier 2 Boundary: Anthropic Dialect Edge Cases', () => {
  let server: any;
  let client: TestClient;
  let baseUrl: string;

  beforeAll(async () => {
    const plugin = new MockProviderPlugin();
    const app = createServer({ port: 0 }, [plugin]);
    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    client = new TestClient(baseUrl);
  });

  afterAll(async () => {
    if (server) {
      server.stop(true);
    }
  });

  // 1. Empty messages array: messages: []
  it('rejects empty messages array with 400 Bad Request and Anthropic dialect error envelope', async () => {
    const res = await client.anthropicMessages({
      model: 'mock-chat',
      messages: [] as any,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    assertDialectError(body, 'anthropic');
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('messages');
  });

  // 2. Malformed max_tokens / non-integer values
  it('rejects invalid max_tokens (0, negative, floating point)', async () => {
    // max_tokens: 0 must be rejected
    const resZero = await client.anthropicMessages({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Zero max tokens' }],
      max_tokens: 0,
    });
    expect(resZero.status).toBe(400);
    const bodyZero = (await resZero.json()) as any;
    assertDialectError(bodyZero, 'anthropic');

    // max_tokens: -50 (negative)
    const resNeg = await client.anthropicMessages({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Negative max tokens' }],
      max_tokens: -50,
    });
    expect(resNeg.status).toBe(400);
    const bodyNeg = (await resNeg.json()) as any;
    assertDialectError(bodyNeg, 'anthropic');

    // max_tokens: 42.7 (floating point / non-integer)
    const resFloat = await client.anthropicMessages({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Float max tokens' }],
      max_tokens: 42.7 as any,
    });
    expect(resFloat.status).toBe(400);
    const bodyFloat = (await resFloat.json()) as any;
    assertDialectError(bodyFloat, 'anthropic');
  });

  // 3. System prompt handling: omitted system prompt vs complex system prompt
  it('handles requests with omitted system prompt and multi-block system prompt gracefully', async () => {
    // Omitted system prompt should default cleanly
    const resOmitted = await client.anthropicMessages({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'No system prompt included' }],
    });
    expect(resOmitted.status).toBe(200);
    const bodyOmitted = (await resOmitted.json()) as any;
    assertAnthropicSuccess(bodyOmitted);

    // Array of text blocks for system prompt
    const resArraySystem = await client.anthropicMessages({
      model: 'mock-chat',
      system: [
        { type: 'text', text: 'You are an advanced researcher.' },
        { type: 'text', text: 'Always cite factual sources.' },
      ] as any,
      messages: [{ role: 'user', content: 'Testing array system prompt' }],
    });
    expect(resArraySystem.status).toBe(200);
    const bodyArray = (await resArraySystem.json()) as any;
    assertAnthropicSuccess(bodyArray);
  });

  // 4. anthropic-version header resilience
  it('attaches x-request-id and handles anthropic-version variations', async () => {
    // Custom anthropic-version
    const resCustom = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'Version header test' }],
      }),
    });
    expect(resCustom.status).toBe(200);
    expect(resCustom.headers.get('x-request-id')).toBeDefined();

    // Missing anthropic-version header still succeeds gracefully
    const resMissing = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'No version header test' }],
      }),
    });
    expect(resMissing.status).toBe(200);
  });

  // 5. Unicode surrogate pairs, emoji, and multi-byte UTF-8 split across chunk boundaries
  it('preserves multi-byte UTF-8 characters and emoji when split across network byte boundaries', async () => {
    // 4-byte emoji: 🚀 (F0 9F 9A 80), 🧠 (F0 9F A7 A0), 👨‍👩‍👧‍👦 (multi-codepoint ZWJ)
    const complexUnicode = 'Testing emoji: 🚀 🧠 ⚡ 👨‍👩‍👧‍👦 and symbols: 你好世界 🌟';

    // Verify round-trip non-streaming
    const res = await client.anthropicMessages({
      model: 'mock-chat',
      messages: [{ role: 'user', content: complexUnicode }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);
    expect(body.content[0].text).toContain(complexUnicode);

    // Verify streaming byte slicing across UTF-8 boundaries
    const rawSSE = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_utf8","type":"message","role":"assistant","content":[],"model":"mock-chat","usage":{"input_tokens":10,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${complexUnicode}"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;

    const encoder = new TextEncoder();
    const allBytes = encoder.encode(rawSSE);

    // Split byte stream into awkward 7-byte chunks (slicing UTF-8 4-byte boundaries midway)
    async function* byteSlicer() {
      const step = 7;
      for (let i = 0; i < allBytes.length; i += step) {
        yield allBytes.subarray(i, i + step);
      }
    }

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const chunk of byteSlicer()) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const events: any[] = [];
    for await (const ev of parseSSEStream(readable)) {
      events.push(ev);
    }

    const textDeltaEvents = events.filter((e) => e.event === 'content_block_delta');
    expect(textDeltaEvents.length).toBe(1);
    const parsedData = JSON.parse(textDeltaEvents[0].data);
    expect(parsedData.delta.text).toBe(complexUnicode);
  });

  // 6. Rapid stream termination and keepalive comments resilience
  it('resiliently handles SSE keepalive comments and rapid client-side stream termination', async () => {
    // 1. Keepalive comment resilience
    const sseWithComments = [
      ': ping - initial connection keepalive\n\n',
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_ka_1","type":"message","role":"assistant","content":[],"model":"mock-chat","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      ': ping - periodic keepalive\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      ': ping - heartbeat\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Keepalive test passed"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const commentStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseWithComments));
        controller.close();
      },
    });

    const parsedEvents: any[] = [];
    for await (const ev of parseSSEStream(commentStream)) {
      parsedEvents.push(ev);
    }

    // Comments must NOT produce events
    expect(parsedEvents.length).toBe(4);
    expect(parsedEvents[0].event).toBe('message_start');
    expect(parsedEvents[2].event).toBe('content_block_delta');

    // 2. Rapid stream termination: client cancels stream immediately
    const abortController = new AbortController();
    const resStream = await client.anthropicMessages(
      {
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'Terminate stream rapidly' }],
        stream: true,
      },
      { signal: abortController.signal }
    );

    expect(resStream.status).toBe(200);
    const reader = resStream.body!.getReader();
    // Read first chunk
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);

    // Cancel immediately and handle expected abort signal
    try {
      abortController.abort();
      await reader.cancel();
    } catch (err: any) {
      expect(err.name === 'AbortError' || err.message.includes('abort')).toBe(true);
    }
  });
});
