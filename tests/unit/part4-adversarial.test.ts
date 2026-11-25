import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../src/core/server';
import { globalAccountPool } from '../../src/pool/account-pool';
import { globalBreakerRegistry } from '../../src/core/breaker';
import { safeFetch } from '../../src/core/safe-fetch';
import type { ProviderPlugin, ModelDescriptor } from '../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';
import { GatewayError } from '../../src/core/types/errors';

/* ------------------------------------------------------------------ */
/* Shared slow-stream mock plugin                                     */
/* ------------------------------------------------------------------ */

class SlowStreamPlugin implements ProviderPlugin {
  readonly id = 'slow-stream';
  readonly displayName = 'Slow Stream Mock';
  readonly defaultBaseUrl = 'https://slow-stream.lattice.local/v1';
  public inFlight = 0;
  public peakInFlight = 0;

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: 'slow-stream/echo', name: 'Slow Echo', providerId: 'slow-stream', ownedBy: 'x', created: 1 }];
  }

  async execute(): Promise<CanonicalResponse> {
    throw new GatewayError(500, 'api_error', 'slow-stream is stream-only');
  }

  async executeStream(_req: CanonicalRequest, signal?: AbortSignal): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const self = this;
    return (async function* () {
      try {
        for (let i = 0; i < 50; i++) {
          if (signal?.aborted) return;
          yield { type: 'text_delta', delta: `chunk-${i}` };
          await new Promise((r) => setTimeout(r, 5));
        }
        yield { type: 'stream_end', stopReason: 'stop' };
      } finally {
        self.inFlight--;
      }
    })();
  }
}

/* ------------------------------------------------------------------ */
/* ADV-1: kill -9 during a store write                                */
/* ------------------------------------------------------------------ */

