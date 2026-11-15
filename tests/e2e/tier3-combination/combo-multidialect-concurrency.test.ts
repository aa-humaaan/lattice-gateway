/**
 * Tier 3 Cross-Feature Combinations: Multi-Dialect Concurrency & Isolation
 * 
 * Verifies dialect isolation and protocol integrity under concurrent multi-client load:
 * - Simultaneous concurrent OpenAI /v1/chat/completions and Anthropic /v1/messages requests routed to same provider
 * - Dialect isolation: OpenAI clients receive choices[0].delta while Anthropic clients receive content_block_delta
 * - Error format isolation under concurrency: OpenAI gets OpenAI error schema, Anthropic gets Anthropic error schema
 * - Catalog queries (GET /v1/models) concurrent with high-rate streaming requests
 * - Mixed concurrent thinking streams: OpenAI clients get reasoning_content, Anthropic clients get thinking_delta
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertAnthropicSuccess,
  assertDialectError,
  assertThinkingContent,
  assertModelPresent,
  assertStreamDone,
} from '../../harness/assertions';
import { GatewayError } from '../../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class SharedProviderPlugin implements ProviderPlugin {
  readonly id = 'shared-multi';
  readonly displayName = 'Shared Multi-Dialect Provider';
  readonly defaultBaseUrl = 'https://shared.lattice.local';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'shared-multi/core-engine',
        name: 'Shared Core Engine',
        providerId: 'shared-multi',
        ownedBy: 'shared-multi',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const lastMsg = req.messages[req.messages.length - 1];
    const text = typeof lastMsg?.content === 'string' ? lastMsg.content : 'Hello';

    if (text.includes('simulate-error')) {
      throw new GatewayError(429, 'rate_limit_error', 'Simulated concurrent rate limit error', { retryAfter: 12 });
    }

    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: `Echo: ${text}` }],
      stopReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 12, totalTokens: 24 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const lastMsg = req.messages[req.messages.length - 1];
    const text = typeof lastMsg?.content === 'string' ? lastMsg.content : 'Hello';

    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };

      if (text.includes('concurrent-thinking')) {
        yield { type: 'thinking_delta', delta: 'Analyzing problem concurrently... ' };
        yield { type: 'thinking_delta', delta: 'Concurrent reasoning complete.' };
        yield { type: 'text_delta', delta: 'Final concurrent answer' };
      } else {
        yield { type: 'text_delta', delta: `Stream echo: ${text}` };
      }

      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 3 Combination: Multi-Dialect Concurrency & Isolation', () => {
  let server: any;
  let plugin: SharedProviderPlugin;
  let client: TestClient;

  beforeAll(async () => {
    plugin = new SharedProviderPlugin();
    const app = createServer({ port: 0 }, [plugin]);
    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${server.port}`);
  });

  afterAll(async () => {
    if (server) {
      server.stop(true);
    }
  });

  // 1. Simultaneous concurrent OpenAI and Anthropic requests routed to same provider
  it('processes 10 OpenAI and 10 Anthropic concurrent requests with strict dialect isolation and valid envelopes', async () => {
    const openaiRequests = Array.from({ length: 10 }, (_, i) =>
      client.openaiChat({
        model: 'shared-multi/core-engine',
        messages: [{ role: 'user', content: `OpenAI concurrent req #${i}` }],
      })
    );

    const anthropicRequests = Array.from({ length: 10 }, (_, i) =>
      client.anthropicMessages({
        model: 'shared-multi/core-engine',
        messages: [{ role: 'user', content: `Anthropic concurrent req #${i}` }],
      })
    );

    const [openaiResponses, anthropicResponses] = await Promise.all([
      Promise.all(openaiRequests),
      Promise.all(anthropicRequests),
    ]);

    // Verify all 10 OpenAI responses
    for (const res of openaiResponses) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      assertOpenAISuccess(body);
      expect(body.object).toBe('chat.completion');
      expect(body.choices).toBeArray();
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toContain('OpenAI concurrent req');
    }

    // Verify all 10 Anthropic responses
    for (const res of anthropicResponses) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      assertAnthropicSuccess(body);
      expect(body.type).toBe('message');
      expect(body.role).toBe('assistant');
      expect(body.content[0].type).toBe('text');
      expect(body.content[0].text).toContain('Anthropic concurrent req');
    }
  });

  // 2. Dialect isolation in streaming under concurrency
  it('guarantees SSE wire format isolation: OpenAI clients get choices[0].delta while Anthropic clients get content_block_delta', async () => {
    const openaiStreams = Array.from({ length: 5 }, async (_, i) => {
      const stream = client.openaiChatStream({
        model: 'shared-multi/core-engine',
        messages: [{ role: 'user', content: `OpenAI Stream #${i}` }],
      });
      const chunks = await TestClient.collect(stream);
      assertStreamDone(chunks);
      return chunks;
    });

    const anthropicStreams = Array.from({ length: 5 }, async (_, i) => {
      const stream = client.anthropicMessagesStream({
        model: 'shared-multi/core-engine',
        messages: [{ role: 'user', content: `Anthropic Stream #${i}` }],
      });
      const events = await TestClient.collect(stream);
      return events;
    });

    const [allOpenaiChunks, allAnthropicEvents] = await Promise.all([
      Promise.all(openaiStreams),
      Promise.all(anthropicStreams),
    ]);

    // Check OpenAI stream wire shapes
    for (const chunks of allOpenaiChunks) {
      for (const chunk of chunks) {
        expect(chunk.object).toBe('chat.completion.chunk');
        expect(chunk.choices).toBeArray();
        expect(chunk.choices[0].delta).toBeDefined();
        // MUST NOT contain Anthropic content_block events
        expect((chunk as any).type).toBeUndefined();
      }
    }

    // Check Anthropic stream wire shapes
    for (const events of allAnthropicEvents) {
      const eventTypes = events.map((e) => e.data.type);
      expect(eventTypes).toContain('message_start');
      expect(eventTypes).toContain('content_block_delta');
      expect(eventTypes).toContain('message_stop');
      // MUST NOT contain OpenAI choices array
      for (const ev of events) {
        expect((ev.data as any).choices).toBeUndefined();
      }
    }
  });

  // 3. Error format isolation under concurrency
  it('isolates error response schemas: OpenAI gets OpenAI error envelope and Anthropic gets Anthropic envelope', async () => {
    const openaiErrReq = client.openaiChat({
      model: 'shared-multi/core-engine',
      messages: [{ role: 'user', content: 'simulate-error-openai' }],
    });

    const anthropicErrReq = client.anthropicMessages({
      model: 'shared-multi/core-engine',
      messages: [{ role: 'user', content: 'simulate-error-anthropic' }],
    });

    const [resOpenAI, resAnthropic] = await Promise.all([openaiErrReq, anthropicErrReq]);

    expect(resOpenAI.status).toBe(429);
    const bodyOpenAI = (await resOpenAI.json()) as any;
    assertDialectError(bodyOpenAI, 'openai');
    expect(bodyOpenAI.error.message).toContain('Simulated concurrent');

    expect(resAnthropic.status).toBe(429);
    const bodyAnthropic = (await resAnthropic.json()) as any;
    assertDialectError(bodyAnthropic, 'anthropic');
    expect(bodyAnthropic.type).toBe('error');
    expect(bodyAnthropic.error.message).toContain('Simulated concurrent');
  });

  // 4. Models catalog query concurrent with high-rate streaming requests
  it('serves aggregated models catalog concurrently with active streaming requests without blockage', async () => {
    // Launch 8 continuous streaming requests
    const activeStreams = Array.from({ length: 8 }, async (_, i) => {
      const stream = client.openaiChatStream({
        model: 'shared-multi/core-engine',
        messages: [{ role: 'user', content: `Concurrent stream #${i}` }],
      });
      return TestClient.collect(stream);
    });

    // Concurrently fetch models catalog
    const catalogPromises = Array.from({ length: 5 }, async () => {
      const res = await client.getModels();
      expect(res.status).toBe(200);
      return res.json();
    });

    const [streamOutputs, catalogOutputs] = await Promise.all([
      Promise.all(activeStreams),
      Promise.all(catalogPromises),
    ]);

    expect(streamOutputs.length).toBe(8);
    expect(catalogOutputs.length).toBe(5);

    for (const catalog of catalogOutputs as any[]) {
      assertModelPresent(catalog, 'shared-multi/core-engine');
    }
  });

  // 5. Mixed streaming thinking tokens across dialects
  it('streams thinking tokens simultaneously to OpenAI clients as reasoning_content and Anthropic clients as thinking_delta', async () => {
    const openaiThinkingStream = client.openaiChatStream({
      model: 'shared-multi/core-engine',
      messages: [{ role: 'user', content: 'concurrent-thinking-test' }],
    });

    const anthropicThinkingStream = client.anthropicMessagesStream({
      model: 'shared-multi/core-engine',
      messages: [{ role: 'user', content: 'concurrent-thinking-test' }],
    });

    const [openaiChunks, anthropicEvents] = await Promise.all([
      TestClient.collect(openaiThinkingStream),
      TestClient.collect(anthropicThinkingStream),
    ]);

    // Verify OpenAI reasoning_content
    const reasoningText = assertThinkingContent(openaiChunks);
    expect(reasoningText).toContain('Analyzing problem concurrently');

    // Verify Anthropic thinking_delta
    const thinkingBlocks = anthropicEvents
      .filter((e) => e.data.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta?.thinking)
      .join('');
    expect(thinkingBlocks).toContain('Analyzing problem concurrently');
  });
});
