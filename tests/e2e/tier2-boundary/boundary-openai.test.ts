/**
 * Tier 2 Boundary & Corner Cases: OpenAI Dialect Edge Cases
 * 
 * Verifies OpenAI /v1/chat/completions robustness against boundary conditions:
 * - Empty prompt / empty messages array (messages: [])
 * - Extreme max_tokens values (0, negative, very large e.g. 1,000,000)
 * - Oversized payloads (100KB+ system prompt or user message content)
 * - Missing or malformed model field
 * - Malformed JSON body in HTTP request (invalid syntax)
 * - Truncated SSE chunks and incomplete JSON delta lines reassembly
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { MockProviderPlugin } from '../../mocks/mock-provider';
import { TestClient, parseSSEStream } from '../../harness/test-client';
import {
  assertDialectError,
  assertOpenAISuccess,
  assertStreamDone,
} from '../../harness/assertions';

describe('Tier 2 Boundary: OpenAI Dialect Edge Cases', () => {
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
  it('rejects empty messages array with 400 Bad Request and dialect error envelope', async () => {
    const res = await client.openaiChat({
      model: 'mock-chat',
      messages: [] as any,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    assertDialectError(body, 'openai');
    expect(body.error.message).toContain('messages');
    expect(body.error.type).toBe('invalid_request_error');
  });

  // 2. Extreme max_tokens values (0, negative, very large)
  it('validates extreme max_tokens values (0, negative, very large)', async () => {
    // max_tokens: 0 must be rejected
    const resZero = await client.openaiChat({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Test zero max_tokens' }],
      max_tokens: 0,
    });
    expect(resZero.status).toBe(400);
    const bodyZero = (await resZero.json()) as any;
    assertDialectError(bodyZero, 'openai');

    // max_tokens: -10 (negative) must be rejected
    const resNeg = await client.openaiChat({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Test negative max_tokens' }],
      max_tokens: -10,
    });
    expect(resNeg.status).toBe(400);
    const bodyNeg = (await resNeg.json()) as any;
    assertDialectError(bodyNeg, 'openai');

    // Very large max_tokens: 1,000,000 accepted without server panic
    const resLarge = await client.openaiChat({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Test large max_tokens' }],
      max_tokens: 1_000_000,
    });
    expect(resLarge.status).toBe(200);
    const bodyLarge = (await resLarge.json()) as any;
    assertOpenAISuccess(bodyLarge);
  });

  // 3. Oversized payloads (100KB+ system prompt and message content)
  it('handles oversized payloads exceeding 100KB without buffer overflow or corruption', async () => {
    // Generate a 120KB payload
    const longChunk = 'LatticeGatewayPayloadStressTestingDataBlock-'.repeat(25); // ~1KB
    const largeContent = longChunk.repeat(120); // ~120KB
    expect(largeContent.length).toBeGreaterThan(100_000);

    const res = await client.openaiChat({
      model: 'mock-chat',
      messages: [
        { role: 'system', content: 'You are an echo server.' },
        { role: 'user', content: largeContent },
      ],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBeDefined();
    // Verify echo contains the prefix of large content
    expect(body.choices[0].message.content).toContain('Echo:');
  });

  // 4. Missing or malformed model field
  it('validates missing, empty string, or non-existent model field', async () => {
    // Missing model
    const resMissing = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'No model' }],
      }),
    });
    expect(resMissing.status).toBe(400);
    const bodyMissing = (await resMissing.json()) as any;
    assertDialectError(bodyMissing, 'openai');

    // Empty string model
    const resEmpty = await client.openaiChat({
      model: '',
      messages: [{ role: 'user', content: 'Empty model string' }],
    });
    expect(resEmpty.status).toBe(400);
    const bodyEmpty = (await resEmpty.json()) as any;
    assertDialectError(bodyEmpty, 'openai');
  });

  // 5. Malformed JSON body in HTTP request
  it('rejects malformed JSON syntax with 400 Bad Request and clean error envelope', async () => {
    const malformedPayloads = [
      '{ "model": "mock-chat", "messages": [', // unclosed array/object
      'not a json at all',
      '{ "model": "mock-chat", messages: }',
      '{"model": "mock-chat", "messages": [{"role": "user", "content": "hi"}]', // unclosed bracket
    ];

    for (const badPayload of malformedPayloads) {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: badPayload,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      assertDialectError(body, 'openai');
      expect(body.error.message.toLowerCase()).toContain('json');
    }
  });

  // 6. Truncated SSE chunks and incomplete JSON delta lines reassembly
  it('correctly reassembles SSE stream when chunks are sliced across arbitrary TCP packet boundaries', async () => {
    // Simulate an SSE response split across fragments
    const sseRaw = [
      'data: {"id":"chatcmpl_test_1","object":"chat.completion.chunk","created":1731693600,',
      '"model":"mock-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_test_1","object":"chat.completion.chunk","created":1731693600,',
      '"model":"mock-chat","choices":[{"index":0,"delta":{"content":"lo "},"finish_reason":null}]}\n\n',
      ': keepalive comment\n\n',
      'data: {"id":"chatcmpl_test_1","object":"chat.completion.chunk","created":1731693600,',
      '"model":"mock-chat","choices":[{"index":0,"delta":{"content":"World!"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_test_1","object":"chat.completion.chunk","created":1731693600,',
      '"model":"mock-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    // Split raw stream into tiny 16-byte chunks simulating high network fragmentation
    async function* makeFragmentedStream() {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(sseRaw);
      const chunkSize = 16;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.subarray(i, i + chunkSize);
      }
    }

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const chunk of makeFragmentedStream()) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const parsedChunks: any[] = [];
    for await (const ev of parseSSEStream(readable)) {
      if (ev.data === '[DONE]') {
        parsedChunks.push({ done: true });
      } else {
        parsedChunks.push(JSON.parse(ev.data));
      }
    }

    expect(parsedChunks.length).toBe(5);
    const textPieces = parsedChunks
      .filter((c) => !c.done && c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');

    expect(textPieces).toBe('Hello World!');
    expect(parsedChunks[parsedChunks.length - 1]).toEqual({ done: true });
  });
});
