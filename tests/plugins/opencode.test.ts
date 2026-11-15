import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  OpenCodeProviderPlugin,
  loadZenGateTools,
  mintZenSessionId,
  isValidZenSessionId,
  generateTracingHeaders,
} from '../../src/plugins/opencode';
import { GatewayError } from '../../src/core/types/errors';
import type { CanonicalRequest } from '../../src/core/types/canonical';

describe('OpenCode Zen Authentic Production Plugin', () => {
  let plugin: OpenCodeProviderPlugin;

  beforeEach(() => {
    plugin = new OpenCodeProviderPlugin();
  });

  // ==========================================================================
  // Requirement 1: Real Base URL
  // ==========================================================================
  describe('Requirement 1: Real Base URL', () => {
    it('initializes with official Base URL: https://opencode.ai/inference/openai/v1', () => {
      expect(plugin.defaultBaseUrl).toBe('https://opencode.ai/inference/openai/v1');
      expect(plugin.defaultBaseUrl).not.toBe('https://opencode.ai/inference');
    });

    it('resolves chat completions endpoint to https://opencode.ai/inference/openai/v1/chat/completions', () => {
      const endpoint = plugin.getChatEndpointUrl();
      expect(endpoint).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
    });

    it('handles trailing slashes or custom mock base URLs correctly', () => {
      const custom1 = new OpenCodeProviderPlugin('http://127.0.0.1:4000/api/v1/');
      expect(custom1.getChatEndpointUrl()).toBe('http://127.0.0.1:4000/api/v1/chat/completions');

      const custom2 = new OpenCodeProviderPlugin('http://127.0.0.1:4000/chat/completions');
      expect(custom2.getChatEndpointUrl()).toBe('http://127.0.0.1:4000/chat/completions');
    });
  });

  // ==========================================================================
  // Requirement 2: Exact 12 Gate Tools Injection
  // ==========================================================================
  describe('Requirement 2: Exact 12 Gate Tools Injection', () => {
    it('loads exactly 12 gate tools from zen_gate_tools.json', () => {
      const tools = loadZenGateTools();
      expect(tools.length).toBe(12);

      const names = tools.map((t) => t.name).sort();
      const expected = [
        'edit',
        'execute',
        'glob',
        'grep',
        'question',
        'read',
        'shell',
        'skill',
        'subagent',
        'webfetch',
        'websearch',
        'write',
      ].sort();
      expect(names).toEqual(expected);
    });

    it('converts gate tools into OpenAI schemas with authentic parameters_chat', () => {
      const openAITools = plugin.getOpenAIGateTools();
      expect(openAITools.length).toBe(12);

      for (const t of openAITools) {
        expect(t.type).toBe('function');
        expect(typeof t.function.name).toBe('string');
        expect(typeof t.function.description).toBe('string');
        expect(t.function.description.length).toBeGreaterThan(0);
        expect(typeof t.function.parameters).toBe('object');
        expect(t.function.strict).toBe(false);

        // Crucial: parameters must NOT be empty {} schema (which causes 403 on real backend)
        const paramKeys = Object.keys(t.function.parameters);
        expect(paramKeys.length).toBeGreaterThan(0);
        expect((t.function.parameters as any).type).toBe('object');
      }

      // Verify specific official parameters for "edit"
      const editTool = openAITools.find((t) => t.function.name === 'edit');
      expect(editTool).toBeDefined();
      const editProps = (editTool!.function.parameters as any).properties;
      expect(editProps.path).toBeDefined();
      expect(editProps.oldString).toBeDefined();
      expect(editProps.newString).toBeDefined();
    });

    it('injects 12 gate tools with tool_choice "none" when client sends no tools', () => {
      const { tools, toolChoice } = plugin.mergeWithGateTools(undefined);
      expect(tools.length).toBe(12);
      expect(toolChoice).toBe('none');
    });

    it('merges client tools before gate tools and preserves client definitions', () => {
      const clientTools: any[] = [
        {
          type: 'function',
          function: {
            name: 'custom_calc',
            description: 'Custom calculator',
            parameters: { type: 'object', properties: { expr: { type: 'string' } } },
          },
        },
      ];

      const { tools, toolChoice } = plugin.mergeWithGateTools(clientTools, 'auto');
      expect(tools.length).toBe(13); // 1 client tool + 12 gate tools
      expect(tools[0].function.name).toBe('custom_calc');
      expect(toolChoice).toBe('auto');
    });

    it('overrides gate tool if client defines a tool with the same name', () => {
      const clientTools: any[] = [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Client custom read tool',
            parameters: { type: 'object', properties: { custom_path: { type: 'string' } } },
          },
        },
      ];

      const { tools } = plugin.mergeWithGateTools(clientTools);
      expect(tools.length).toBe(12); // read replaced, remaining 11 gate tools appended
      expect(tools[0].function.description).toBe('Client custom read tool');
    });
  });

  // ==========================================================================
  // Requirement 3: Lowercase Identity Headers & Tracing Formats
  // ==========================================================================
  describe('Requirement 3: Lowercase Identity Headers', () => {
    it('emits all lowercase identity headers matching CLI 2.2.7 signature', () => {
      const headers = plugin.buildHeaders();

      // Check lowercase key existence
      expect(headers['user-agent']).toBe('opencode-client/2.2.7');
      expect(headers['connection']).toBe('keep-alive');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['accept']).toBe('*/*');
      expect(headers['x-opencode-client']).toBe('cli');
      expect(headers['x-opencode-project']).toBe('global');
      expect(headers['x-opencode-session-id']).toBeDefined();
      expect(headers['x-opencode-parent-session-id']).toBeDefined();
      expect(headers['b3']).toBeDefined();
      expect(headers['traceparent']).toBeDefined();

      // Ensure no uppercase variants leaked into header keys
      const keys = Object.keys(headers);
      for (const k of keys) {
        expect(k).toBe(k.toLowerCase());
      }
    });

    it('generates valid 4-part b3 and traceparent headers', () => {
      const { b3, traceparent } = generateTracingHeaders();

      // b3 format: <32hex>-<16hex>-1-<16hex>
      const b3Parts = b3.split('-');
      expect(b3Parts.length).toBe(4);
      expect(b3Parts[0].length).toBe(32); // traceID
      expect(/^[0-9a-f]{32}$/.test(b3Parts[0])).toBeTrue();
      expect(b3Parts[1].length).toBe(16); // spanID
      expect(/^[0-9a-f]{16}$/.test(b3Parts[1])).toBeTrue();
      expect(b3Parts[2]).toBe('1');       // sampled
      expect(b3Parts[3].length).toBe(16); // parentSpanID
      expect(/^[0-9a-f]{16}$/.test(b3Parts[3])).toBeTrue();

      // traceparent format: 00-<32hex>-<16hex>-01
      const tpParts = traceparent.split('-');
      expect(tpParts.length).toBe(4);
      expect(tpParts[0]).toBe('00');
      expect(tpParts[1]).toBe(b3Parts[0]); // same traceId
      expect(tpParts[2]).toBe(b3Parts[1]); // same spanId
      expect(tpParts[3]).toBe('01');
    });
  });

  // ==========================================================================
  // Requirement 4: Anonymous Session Minting
  // ==========================================================================
  describe('Requirement 4: Anonymous Session Minting', () => {
    it('mints sessions conforming to official descending format ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$', () => {
      const sessionId = mintZenSessionId();
      expect(sessionId.length).toBe(30);
      expect(sessionId.startsWith('ses_')).toBeTrue();
      expect(isValidZenSessionId(sessionId)).toBeTrue();
    });

    it('mints both session-id and parent-session-id simultaneously', () => {
      const { sessionId, parentSessionId } = plugin.mintSession();
      expect(isValidZenSessionId(sessionId)).toBeTrue();
      expect(isValidZenSessionId(parentSessionId)).toBeTrue();
      expect(sessionId).not.toBe(parentSessionId);

      expect(plugin.currentSessionId).toBe(sessionId);
      expect(plugin.currentParentSessionId).toBe(parentSessionId);
    });

    it('produces descending lexicographical IDs for consecutive mints', async () => {
      const id1 = mintZenSessionId();
      await new Promise((r) => setTimeout(r, 2));
      const id2 = mintZenSessionId();

      // Descending bit-inverted timestamp means later timestamp yields smaller hex part
      const hex1 = id1.slice(4, 16);
      const hex2 = id2.slice(4, 16);
      expect(hex2 <= hex1).toBeTrue();
    });
  });

  // ==========================================================================
  // Requirement 5: Error Handling (403 FreeTierError & 429 Retry-After)
  // ==========================================================================
  describe('Requirement 5: Error Handling', () => {
    it('parses Retry-After integer seconds', () => {
      expect(plugin.parseRetryAfter('60')).toBe(60);
      expect(plugin.parseRetryAfter('120')).toBe(120);
      expect(plugin.parseRetryAfter('0')).toBe(20); // defaults 0 or negative to 20
      expect(plugin.parseRetryAfter('-5')).toBe(20);
      expect(plugin.parseRetryAfter(null)).toBe(20);
      expect(plugin.parseRetryAfter('')).toBe(20);
    });

    it('parses Retry-After HTTP date string', () => {
      const future = new Date(Date.now() + 45000).toUTCString();
      const parsed = plugin.parseRetryAfter(future);
      expect(parsed).toBeGreaterThanOrEqual(40);
      expect(parsed).toBeLessThanOrEqual(50);
    });

    it('resets session on 403 FreeTierError and increments reset counter', () => {
      const initialResetCount = plugin.sessionResetCount;
      const initialSessionId = plugin.currentSessionId;

      plugin.resetSession();

      expect(plugin.sessionResetCount).toBe(initialResetCount + 1);
      expect(plugin.currentSessionId).toBeDefined();
      expect(plugin.currentSessionId).not.toBe(initialSessionId);
      expect(isValidZenSessionId(plugin.currentSessionId!)).toBeTrue();
    });

    it('classifies 403 as retryable permission_denied error', () => {
      const classification = plugin.classifyError(new Error('Session rejected'), 403);
      expect(classification.category).toBe('permission_denied');
      expect(classification.isRetryable).toBe(true);
      expect(classification.cooldownDurationMs).toBe(5000);
    });

    it('classifies 429 as retryable rate_limit with cooldown', () => {
      const gwErr = new GatewayError(429, 'rate_limit', 'Rate limit hit', { retryAfter: 30 });
      const classification = plugin.classifyError(gwErr, 429);
      expect(classification.category).toBe('rate_limit');
      expect(classification.isRetryable).toBe(true);
      expect(classification.cooldownDurationMs).toBe(30000);
    });
  });

  // ==========================================================================
  // Live Mock Execution & Streaming
  // ==========================================================================
  describe('Live Request / Response Execution & Streaming', () => {
    let mockServer: any;
    let mockPort: number;

    afterEach(() => {
      if (mockServer) {
        mockServer.stop(true);
        mockServer = null;
      }
    });

    it('executes successful non-streaming chat completion with authentic headers and gate tools', async () => {
      let receivedHeaders: Record<string, string> = {};
      let receivedBody: any = null;

      mockServer = Bun.serve({
        port: 0,
        fetch: async (req) => {
          receivedHeaders = Object.fromEntries(req.headers.entries());
          receivedBody = await req.json();

          return new Response(
            JSON.stringify({
              id: 'chatcmpl-zen-12345',
              object: 'chat.completion',
              created: 1731693600,
              model: 'big-pickle',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'Authentic OpenCode Zen response',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 15,
                completion_tokens: 25,
                total_tokens: 40,
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          );
        },
      });

      mockPort = mockServer.port;
      const testPlugin = new OpenCodeProviderPlugin(`http://127.0.0.1:${mockPort}`);

      const req: CanonicalRequest = {
        id: 'req_lat_test_001',
        clientDialect: 'openai-chat',
        model: 'opencode/big-pickle',
        messages: [{ role: 'user', content: 'Hello Zen' }],
        stream: false,
      };

      const res = await testPlugin.execute(req);

      expect(res.id).toBe('chatcmpl-zen-12345');
      expect(res.content[0].type).toBe('text');
      expect((res.content[0] as any).text).toBe('Authentic OpenCode Zen response');
      expect(res.usage.totalTokens).toBe(40);

      // Verify received headers on upstream
      expect(receivedHeaders['user-agent']).toBe('opencode-client/2.2.7');
      expect(receivedHeaders['connection']).toBe('keep-alive');
      expect(receivedHeaders['x-opencode-session-id']).toBe(testPlugin.currentSessionId!);
      expect(receivedHeaders['x-opencode-parent-session-id']).toBe(testPlugin.currentParentSessionId!);
      expect(receivedHeaders['b3']).toBeDefined();
      expect(receivedHeaders['traceparent']).toBeDefined();

      // Verify 12 gate tools injected with tool_choice: "none"
      expect(receivedBody.tools).toBeDefined();
      expect(receivedBody.tools.length).toBe(12);
      expect(receivedBody.tool_choice).toBe('none');
    });

    it('automatically triggers session reset on upstream 403 FreeTierError', async () => {
      mockServer = Bun.serve({
        port: 0,
        fetch: async () => {
          return new Response(
            JSON.stringify({
              error: {
                message: 'FreeTierError: Session access expired or bot challenge required',
                type: 'FreeTierError',
                code: 403,
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          );
        },
      });

      mockPort = mockServer.port;
      const testPlugin = new OpenCodeProviderPlugin(`http://127.0.0.1:${mockPort}`);
      const oldSession = testPlugin.currentSessionId;

      const req: CanonicalRequest = {
        id: 'req_lat_test_002',
        clientDialect: 'openai-chat',
        model: 'opencode/big-pickle',
        messages: [{ role: 'user', content: 'Test 403' }],
        stream: false,
      };

      let caughtError: any;
      try {
        await testPlugin.execute(req);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(GatewayError);
      expect(caughtError.status).toBe(403);
      expect(caughtError.category).toBe('permission_denied');

      // Verify session reset occurred
      expect(testPlugin.sessionResetCount).toBeGreaterThan(1);
      expect(testPlugin.currentSessionId).not.toBe(oldSession);
      expect(isValidZenSessionId(testPlugin.currentSessionId!)).toBeTrue();
    });

    it('parses Retry-After header and surfaces it on 429 rate limit', async () => {
      mockServer = Bun.serve({
        port: 0,
        fetch: async () => {
          return new Response('Too Many Requests', {
            status: 429,
            headers: { 'retry-after': '45' },
          });
        },
      });

      mockPort = mockServer.port;
      const testPlugin = new OpenCodeProviderPlugin(`http://127.0.0.1:${mockPort}`);

      const req: CanonicalRequest = {
        id: 'req_lat_test_003',
        clientDialect: 'openai-chat',
        model: 'opencode/big-pickle',
        messages: [{ role: 'user', content: 'Test 429' }],
        stream: false,
      };

      let caughtError: any;
      try {
        await testPlugin.execute(req);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(GatewayError);
      expect(caughtError.status).toBe(429);
      expect(caughtError.retryAfter).toBe(45);
      expect(caughtError.retryAfterMs).toBe(45000);
    });

    it('streams SSE response chunks including thinking and tool call deltas', async () => {
      mockServer = Bun.serve({
        port: 0,
        fetch: async () => {
          const ssePayload = [
            'data: {"choices":[{"delta":{"reasoning_content":"Thinking deeply..."}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Hello world!"}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"test.txt\\"}"}}]}}]}\n\n',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n',
            'data: [DONE]\n\n',
          ].join('');

          return new Response(ssePayload, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });

      mockPort = mockServer.port;
      const testPlugin = new OpenCodeProviderPlugin(`http://127.0.0.1:${mockPort}`);

      const req: CanonicalRequest = {
        id: 'req_lat_test_004',
        clientDialect: 'openai-chat',
        model: 'opencode/big-pickle',
        messages: [{ role: 'user', content: 'Stream test' }],
        stream: true,
      };

      const stream = await testPlugin.executeStream(req);
      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.some((e) => e.type === 'stream_start')).toBeTrue();
      expect(events.some((e) => e.type === 'thinking_delta' && e.delta === 'Thinking deeply...')).toBeTrue();
      expect(events.some((e) => e.type === 'text_delta' && e.delta === 'Hello world!')).toBeTrue();
      expect(events.some((e) => e.type === 'tool_call_start' && e.name === 'read')).toBeTrue();
      expect(events.some((e) => e.type === 'usage' && e.usage.totalTokens === 30)).toBeTrue();
      expect(events.some((e) => e.type === 'stream_end')).toBeTrue();
    });
  });
});
