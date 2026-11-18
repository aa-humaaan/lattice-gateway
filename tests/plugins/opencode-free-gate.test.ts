import { describe, it, expect, afterEach } from 'bun:test';
import { OpenCodeProviderPlugin } from '../../src/plugins/opencode';
import type { CanonicalRequest } from '../../src/core/types/canonical';

const OK = JSON.stringify({
  id: 'chatcmpl-zen-ok', object: 'chat.completion', created: 1, model: 'big-pickle',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

describe('OpenCode Zen anonymous free-tier gate', () => {
  let server: any;
  let headers: Record<string, string> = {};
  let body: any;
  let sessions: string[] = [];

  afterEach(() => server?.stop());

  function start() {
    sessions = [];
    headers = {};
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        headers = Object.fromEntries(req.headers.entries());
        sessions.push((headers['x-opencode-session-id'] || '').toLowerCase());
        body = await req.json();
        return new Response(OK, { headers: { 'content-type': 'application/json' } });
      },
    });
    const plugin = new OpenCodeProviderPlugin(`http://127.0.0.1:${server.port}`);
    plugin.setAccount({
      id: 'acc_gate_anon', providerId: 'opencode', authType: 'anonymous', status: 'active',
      credentials: {}, createdAt: 1, updatedAt: 1, errorCount: 0,
    } as any);
    return plugin;
  }

  function req(content = 'hi'): CanonicalRequest {
    return {
      id: 'req_gate', clientDialect: 'openai-chat', model: 'opencode/big-pickle',
      messages: [{ role: 'user', content }], stream: false,
    };
  }

  it('uses the anonymous public bearer and CLI v2 gate headers', async () => {
    const plugin = start();
    await plugin.execute(req());

    expect(headers['authorization']).toBe('Bearer public');
    expect(headers['user-agent']).toBe('opencode/latest/2.2.7/cli');
    expect(headers['accept-encoding']).toBe('gzip, deflate, br, zstd');
    expect(headers['x-opencode-client']).toBe('cli');
    expect(headers['x-opencode-project']).toBe('global');
    expect(headers['x-opencode-parent-session-id']).toBeUndefined();
    const sess = headers['x-opencode-session-id'];
    expect(headers['x-opencode-session']).toBe(sess);
    expect(headers['x-session-affinity']).toBe(sess);
    expect(headers['x-session-id']).toBe(sess);
  });

  it('appends the env working-directory marker to a system message', async () => {
    const plugin = start();
    await plugin.execute({
      ...req(),
      messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }],
    });
    const system = body.messages.find((m: any) => m.role === 'system');
    expect(typeof system.content).toBe('string');
    expect(system.content).toContain('<env>');
    expect(system.content).toContain('Working directory:');
    expect(system.content).toContain('</env>');
  });

  it('adds a system marker message when the client sent none', async () => {
    const plugin = start();
    await plugin.execute(req());
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('<env>');
    expect(body.messages[0].content).toContain('Working directory:');
  });

  it('does not duplicate the marker when the client already has one', async () => {
    const plugin = start();
    await plugin.execute({
      ...req(),
      messages: [{ role: 'system', content: '<env>\n  Working directory: /x\n</env>' }, { role: 'user', content: 'hi' }],
    });
    const systems = body.messages.filter((m: any) => m.role === 'system');
    expect(systems.length).toBe(1);
  });

  it('mints a fresh session for each call', async () => {
    const plugin = start();
    await plugin.execute(req());
    await plugin.execute(req());
    expect(sessions.length).toBe(2);
    expect(sessions[1]).not.toBe(sessions[0]);
  });
});
