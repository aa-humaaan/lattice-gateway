/**
 * Tier 2 Boundary & Corner Cases: Network Abort & Stream Cancellation
 * 
 * Verifies stream lifecycle and cancellation under network disconnections and aborts:
 * - Client sends AbortSignal mid-stream: server detects cancellation and terminates upstream iteration
 * - Client aborts during thinking tokens phase before text generation begins
 * - Client aborts during tool calling phase
 * - Upstream closes unexpectedly without [DONE] or message_stop marker
 * - Timeout handling when upstream hangs indefinitely
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class AbortableProviderPlugin implements ProviderPlugin {
  readonly id = 'abort-mock';
  readonly displayName = 'Abortable Mock Provider';
  readonly defaultBaseUrl = 'https://abort.lattice.local';

  // Tracking flags for assertions
  public emittedEventsCount = 0;
  public generatorCancelled = false;
  public phase = 'idle';

  reset(): void {
    this.emittedEventsCount = 0;
    this.generatorCancelled = false;
    this.phase = 'idle';
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'abort-mock/stream-test',
        name: 'Stream Abort Model',
        providerId: 'abort-mock',
        ownedBy: 'abort-mock',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'OK' }],
      stopReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const self = this;
    const mode = req.messages[0]?.content;

    return (async function* () {
      self.generatorCancelled = false;
      self.emittedEventsCount = 0;

      try {
        yield { type: 'stream_start', id: req.id, model: req.model, created: Math.floor(Date.now() / 1000) };
        self.emittedEventsCount++;

        if (mode === 'thinking-abort') {
          self.phase = 'thinking';
          for (let i = 0; i < 15; i++) {
            if (signal?.aborted) {
              self.generatorCancelled = true;
              return;
            }
            yield { type: 'thinking_delta', delta: `Thinking step ${i}... ` };
            self.emittedEventsCount++;
            await new Promise((r) => setTimeout(r, 20));
          }
          self.phase = 'text';
          yield { type: 'text_delta', delta: 'Should not reach this text if aborted' };
        } else if (mode === 'tool-abort') {
          self.phase = 'tool';
          yield { type: 'tool_call_start', index: 0, id: 'call_abort_1', name: 'large_tool' };
          self.emittedEventsCount++;
          for (let i = 0; i < 15; i++) {
            if (signal?.aborted) {
              self.generatorCancelled = true;
              return;
            }
            yield { type: 'tool_call_delta', index: 0, argumentsDelta: `{"key_${i}": "val_${i}",` };
            self.emittedEventsCount++;
            await new Promise((r) => setTimeout(r, 20));
          }
          yield { type: 'tool_call_stop', index: 0 };
        } else if (mode === 'unexpected-close') {
          self.phase = 'unexpected-close';
          yield { type: 'text_delta', delta: 'Chunk 1 before abrupt disconnect' };
          yield { type: 'text_delta', delta: 'Chunk 2 before abrupt disconnect' };
          // Stream abruptly returns without stream_end or usage
          return;
        } else if (mode === 'infinite-hang') {
          self.phase = 'hanging';
          // Hang indefinitely
          await new Promise(() => {});
        } else {
          // Standard slow stream for generic abort
          self.phase = 'text';
          for (let i = 0; i < 20; i++) {
            if (signal?.aborted) {
              self.generatorCancelled = true;
              return;
            }
            yield { type: 'text_delta', delta: `Chunk ${i} ` };
            self.emittedEventsCount++;
            await new Promise((r) => setTimeout(r, 20));
          }
        }

        yield { type: 'stream_end', stopReason: 'stop' };
      } finally {
        self.generatorCancelled = true;
      }
    })();
  }
}

describe('Tier 2 Boundary: Network Abort & Stream Cancellation', () => {
  let server: any;
  let plugin: AbortableProviderPlugin;
  let client: TestClient;
  let baseUrl: string;

  beforeAll(async () => {
    plugin = new AbortableProviderPlugin();
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

  // 1. Client sends AbortSignal / closes TCP socket mid-stream
  it('halts upstream generator and cleans up when client aborts mid-stream', async () => {
    plugin.reset();
    const abortController = new AbortController();

    const res = await client.openaiChat(
      {
        model: 'abort-mock/stream-test',
        messages: [{ role: 'user', content: 'generic-abort' }],
        stream: true,
      },
      { signal: abortController.signal }
    );

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    // Read the first 2 chunks
    const c1 = await reader.read();
    expect(c1.done).toBe(false);
    const c2 = await reader.read();
    expect(c2.done).toBe(false);

    // Abort client connection mid-stream
    abortController.abort();
    try {
      await reader.cancel();
    } catch {}

    // Allow generator cleanup to propagate
    await new Promise((r) => setTimeout(r, 60));

    expect(plugin.generatorCancelled).toBe(true);
    // Verified it did not emit all 20 chunks
    expect(plugin.emittedEventsCount).toBeLessThan(15);
  });

  // 2. Client aborts during thinking tokens phase
  it('aborts during thinking phase and halts before text completion is emitted', async () => {
    plugin.reset();
    const abortController = new AbortController();

    const res = await client.openaiChat(
      {
        model: 'abort-mock/stream-test',
        messages: [{ role: 'user', content: 'thinking-abort' }],
        stream: true,
      },
      { signal: abortController.signal }
    );

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    // Read initial chunks
    const chunk1 = await reader.read();
    expect(chunk1.done).toBe(false);

    // Verify thinking phase was active
    expect(plugin.phase).toBe('thinking');

    // Abort during thinking
    abortController.abort();
    try {
      await reader.cancel();
    } catch {}

    await new Promise((r) => setTimeout(r, 60));
    expect(plugin.generatorCancelled).toBe(true);
    expect(plugin.phase).toBe('thinking'); // Never progressed to text phase!
  });

  // 3. Client aborts during tool calling phase
  it('aborts during incremental tool argument streaming without emitting finished tool call', async () => {
    plugin.reset();
    const abortController = new AbortController();

    const res = await client.openaiChat(
      {
        model: 'abort-mock/stream-test',
        messages: [{ role: 'user', content: 'tool-abort' }],
        stream: true,
      },
      { signal: abortController.signal }
    );

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    // Read 2 chunks
    await reader.read();
    await reader.read();
    expect(plugin.phase).toBe('tool');

    // Abort mid-arguments
    abortController.abort();
    try {
      await reader.cancel();
    } catch {}

    await new Promise((r) => setTimeout(r, 60));
    expect(plugin.generatorCancelled).toBe(true);
    expect(plugin.emittedEventsCount).toBeLessThan(12);
  });

  // 4. Upstream closes unexpectedly without [DONE] or message_stop
  it('handles unexpected upstream closure gracefully when stream ends without [DONE]', async () => {
    plugin.reset();

    const res = await client.openaiChat({
      model: 'abort-mock/stream-test',
      messages: [{ role: 'user', content: 'unexpected-close' }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
    }

    // Stream reader terminated normally at EOF
    expect(accumulated).toContain('Chunk 1 before abrupt disconnect');
    expect(accumulated).toContain('Chunk 2 before abrupt disconnect');
    // Notice: stream adapter appends [DONE] upon stream completion
    expect(accumulated).toContain('data: [DONE]');
  });

  // 5. Timeout handling when upstream hangs
  it('handles client timeout when upstream hangs indefinitely', async () => {
    plugin.reset();

    const startTime = Date.now();
    try {
      const res = await client.openaiChat(
        {
          model: 'abort-mock/stream-test',
          messages: [{ role: 'user', content: 'infinite-hang' }],
          stream: true,
        },
        { signal: AbortSignal.timeout(100) }
      );
      // Read stream until timeout triggers
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(
        err.name === 'TimeoutError' ||
        err.name === 'AbortError' ||
        err.message?.includes('abort') ||
        err.message?.includes('timeout')
      ).toBe(true);
    }
  });
});
