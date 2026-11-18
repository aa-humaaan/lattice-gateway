import { describe, it, expect } from 'bun:test';
import { withIdleTimeout } from '../../src/utils/idle-timeout';
import type { CanonicalStreamEvent } from '../../src/core/types/canonical';

describe('withIdleTimeout & Hung-Stream Recovery', () => {
  it('passes normal stream events through with zero overhead', async () => {
    async function* fastStream(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'resp_1', model: 'test-model', created: Date.now() };
      yield { type: 'text_delta', delta: 'Hello world' };
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    const timed = withIdleTimeout(fastStream(), {
      idleTimeoutMs: 500,
      requestTimeoutMs: 1000,
    });

    const events: CanonicalStreamEvent[] = [];
    for await (const e of timed) {
      events.push(e);
    }

    expect(events.length).toBe(3);
    expect(events[0].type).toBe('stream_start');
    expect(events[1].type).toBe('text_delta');
    expect(events[2].type).toBe('stream_end');
  });

  it('aborts and emits stream_idle_timeout error when upstream hangs past idleTimeoutMs', async () => {
    async function* hungStream(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'resp_hung', model: 'test-model', created: Date.now() };
      // Hang indefinitely
      await new Promise((resolve) => setTimeout(resolve, 2000));
      yield { type: 'text_delta', delta: 'Never received' };
    }

    let timeoutReason: string | undefined;
    const timed = withIdleTimeout(hungStream(), {
      idleTimeoutMs: 50,
      requestTimeoutMs: 1000,
      onTimeout: (reason) => {
        timeoutReason = reason;
      },
    });

    const events: CanonicalStreamEvent[] = [];
    for await (const e of timed) {
      events.push(e);
    }

    expect(timeoutReason).toBe('idle');
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('stream_start');
    expect(events[1].type).toBe('stream_error');

    const err = (events[1] as any).error;
    expect(err.code).toBe('stream_idle_timeout');
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/idle for more than/i);
  });

  it('aborts and emits request_timeout error when total stream lifetime exceeds requestTimeoutMs', async () => {
    async function* slowTrickleStream(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'resp_slow', model: 'test-model', created: Date.now() };
      // Emits events frequently enough to beat idle timeout (every 25ms), but total duration exceeds requestTimeoutMs (60ms)
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield { type: 'text_delta', delta: `Chunk ${i} ` };
      }
      yield { type: 'stream_end', stopReason: 'stop' };
    }

    let timeoutReason: string | undefined;
    const timed = withIdleTimeout(slowTrickleStream(), {
      idleTimeoutMs: 100,
      requestTimeoutMs: 60,
      onTimeout: (reason) => {
        timeoutReason = reason;
      },
    });

    const events: CanonicalStreamEvent[] = [];
    for await (const e of timed) {
      events.push(e);
    }

    expect(timeoutReason).toBe('request');
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('stream_error');
    const err = (lastEvent as any).error;
    expect(err.code).toBe('request_timeout');
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/exceeded maximum duration/i);
  });

  it('tears down cleanly when client signal aborts', async () => {
    let returnCalled = false;
    const source: AsyncIterable<CanonicalStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return { done: false, value: { type: 'text_delta', delta: 'delayed' } as CanonicalStreamEvent };
          },
          async return() {
            returnCalled = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    const controller = new AbortController();
    const timed = withIdleTimeout(source, {
      idleTimeoutMs: 1000,
      requestTimeoutMs: 5000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 30);

    const events: CanonicalStreamEvent[] = [];
    for await (const e of timed) {
      events.push(e);
    }

    expect(events.length).toBe(0);
    expect(returnCalled).toBe(true);
  });
});