describe('ADV-1: kill -9 during a store write', () => {
  it('leaves the store parseable (atomic writes survive SIGKILL)', async () => {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { existsSync, mkdirSync, readFileSync, rmSync } = await import('node:fs');
    const { spawnGatewayOnFreePort } = await import('../harness/subprocess-gateway');

    const dataDir = join(tmpdir(), `lattice-adv1-${Math.random().toString(36).slice(2, 9)}`);
    mkdirSync(dataDir, { recursive: true });

    // PORT=0 + banner read: no fixed port to collide with another worker,
    // no bind-then-release race, and kill() reaches bun.exe directly.
    const { proc } = await spawnGatewayOnFreePort(undefined, { DATA_DIR: dataDir });

    const storePath = join(dataDir, 'lattice-store.json');
    // The store is written on startup before health is served, but assert the
    // condition instead of assuming a fixed delay before the SIGKILL.
    const deadline = Date.now() + 5000;
    while (!existsSync(storePath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(storePath)).toBe(true);

    proc.kill('SIGKILL');
    if (proc.exitCode === null) {
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    }
    await new Promise((r) => setTimeout(r, 100));

    let storeValid = false;
    if (existsSync(storePath)) {
      try {
        const data = JSON.parse(readFileSync(storePath, 'utf8'));
        storeValid = data.schemaVersion !== undefined && Array.isArray(data.accounts);
      } catch { storeValid = false; }
    }

    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}

    expect(storeValid).toBe(true);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* ADV-2: HTML payload in a model/account name                        */
/* ------------------------------------------------------------------ */

describe('ADV-2: HTML payload in model/account name', () => {
  it('round-trips through the admin API as JSON data (no server-side HTML reflection)', async () => {
    const app = createServer({ dataDir: 'data-adv2' });
    const htmlId = `acc-<img src=x onerror=alert(1)>`;
    const res = await app.request('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'kilo', id: htmlId, credentials: { apiKey: 'sk-test' } }),
    });
    expect(res.status).toBe(200);

    const list = await app.request('/api/accounts');
    const body = (await list.json()) as any;
    const ids = (body.accounts ?? []).map((a: any) => a.id);
    expect(ids).toContain(htmlId);
    // The API returns JSON data (not HTML-reflected); rendering-time escaping
    // is applied by escapeHtml throughout dashboard-ui.ts (covered by dashboard-xss.test.ts).
    expect(list.headers.get('content-type')?.includes('application/json')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ADV-3: 302 redirect to 169.254.169.254 is refused                  */
/* ------------------------------------------------------------------ */

describe('ADV-3: 302 redirect to link-local metadata', () => {
  it('refuses to follow an upstream redirect to 169.254.169.254', async () => {
    const { serve } = await import('bun');
    const upstream = serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
        }),
    });
    const upUrl = `http://127.0.0.1:${upstream.port}`;

    class RedirectPlugin implements ProviderPlugin {
      readonly id = 'redirect-mock';
      readonly displayName = 'Redirect Mock';
      readonly defaultBaseUrl = upUrl;
      async listModels(): Promise<ModelDescriptor[]> {
        return [{ id: 'redirect-mock/m', name: 'M', providerId: 'redirect-mock', ownedBy: 'x', created: 1 }];
      }
      async execute(): Promise<CanonicalResponse> {
        // safeFetch follows redirects manually and must refuse the 169.254 target.
        await safeFetch(upUrl, { method: 'POST' });
        return { id: 'x', model: 'm', created: 0, content: [{ type: 'text', text: 'should not reach' }], stopReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }
      async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
        return (async function* () { })();
      }
    }

    const app = createServer({}, [new RedirectPlugin()]);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'redirect-mock/m', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    upstream.stop();
    // The redirect target must be refused: never a 200 with metadata content.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text).toContain('Refusing');
    expect(text).toContain('api_error');
  });
});

/* ------------------------------------------------------------------ */
/* ADV-4: 200 parallel requests with random client aborts             */
/* ------------------------------------------------------------------ */

describe('ADV-4: 200 parallel requests with random aborts', () => {
  it('leaves no leaked reservations after random client aborts', async () => {
    const app = createServer({}, [new SlowStreamPlugin()]);
    const before = globalAccountPool.getInFlightCounts();

    const abortControllers: AbortController[] = [];
    const promises: Promise<void>[] = [];
    const total = 200;

    for (let i = 0; i < total; i++) {
      const ctrl = new AbortController();
      abortControllers.push(ctrl);
      const abortMs = i % 3 === 0 ? 20 + (i % 40) : 0;
      const t = (async () => {
        if (abortMs > 0) setTimeout(() => ctrl.abort(), abortMs);
        try {
          await app.request('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'slow-stream/echo', messages: [{ role: 'user', content: 'hi' }], stream: true }),
            signal: ctrl.signal,
          });
        } catch { /* aborts expected */ }
      })();
      promises.push(t);
    }
    await Promise.all(promises);
    await new Promise((r) => setTimeout(r, 500));

    const after = globalAccountPool.getInFlightCounts();
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      expect((after[k] ?? 0) - (before[k] ?? 0)).toBe(0);
    }
    expect(globalAccountPool.getInFlightCounts()).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* ADV-5: upstream 5xx storm + circuit breaker                        */
/* ------------------------------------------------------------------ */

describe('ADV-5: upstream 5xx storm trips the circuit breaker', () => {
  it('trips the breaker and stops routing provider calls once it is open', async () => {
    globalBreakerRegistry.configure('flaky', {
      failureThreshold: 5, backoffBaseMs: 600_000, backoffCeilingMs: 600_000, jitterRatio: 0,
    });
    class FlakyPlugin implements ProviderPlugin {
      readonly id = 'flaky';
      readonly displayName = 'Flaky Mock';
      readonly defaultBaseUrl = 'https://flaky.lattice.local/v1';
      public failures = 0;
      async listModels(): Promise<ModelDescriptor[]> {
        return [{ id: 'flaky/m', name: 'Flaky', providerId: 'flaky', ownedBy: 'x', created: 1 }];
      }
      async execute(): Promise<CanonicalResponse> {
        this.failures++;
        throw new GatewayError(500, 'api_error', 'upstream 5xx storm');
      }
      async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
        return (async function* () { })();
      }
    }
    const plugin = new FlakyPlugin();
    const app = createServer({}, [plugin]);

    for (let i = 0; i < 6; i++) {
      await app.request('/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'flaky/m', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });
    }
    const breaker = globalBreakerRegistry.get('flaky');
    expect(breaker.state).toBe('open');

    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'flaky/m', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(res.status).toBe(503); // breaker_open; no provider call, no outcome recorded
    expect(plugin.failures).toBe(5);
    expect(breaker.failures).toBe(5);

    breaker.reset();
    expect(breaker.state).toBe('closed');
  });
});

/* ------------------------------------------------------------------ */
/* ADV-6: two parallel tool calls per dialect                         */
/* ------------------------------------------------------------------ */

function streamingToolPlugin(toolCalls: Array<{ id: string; name: string; input: unknown }>): ProviderPlugin {
  return {
    id: 'tool-mock',
    displayName: 'Tool Mock',
    defaultBaseUrl: 'https://tool-mock.lattice.local/v1',
    async listModels(): Promise<ModelDescriptor[]> {
      return [{ id: 'tool-mock/parallel', name: 'Parallel Tools', providerId: 'tool-mock', ownedBy: 'x', created: 1 }];
    },
    async execute(): Promise<CanonicalResponse> {
      return {
        id: 'x', model: 'tool-mock/parallel', created: 0,
        content: toolCalls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input as Record<string, unknown> })),
        stopReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    },
    async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      const events: CanonicalStreamEvent[] = [
        { type: 'stream_start', id: 'x', model: 'tool-mock/parallel', created: 0 },
      ];
      let index = 0;
      for (const tc of toolCalls) {
        events.push({ type: 'tool_call_start', index, id: tc.id, name: tc.name });
        events.push({ type: 'tool_call_delta', index, argumentsDelta: JSON.stringify(tc.input) });
        events.push({ type: 'tool_call_stop', index });
        index++;
      }
      events.push({ type: 'usage', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });
      return (async function* () { for (const e of events) yield e; })();
    },
  };
}

describe('ADV-6: two parallel tool calls per dialect', () => {
  it('OpenAI SDK: parallel tools stream through with correct IDs and args', async () => {
    const { serve } = await import('bun');
    const app = createServer({}, [streamingToolPlugin([
      { id: 'call_A', name: 'get_weather', input: { city: 'Paris' } },
      { id: 'call_B', name: 'get_weather', input: { city: 'London' } },
    ])]);
    const server = serve({ port: 0, fetch: app.fetch });
    await new Promise((r) => setTimeout(r, 100));
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const { OpenAI } = await import('openai');
    const client = new OpenAI({ baseURL: baseUrl + '/v1', apiKey: 'x' });
    const stream = await client.chat.completions.create({
      model: 'tool-mock/parallel',
      messages: [{ role: 'user', content: 'weather' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    });
    const byIndex = new Map<number, { index: number; id?: string; name?: string; args: string }>();
    for await (const chunk of stream as any) {
      const tc = chunk.choices?.[0]?.delta?.tool_calls;
      if (tc) {
        for (const c of tc) {
          let e = byIndex.get(c.index);
          if (!e) { e = { index: c.index, args: '' }; byIndex.set(c.index, e); }
          if (c.id) e.id = c.id;
          if (c.function?.name) e.name = c.function.name;
          if (c.function?.arguments !== undefined) e.args += c.function.arguments;
        }
      }
    }
    const calls = Array.from(byIndex.values());
    server.stop();
    expect(calls.filter((c) => c.id === 'call_A').length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c.id === 'call_B').length).toBeGreaterThanOrEqual(1);
    expect(calls.find((c) => c.id === 'call_A')?.args).toContain('Paris');
    expect(calls.find((c) => c.id === 'call_B')?.args).toContain('London');
  });

  it('Anthropic raw fetch: two parallel tool_use blocks serialize', async () => {
    const app = createServer({}, [streamingToolPlugin([
      { id: 'call_X', name: 'fetch', input: { url: 'a' } },
      { id: 'call_Y', name: 'fetch', input: { url: 'b' } },
    ])]);
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'tool-mock/parallel',
        messages: [{ role: 'user', content: 'fetch' }],
        tools: [{ name: 'fetch', input_schema: {} }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('call_X');
    expect(text).toContain('call_Y');
  });
});
