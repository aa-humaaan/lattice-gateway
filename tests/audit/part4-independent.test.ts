import { describe, it, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from 'bun';
import { createServer } from '../../src/core/server';
import { globalAccountPool } from '../../src/pool/account-pool';
import { globalBreakerRegistry } from '../../src/core/breaker';
import { createSafeFetch } from '../../src/core/safe-fetch';
import { getDashboardHtml } from '../../src/admin/dashboard-ui';
import { GatewayError } from '../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor } from '../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../src/core/types/canonical';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* ADV-1: kill -9 during a real store write                            */
/* ------------------------------------------------------------------ */

describe('ADV-1 kill -9 during store write', () => {
  it('previous store stays valid after SIGKILL mid-write; corrupt load quarantines', async () => {
    const N = 120_000;
    const writer = resolve(process.cwd(), 'tests/audit/fixtures/store-writer.ts');
    const results: Array<{ round: number; valid: boolean; accounts: number; temp: string[] }> = [];

    for (let round = 0; round < 3; round++) {
      const dir = mkdtempSync(join(tmpdir(), `lg-kill9-${round}-`));
      const store = join(dir, 'lattice-store.json');
      const accounts = Array.from({ length: N }, (_, i) => ({
        id: `acc_${i}`, providerId: 'kilo', credentials: { apiKey: 'k' }, status: 'active',
      }));
      writeFileSync(store, JSON.stringify({ schemaVersion: 2, accounts, combos: [], proxies: [], updatedAt: 1 }));

      const child = spawn(process.execPath, [writer], {
        env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' },
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let killed = false;
      await new Promise<void>((done) => {
        let buf = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          if (!killed && buf.includes('WRITING')) {
            killed = true;
            // Kill a couple of milliseconds into the write, not before it.
            setTimeout(() => { child.kill('SIGKILL'); done(); }, 2 + round * 3);
          }
        });
        child.on('exit', () => done());
        setTimeout(() => { if (!killed) { child.kill('SIGKILL'); done(); } }, 15000);
      });
      await sleep(80);

      let valid = false, count = -1;
      try {
        const parsed = JSON.parse(readFileSync(store, 'utf8'));
        valid = parsed.schemaVersion === 2 && Array.isArray(parsed.accounts);
        count = parsed.accounts?.length ?? -1;
      } catch { valid = false; }
      const extras = readdirSync(dir).filter((f) => f.startsWith('lattice-store.json'));
      results.push({ round, valid, accounts: count, temp: extras });
      console.log(`ADV-1 round ${round}: valid=${valid} accounts=${count} siblings=${JSON.stringify(extras)}`);
      rmSync(dir, { recursive: true, force: true });
    }

    for (const r of results) {
      expect(r.valid).toBe(true);
      expect(r.accounts).toBe(N);
      expect(r.temp.filter((f) => f.endsWith('.corrupt'))).toEqual([]);
    }

    // Corrupt file must be preserved, reported, and never silently emptied.
    const badDir = mkdtempSync(join(tmpdir(), 'lg-corrupt-'));
    const badStore = join(badDir, 'lattice-store.json');
    writeFileSync(badStore, '{"schemaVersion":2,"accounts":[ this is not json');
    const probe = spawn(process.execPath, [resolve(process.cwd(), 'tests/audit/fixtures/corrupt-probe.ts')], {
      env: { ...process.env, DATA_DIR: badDir }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    probe.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
    const code = await new Promise<number | null>((r) => probe.on('exit', r));
    const siblings = readdirSync(badDir);
    console.log(`ADV-1 corrupt-load: exit=${code} stderr=${stderr.split('\n').filter((l) => /CORRECT|CORRUPT|quarantin/i.test(l)).join(' | ').slice(0, 300)} siblings=${JSON.stringify(siblings)}`);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/CORRUPT STORE|corrupt store/i);
    expect(siblings.some((f) => f.includes('.corrupt-'))).toBe(true);
    expect(readFileSync(badStore, 'utf8')).toContain('this is not json');
    rmSync(badDir, { recursive: true, force: true });
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* ADV-2: HTML payload in a model name                                 */
/* ------------------------------------------------------------------ */

function extractFunction(script: string, name: string): string {
  const at = script.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`missing ${name}`);
  const start = at >= 6 && script.slice(at - 6, at) === 'async ' ? at - 6 : at;
  const open = script.indexOf('{', start);
  let depth = 0, quote = '', esc = false;
  for (let i = open; i < script.length; i++) {
    const ch = script[i];
    if (quote) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function domStub() {
  const els = new Map<string, any>();
  const make = () => ({
    innerHTML: '', textContent: '', className: '', style: {} as any, children: [] as any[],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, appendChild() {}, prepend() {}, removeChild() {}, querySelector() { return null; },
  });
  return {
    els,
    document: {
      getElementById(id: string) { if (!els.has(id)) els.set(id, make()); return els.get(id); },
      createElement() { return make(); }, addEventListener() {}, querySelector() { return null; },
    },
  };
}

describe('ADV-2 HTML payload in model name', () => {
  it('rendered grid/logs escape the payload and dashboard sends a nonce-only CSP', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = getDashboardHtml('auditnonce');
    const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
    const escStart = script.indexOf('function escapeHtml(str) {');
    const escSrc = script.slice(escStart, script.indexOf('\n    }', escStart) + '\n    }'.length);
    const escapeHtml = new Function(`${escSrc}; return escapeHtml;`)() as (v: string) => string;

    const d1 = domStub();
    const renderModelsGrid = new Function('document', 'escapeHtml',
      `${escSrc}\n${extractFunction(script, 'renderModelsGrid')}\nreturn renderModelsGrid;`
    )(d1.document, escapeHtml);
    renderModelsGrid([{ id: payload, name: payload, providerId: payload, ownedBy: payload, badges: [] }]);
    const gridHtml = d1.els.get('models-grid-container')?.innerHTML ?? '';
    console.log(`ADV-2 grid contains raw payload: ${gridHtml.includes(payload)}; escaped: ${gridHtml.includes('&lt;img')}`);
    expect(gridHtml).not.toContain(payload);
    expect(gridHtml).toContain('&lt;img');

    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-adv2-')) }, []);
    const dash = await app.request('/');
    const csp = dash.headers.get('content-security-policy') ?? '';
    console.log(`ADV-2 dashboard status=${dash.status} CSP=${csp.slice(0, 180)}`);
    expect(dash.status).toBe(200);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);

    // A gateway-token model name reaches the ledger, then the dashboard API.
    class EchoPlugin implements ProviderPlugin {
      readonly id = 'echo'; readonly displayName = 'Echo'; readonly defaultBaseUrl = 'https://echo.local/v1';
      async listModels(): Promise<ModelDescriptor[]> { return [{ id: 'echo/m', name: 'M', providerId: 'echo', ownedBy: 'x', created: 1 }]; }
      async execute(): Promise<CanonicalResponse> { return { id: 'x', model: payload, created: 0, content: [], stopReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; }
      async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> { return (async function* () {})(); }
    }
    const app2 = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-adv2b-')) }, [new EchoPlugin()]);
    await app2.request('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'echo/m', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const logsRes = await app2.request('/api/logs');
    const logsText = await logsRes.text();
    console.log(`ADV-2 /api/logs status=${logsRes.status} contentType=${logsRes.headers.get('content-type')} rawPayload=${logsText.includes(payload)}`);
    expect(logsRes.headers.get('content-type')).toContain('application/json');
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* ADV-3: 302 redirect to 169.254.169.254                              */
/* ------------------------------------------------------------------ */

describe('ADV-3 302 redirect to link-local metadata', () => {
  it('safeFetch refuses the hop and never issues the link-local request', async () => {
    let targetHits = 0;
    const impl = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.includes('169.254.169.254')) targetHits++;
      return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' } });
    }) as typeof fetch;
    const sf = createSafeFetch(impl);
    let error = '';
    try { await sf('http://127.0.0.1:40123/v1/chat/completions'); } catch (e: any) { error = e.message; }
    console.log(`ADV-3 safeFetch error="${error}" targetHits=${targetHits}`);
    expect(error).toMatch(/Refusing unsafe redirect target/);
    expect(targetHits).toBe(0);

    // HTTPS -> HTTP downgrade must be refused too.
    let downgradeHits = 0;
    const impl2 = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.startsWith('http://')) downgradeHits++;
      return new Response(null, { status: 302, headers: { Location: 'http://evil.example/v1' } });
    }) as typeof fetch;
    const sf2 = createSafeFetch(impl2);
    let e2 = '';
    try { await sf2('https://trusted.example/v1'); } catch (e: any) { e2 = e.message; }
    console.log(`ADV-3 downgrade error="${e2}" downgradeHits=${downgradeHits}`);
    expect(e2).toMatch(/HTTPS-to-HTTP downgrade/);
    expect(downgradeHits).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* ADV-4: 200 parallel requests with random client aborts              */
/* ------------------------------------------------------------------ */

class SlowStreamPlugin implements ProviderPlugin {
  readonly id = 'slow-stream'; readonly displayName = 'Slow Stream'; readonly defaultBaseUrl = 'https://slow.local/v1';
  inFlight = 0; peak = 0;
  async listModels(): Promise<ModelDescriptor[]> { return [{ id: 'slow-stream/echo', name: 'Slow', providerId: 'slow-stream', ownedBy: 'x', created: 1 }]; }
  async execute(): Promise<CanonicalResponse> { throw new GatewayError(500, 'api_error', 'stream only'); }
  async executeStream(_req: CanonicalRequest, signal?: AbortSignal): Promise<AsyncIterable<CanonicalStreamEvent>> {
    this.inFlight++; this.peak = Math.max(this.peak, this.inFlight);
    const self = this;
    return (async function* () {
      try {
        for (let i = 0; i < 40; i++) {
          if (signal?.aborted) return;
          yield { type: 'text_delta', delta: `c${i}` };
          await sleep(4);
        }
        yield { type: 'stream_end', stopReason: 'stop' };
      } finally { self.inFlight--; }
    })();
  }
}

describe('ADV-4 200 parallel requests with random client aborts', () => {
  it('in-flight counts return to zero', async () => {
    const plugin = new SlowStreamPlugin();
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-adv4-')) }, [plugin]);
    const server = serve({ port: 0, fetch: app.fetch });
    const base = `http://127.0.0.1:${server.port}`;
    const before = globalAccountPool.getInFlightCounts();

    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      const ctrl = new AbortController();
      const abortAt = 8 + (i * 37) % 90;
      setTimeout(() => ctrl.abort(), abortAt);
      tasks.push((async () => {
        try {
          const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'slow-stream/echo', messages: [{ role: 'user', content: 'hi' }], stream: true }),
            signal: ctrl.signal,
          });
          const reader = res.body?.getReader();
          while (reader) { const { done } = await reader.read(); if (done) break; }
        } catch { /* aborts expected */ }
      })());
    }
    await Promise.all(tasks);
    await sleep(600);
    const after = globalAccountPool.getInFlightCounts();
    console.log(`ADV-4 plugin.inFlight=${plugin.inFlight} peak=${plugin.peak} poolBefore=${JSON.stringify(before)} poolAfter=${JSON.stringify(after)}`);
    server.stop(true);
    expect(plugin.inFlight).toBe(0);
    expect(after).toEqual({});
  });

  it('allocator releases all 200 reservations under random aborts', async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `adv4_acc_${i}`, providerId: 'slow-stream', credentials: { apiKey: 'k' }, status: 'active',
    }));
    for (const a of candidates) globalAccountPool.addAccount(a as any);
    const acquired = candidates.map((c) => globalAccountPool.listAccounts().find((x) => x.id === c.id)!);
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5 + (i * 23) % 70);
      tasks.push((async () => {
        const lease = globalAccountPool.acquireAccount(acquired, { signal: ctrl.signal });
        if (!lease) return;
        try { await sleep(2 + (i % 9)); } finally { lease.release(); }
      })());
    }
    await Promise.all(tasks);
    const counts = globalAccountPool.getInFlightCounts();
    console.log(`ADV-4 allocator in-flight after 200 random aborts: ${JSON.stringify(counts)}`);
    expect(Object.values(counts).every((v) => v === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ADV-5: upstream 5xx storm                                           */
/* ------------------------------------------------------------------ */

describe('ADV-5 upstream 5xx storm', () => {
  it('breaker opens; measures whether router stops calling the provider', async () => {
    const pluginState = { hits: 0, fail: true };
    class FlakyPlugin implements ProviderPlugin {
      readonly id = 'flaky'; readonly displayName = 'Flaky'; readonly defaultBaseUrl = 'https://flaky.local/v1';
      async listModels(): Promise<ModelDescriptor[]> { return [{ id: 'flaky/m', name: 'F', providerId: 'flaky', ownedBy: 'x', created: 1 }]; }
      async execute(): Promise<CanonicalResponse> {
        pluginState.hits++;
        if (pluginState.fail) throw new GatewayError(503, 'api_error', 'upstream unavailable');
        return { id: 'x', model: 'flaky/m', created: 0, content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
      async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> { return (async function* () {})(); }
    }
    globalBreakerRegistry.configure('flaky', { failureThreshold: 5, backoffBaseMs: 60, backoffCeilingMs: 200, jitterRatio: 0 });
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-adv5-')) }, [new FlakyPlugin()]);
    const server = serve({ port: 0, fetch: app.fetch });
    const base = `http://127.0.0.1:${server.port}`;
    const body = JSON.stringify({ model: 'flaky/m', messages: [{ role: 'user', content: 'hi' }] });

    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = Date.now();
      await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      latencies.push(Date.now() - t);
    }
    const hitsAfterStorm = pluginState.hits;
    const breaker = globalBreakerRegistry.get('flaky');
    console.log(`ADV-5 after 20 requests: hits=${hitsAfterStorm} breaker=${breaker.state} failures=${breaker.failures} maxLatencyMs=${Math.max(...latencies)}`);
    expect(breaker.failures).toBeGreaterThanOrEqual(5);
    expect(breaker.state).toBe('open');
    expect(Math.max(...latencies)).toBeLessThan(500);

    const hitsBefore = pluginState.hits;
    for (let i = 0; i < 10; i++) await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    console.log(`ADV-5 with breaker open: provider calls before=${hitsBefore} after=${pluginState.hits}`);
    expect(pluginState.hits).toBe(hitsBefore); // documented acceptance: open breaker must stop provider calls

    await sleep(250);
    pluginState.fail = false;
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    console.log(`ADV-5 recovery: status=${res.status} breaker=${globalBreakerRegistry.get('flaky').state}`);
    expect(res.status).toBe(200);
    server.stop(true);
  });
});

/* ------------------------------------------------------------------ */
/* ADV-6: two parallel tool calls per dialect via official SDKs         */
/* ------------------------------------------------------------------ */

function toolPlugin(): ProviderPlugin {
  return {
    id: 'tool-mock', displayName: 'Tool Mock', defaultBaseUrl: 'https://tool.local/v1',
    async listModels(): Promise<ModelDescriptor[]> { return [{ id: 'tool-mock/parallel', name: 'P', providerId: 'tool-mock', ownedBy: 'x', created: 1 }]; },
    async execute(): Promise<CanonicalResponse> { throw new GatewayError(500, 'api_error', 'stream only'); },
    async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      return (async function* () {
        yield { type: 'stream_start', id: 'x', model: 'tool-mock/parallel', created: 0 } as CanonicalStreamEvent;
        yield { type: 'tool_call_start', index: 0, id: 'call_A', name: 'get_weather' } as CanonicalStreamEvent;
        yield { type: 'tool_call_start', index: 1, id: 'call_B', name: 'get_weather' } as CanonicalStreamEvent;
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city":"Pa' } as CanonicalStreamEvent;
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{"city":"Lo' } as CanonicalStreamEvent;
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: 'ris"}' } as CanonicalStreamEvent;
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: 'ndon"}' } as CanonicalStreamEvent;
        yield { type: 'tool_call_stop', index: 0 } as CanonicalStreamEvent;
        yield { type: 'tool_call_stop', index: 1 } as CanonicalStreamEvent;
        yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } } as CanonicalStreamEvent;
        yield { type: 'stream_end', stopReason: 'tool_calls' } as CanonicalStreamEvent;
      })();
    },
  };
}

describe('ADV-6 two parallel tool calls via official SDKs', () => {
  it('OpenAI SDK streams both calls with intact JSON arguments', async () => {
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-adv6o-')) }, [toolPlugin()]);
    const server = serve({ port: 0, fetch: app.fetch });
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'x' });
    const stream = await client.chat.completions.create({
      model: 'tool-mock/parallel', messages: [{ role: 'user', content: 'weather' }], stream: true,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    const byIndex = new Map<number, { id?: string; name?: string; args: string }>();
    for await (const chunk of stream as any) {
      for (const c of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
        const e = byIndex.get(c.index) ?? { args: '' };
        if (c.id) e.id = c.id;
        if (c.function?.name) e.name = c.function.name;
        if (c.function?.arguments !== undefined) e.args += c.function.arguments;
        byIndex.set(c.index, e);
      }
    }
    const calls = [...byIndex.entries()].map(([index, c]) => ({ index, ...c, parsed: (() => { try { return JSON.parse(c.args); } catch { return null; } })() }));
    console.log(`ADV-6 OpenAI SDK calls=${JSON.stringify(calls)}`);
    server.stop(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id).sort()).toEqual(['call_A', 'call_B']);
    expect(calls.find((c) => c.id === 'call_A')?.parsed).toEqual({ city: 'Paris' });
    expect(calls.find((c) => c.id === 'call_B')?.parsed).toEqual({ city: 'London' });
  }, 30_000);

  it('Anthropic SDK streams both tool_use blocks with intact JSON inputs', async () => {
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-adv6a-')) }, [toolPlugin()]);
    const server = serve({ port: 0, fetch: app.fetch });
    const sdkEntry = 'C:/Users/adity/AppData/Local/Temp/opencode/sdk-scratch/node_modules/@anthropic-ai/sdk/index.js';
    const { default: Anthropic } = await import(pathToFileURL(resolve(sdkEntry)).href);
    const client = new Anthropic({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: 'x' });
    const s = client.messages.stream({
      model: 'tool-mock/parallel', max_tokens: 200,
      messages: [{ role: 'user', content: 'weather' }],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    });
    const seen: string[] = [];
    s.on('event', (e: any) => { if (seen.length < 40) seen.push(e.type); });
    let final: any;
    try {
      final = await Promise.race([
        s.finalMessage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`SDK finalMessage timeout; events=${seen.join(',')}`)), 15000)),
      ]);
    } catch (e: any) {
      console.log(`ADV-6 Anthropic SDK failure: ${e.message}`);
      server.stop(true);
      throw e;
    }
    console.log(`ADV-6 Anthropic SDK events=${seen.join(',')}`);
    const blocks = final.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
    console.log(`ADV-6 Anthropic SDK stop=${final.stop_reason} tool_use=${JSON.stringify(blocks)}`);
    server.stop(true);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b: any) => b.id).sort()).toEqual(['call_A', 'call_B']);
    expect(blocks.find((b: any) => b.id === 'call_A')?.input).toEqual({ city: 'Paris' });
    expect(blocks.find((b: any) => b.id === 'call_B')?.input).toEqual({ city: 'London' });
  }, 30000);
});
