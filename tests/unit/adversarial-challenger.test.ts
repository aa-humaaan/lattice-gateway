import { describe, it, expect } from 'bun:test';
import {
  createXMLToolInterceptor,
  applyXMLToolInterceptor,
  parseXMLToolCall,
  MAX_XML_BUFFER_BYTES,
} from '../../src/engine/dialect/xml-tool-interceptor';
import { CanonicalStreamEvent } from '../../src/core/types/canonical';
import {
  GatewayError,
  toOpenAIError,
  toAnthropicError,
  serializeDialectError,
} from '../../src/core/types/errors';
import { createServer } from '../../src/core/server';
import { MockProviderPlugin } from '../mocks/mock-provider';
import { ProviderPlugin } from '../../src/core/types/plugin';

async function collectEvents(
  events: AsyncIterable<CanonicalStreamEvent>
): Promise<CanonicalStreamEvent[]> {
  const result: CanonicalStreamEvent[] = [];
  for await (const ev of events) {
    result.push(ev);
  }
  return result;
}

// ============================================================================
// PART 1: XMLToolInterceptor Adversarial Stress-Tests
// ============================================================================

describe('Adversarial Stress: XMLToolInterceptor Edge Cases', () => {
  // --------------------------------------------------------------------------
  // Edge Case 1: Nested XML tags inside parameters
  // --------------------------------------------------------------------------
  describe('Nested XML tags inside parameters', () => {
    it('handles nested XML tags inside <parameter=command> (e.g. cat <file></command>)', async () => {
      const xmlChunk =
        '<tool_call>\n<function=bash>\n<parameter=command>cat <file></command></parameter>\n</tool_call>';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: xmlChunk };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      expect(textDeltas.length).toBe(0); // Zero XML leak

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('bash');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBe(1);
      const parsedArgs = JSON.parse((toolDeltas[0] as any).argumentsDelta);
      expect(parsedArgs.command).toBe('cat <file></command>');
    });

    it('handles nested XML tags inside <invoke> format (e.g. parameter name="command")', async () => {
      const xmlChunk =
        '<invoke name="bash">\n<parameter name="command">cat <file>data.txt</file></parameter>\n</invoke>';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: xmlChunk };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('bash');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBe(1);
      const parsedArgs = JSON.parse((toolDeltas[0] as any).argumentsDelta);
      expect(parsedArgs.command).toBe('cat <file>data.txt</file>');
    });

    it('handles multiple parameters where some have XML and code with angle brackets', async () => {
      const xmlChunk =
        '<tool_call>\n<function=edit_file>\n<parameter=path>/tmp/test.html</parameter>\n<parameter=content><div class="wrapper"><span>Hello & World</span></div></parameter>\n</tool_call>';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: xmlChunk };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('edit_file');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      const parsedArgs = JSON.parse((toolDeltas[0] as any).argumentsDelta);
      expect(parsedArgs.path).toBe('/tmp/test.html');
      expect(parsedArgs.content).toBe('<div class="wrapper"><span>Hello & World</span></div>');
    });
  });

  // --------------------------------------------------------------------------
  // Edge Case 2: Unclosed tags and buffer overflow safety at 4096 bytes
  // --------------------------------------------------------------------------
  describe('Unclosed tags and buffer overflow safety', () => {
    it('salvages unclosed <tool_call> at stream end if valid parameters exist', async () => {
      // Missing closing </tool_call>
      const unclosedXml =
        '<tool_call>\n<function=run>\n<parameter=cmd>ls -la</parameter>\n';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: unclosedXml };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('run');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      const parsedArgs = JSON.parse((toolDeltas[0] as any).argumentsDelta);
      expect(parsedArgs.cmd).toBe('ls -la');

      const endEv = intercepted.find((e) => e.type === 'stream_end') as any;
      expect(endEv.stopReason).toBe('tool_calls');
    });

    it('flushes buffer as plain text when buffer exceeds MAX_XML_BUFFER_BYTES (4096 bytes) without closing tag', async () => {
      const padding = 'A'.repeat(MAX_XML_BUFFER_BYTES + 500);
      const rogueStream = `<tool_call_unclosed>${padding}`;

      async function* generate() {
        yield { type: 'text_delta' as const, delta: rogueStream };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      // Must not throw or crash; buffer should be flushed as text
      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      expect(textDeltas.length).toBeGreaterThan(0);
      const combinedText = textDeltas.map((e: any) => e.delta).join('');
      expect(combinedText).toBe(rogueStream);

      // No tool calls emitted
      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(0);

      const endEv = intercepted.find((e) => e.type === 'stream_end') as any;
      expect(endEv.stopReason).toBe('stop');
    });

    it('flushes unclosed unparseable tag safely on stream_end', async () => {
      const unclosedGarbage = '<tool_call>not-valid-json-or-xml';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: unclosedGarbage };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      const combinedText = textDeltas.map((e: any) => e.delta).join('');
      expect(combinedText).toBe(unclosedGarbage);

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Edge Case 3: Interleaved conversational text before, between, and after tool calls
  // --------------------------------------------------------------------------
  describe('Interleaved conversational text', () => {
    it('correctly handles text before, between, and after multiple tool calls with non-tool XML', async () => {
      async function* generate() {
        yield { type: 'text_delta' as const, delta: 'Let us check if x < 10 and y > 20.\nFirst step:\n' };
        yield {
          type: 'text_delta' as const,
          delta: '<tool_call>\n<function=check_val>\n<parameter=x>5</parameter>\n</tool_call>',
        };
        yield {
          type: 'text_delta' as const,
          delta: '\nResult noted. Now running second step with <div>tag</div>:\n',
        };
        yield {
          type: 'text_delta' as const,
          delta: '<tool_call>\n<function=calc>\n<parameter=y>25</parameter>\n</tool_call>',
        };
        yield { type: 'text_delta' as const, delta: '\nAll operations complete!' };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      // Verify all conversational text is preserved
      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      const combinedText = textDeltas.map((e: any) => e.delta).join('');

      expect(combinedText).toContain('Let us check if x < 10 and y > 20.\nFirst step:\n');
      expect(combinedText).toContain('\nResult noted. Now running second step with <div>tag</div>:\n');
      expect(combinedText).toContain('\nAll operations complete!');
      expect(combinedText).not.toContain('<tool_call>');

      // Verify 2 tool calls emitted with sequential indices
      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start') as any[];
      expect(toolStarts.length).toBe(2);
      expect(toolStarts[0].index).toBe(0);
      expect(toolStarts[0].name).toBe('check_val');
      expect(toolStarts[1].index).toBe(1);
      expect(toolStarts[1].name).toBe('calc');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta') as any[];
      expect(toolDeltas.length).toBe(2);
      expect(JSON.parse(toolDeltas[0].argumentsDelta)).toEqual({ x: 5 });
      expect(JSON.parse(toolDeltas[1].argumentsDelta)).toEqual({ y: 25 });

      const endEv = intercepted.find((e) => e.type === 'stream_end') as any;
      expect(endEv.stopReason).toBe('tool_calls');
    });
  });

  // --------------------------------------------------------------------------
  // Edge Case 4: Tag split across tiny 1-byte and 2-byte token chunks
  // --------------------------------------------------------------------------
  describe('Extreme chunk fragmentation (1-byte and 2-byte splits)', () => {
    it('intercepts tool call split completely into 1-byte chunks with zero text leakage', async () => {
      const fullText =
        'Leading text: <tool_call><function=micro><parameter=val>123</parameter></tool_call> trailing text.';

      async function* generate() {
        for (let i = 0; i < fullText.length; i++) {
          yield { type: 'text_delta' as const, delta: fullText[i] };
        }
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      const combinedText = textDeltas.map((e: any) => e.delta).join('');
      expect(combinedText).toBe('Leading text:  trailing text.');

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('micro');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBe(1);
      expect(JSON.parse((toolDeltas[0] as any).argumentsDelta)).toEqual({ val: 123 });

      const endEv = intercepted.find((e) => e.type === 'stream_end') as any;
      expect(endEv.stopReason).toBe('tool_calls');
    });

    it('correctly handles false tag prefix split into 1-byte chunks without dropping characters', async () => {
      // "<toolkit>rocks" split 1 byte at a time
      const falseAlarm = '<toolkit>rocks';

      async function* generate() {
        for (let i = 0; i < falseAlarm.length; i++) {
          yield { type: 'text_delta' as const, delta: falseAlarm[i] };
        }
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      const combinedText = textDeltas.map((e: any) => e.delta).join('');
      expect(combinedText).toBe(falseAlarm);

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(0);
    });

    it('intercepts tool call split into 2-byte chunks', async () => {
      const fullText =
        'Prefix: <invoke name="test"><parameters>{"k":"v"}</parameters></invoke> Postfix.';

      async function* generate() {
        for (let i = 0; i < fullText.length; i += 2) {
          yield { type: 'text_delta' as const, delta: fullText.slice(i, i + 2) };
        }
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const textDeltas = intercepted.filter((e) => e.type === 'text_delta');
      const combinedText = textDeltas.map((e: any) => e.delta).join('');
      expect(combinedText).toBe('Prefix:  Postfix.');

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('test');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBe(1);
      expect(JSON.parse((toolDeltas[0] as any).argumentsDelta)).toEqual({ k: 'v' });
    });
  });
});

// ============================================================================
// PART 2: Error Normalization & Dialect Conformity Boundary Conditions
// ============================================================================

describe('Adversarial Stress: Error Normalization & Dialect Conformity', () => {
  const app = createServer();

  // --------------------------------------------------------------------------
  // HTTP 400: Malformed JSON & Invalid Schemas
  // --------------------------------------------------------------------------
  describe('HTTP 400 Bad Request', () => {
    it('OpenAI endpoint returns 400 with OpenAI wire shape on malformed JSON body', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ "model": "mock-chat", "messages": [ unclosed json',
      });

      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json).toHaveProperty('error');
      expect(json.error).toHaveProperty('message');
      expect(json.error.type).toBe('invalid_request_error');
      expect(json.error.code).toBe('invalid_request_error');
      expect(json.error.param).toBeNull();
    });

    it('Anthropic endpoint returns 400 with Anthropic wire shape on malformed JSON body', async () => {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ "model": "mock-chat", "messages": [ unclosed json',
      });

      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json).toHaveProperty('type', 'error');
      expect(json).toHaveProperty('error');
      expect(json.error.type).toBe('invalid_request_error');
      expect(json.error).toHaveProperty('message');
      expect(json.error).not.toHaveProperty('code'); // Anthropic spec does not use root code
    });

    it('OpenAI endpoint returns 400 on invalid schema (missing messages array)', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mock-chat' }),
      });

      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.type).toBe('invalid_request_error');
      expect(json.error.message).toContain('messages');
    });

    it('Anthropic endpoint returns 400 on invalid schema (negative max_tokens)', async () => {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-chat',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: -10,
        }),
      });

      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.type).toBe('error');
      expect(json.error.type).toBe('invalid_request_error');
      expect(json.error.message).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // HTTP 401: Unauthorized / Invalid Key
  // --------------------------------------------------------------------------
  describe('HTTP 401 Unauthorized', () => {
    it('OpenAI dialect maps 401 authentication error correctly', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-401',
          messages: [{ role: 'user', content: 'test 401' }],
        }),
      });

      expect(res.status).toBe(401);
      const json: any = await res.json();
      expect(json).toHaveProperty('error');
      expect(json.error.type).toBe('authentication_error');
      expect(json.error.code).toBe('authentication_error');
      expect(json.error.message).toContain('401');
    });

    it('Anthropic dialect maps 401 authentication error correctly', async () => {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-401',
          messages: [{ role: 'user', content: 'test 401' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(401);
      const json: any = await res.json();
      expect(json).toHaveProperty('type', 'error');
      expect(json.error.type).toBe('authentication_error');
      expect(json.error.message).toContain('401');
    });
  });

  // --------------------------------------------------------------------------
  // HTTP 404: Unknown Model ID & Route Not Found
  // --------------------------------------------------------------------------
  describe('HTTP 404 Not Found', () => {
    it('returns 404 in OpenAI dialect on unknown route under /v1/chat', async () => {
      const res = await app.request('/v1/chat/non-existent-subpath', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const json: any = await res.json();
      expect(json).toHaveProperty('error');
      expect(json.error.type).toBe('not_found_error');
      expect(json.error.code).toBe('not_found_error');
      expect(json.error.message).toContain('not found');
    });

    it('returns 404 in Anthropic dialect on unknown route under /v1/messages', async () => {
      const res = await app.request('/v1/messages/non-existent-subpath', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      const json: any = await res.json();
      expect(json).toHaveProperty('type', 'error');
      expect(json.error.type).toBe('not_found_error');
      expect(json.error.message).toContain('not found');
    });

    it('returns 404 when router finds no active provider for model in multi-plugin setup', async () => {
      // Build server with mock provider that only accepts specific provider prefixes
      const strictMock: ProviderPlugin = {
        id: 'strict',
        displayName: 'Strict Plugin',
        defaultBaseUrl: 'https://strict.local',
        listModels: async () => [{ id: 'strict/model-1', name: 'M1', created: 12345 }],
        execute: async () => {
          throw new GatewayError(404, 'model_not_found', 'Model not found on strict plugin');
        },
        executeStream: async () => {
          throw new GatewayError(404, 'model_not_found', 'Model not found on strict plugin');
        },
      };

      const strictApp = createServer({}, [strictMock]);

      const res = await strictApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'unknown-vendor/unknown-model',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      expect(res.status).toBe(404);
      const json: any = await res.json();
      expect(json.error.type).toBe('not_found_error');
      expect(json.error.code).toBe('model_not_found');
    });
  });

  // --------------------------------------------------------------------------
  // HTTP 429: Rate Limit with Retry-After Header
  // --------------------------------------------------------------------------
  describe('HTTP 429 Rate Limit with Retry-After', () => {
    it('returns 429 in OpenAI dialect with retry-after header in non-streaming mode', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-429',
          messages: [{ role: 'user', content: 'test 429' }],
        }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('20');
      const json: any = await res.json();
      expect(json).toHaveProperty('error');
      expect(json.error.type).toBe('rate_limit_error');
      expect(json.error.code).toBe('rate_limit_error');
      expect(json.error.message).toContain('429');
    });

    it('returns 429 in Anthropic dialect with retry-after header in non-streaming mode', async () => {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-429',
          messages: [{ role: 'user', content: 'test 429' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('20');
      const json: any = await res.json();
      expect(json).toHaveProperty('type', 'error');
      expect(json.error.type).toBe('rate_limit_error');
      expect(json.error.message).toContain('429');
    });

    it('returns 429 with retry-after header in streaming mode pre-stream error', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-429',
          messages: [{ role: 'user', content: 'test 429 stream' }],
          stream: true,
        }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('20');
      const json: any = await res.json();
      expect(json.error.type).toBe('rate_limit_error');
    });
  });

  // --------------------------------------------------------------------------
  // HTTP 500 / 502 / 503: Upstream Errors & Bad Gateway
  // --------------------------------------------------------------------------
  describe('HTTP 500 / 502 / 503 Server Errors & Gateway Errors', () => {
    it('OpenAI dialect maps 500 upstream server error to api_error', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-500',
          messages: [{ role: 'user', content: 'test 500' }],
        }),
      });

      expect(res.status).toBe(500);
      const json: any = await res.json();
      expect(json).toHaveProperty('error');
      expect(json.error.type).toBe('api_error');
      expect(json.error.code).toBe('api_error');
      expect(json.error.message).toContain('500');
    });

    it('Anthropic dialect maps 500 upstream server error to api_error', async () => {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-error-500',
          messages: [{ role: 'user', content: 'test 500' }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(500);
      const json: any = await res.json();
      expect(json).toHaveProperty('type', 'error');
      expect(json.error.type).toBe('api_error');
      expect(json.error.message).toContain('500');
    });

    it('maps 502 Bad Gateway to api_error in both OpenAI and Anthropic dialects', () => {
      const err502 = new GatewayError(502, 'bad_gateway', 'Upstream proxy unreachable');

      const openAI = toOpenAIError(err502);
      expect(openAI.status).toBe(502);
      expect(openAI.payload.error.type).toBe('api_error');
      expect(openAI.payload.error.code).toBe('bad_gateway');

      const anthropic = toAnthropicError(err502);
      expect(anthropic.status).toBe(502);
      expect(anthropic.payload.type).toBe('error');
      expect(anthropic.payload.error.type).toBe('api_error');
      expect(anthropic.payload.error.message).toBe('Upstream proxy unreachable');
    });

    it('maps 503 Service Unavailable to overloaded_error in Anthropic dialect per spec', () => {
      const err503 = new GatewayError(503, 'service_unavailable', 'Upstream service overloaded');

      const anthropic = toAnthropicError(err503);
      expect(anthropic.status).toBe(503);
      expect(anthropic.payload.error.type).toBe('overloaded_error');

      const openAI = toOpenAIError(err503);
      expect(openAI.status).toBe(503);
      expect(openAI.payload.error.type).toBe('api_error');
    });
  });

  // --------------------------------------------------------------------------
  // Responses API (POST /v1/responses) Dialect Error Conformity
  // --------------------------------------------------------------------------
  describe('OpenAI Responses API Error Normalization', () => {
    it('returns 400 with Responses API failed envelope on malformed JSON body', async () => {
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json',
      });

      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.object).toBe('response');
      expect(json.status).toBe('failed');
      expect(json.id).toStartWith('resp_err_');
      expect(json.error.code).toBe('invalid_request_error');
      expect(json.error.message).toContain('Invalid JSON payload');
    });

    it('returns 400 with Responses API failed envelope on invalid schema', async () => {
      const res = await app.request('/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mock-chat', input: 12345 }), // input should be string or array
      });

      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.object).toBe('response');
      expect(json.status).toBe('failed');
      expect(json.error.code).toBe('invalid_request_error');
    });
  });

  // --------------------------------------------------------------------------
  // Unicode, Emojis, and Surrogate Pair splits in XML Tool Interception
  // --------------------------------------------------------------------------
  describe('Unicode & Surrogate Pair Resilience in XML Interceptor', () => {
    it('correctly parses CJK characters and emojis inside tool parameters', async () => {
      const xmlChunk =
        '<tool_call>\n<function=translate>\n<parameter=text>你好世界 🚀🔥</parameter>\n</tool_call>';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: xmlChunk };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start');
      expect(toolStarts.length).toBe(1);
      expect((toolStarts[0] as any).name).toBe('translate');

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      const parsedArgs = JSON.parse((toolDeltas[0] as any).argumentsDelta);
      expect(parsedArgs.text).toBe('你好世界 🚀🔥');
    });

    it('reassembles surrogate pairs split across two consecutive stream chunks', async () => {
      // 🚀 is \uD83D\uDE80
      const chunk1 = '<tool_call><function=send><parameter=emoji>test-\uD83D';
      const chunk2 = '\uDE80-success</parameter></tool_call>';

      async function* generate() {
        yield { type: 'text_delta' as const, delta: chunk1 };
        yield { type: 'text_delta' as const, delta: chunk2 };
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBe(1);
      const parsedArgs = JSON.parse((toolDeltas[0] as any).argumentsDelta);
      expect(parsedArgs.emoji).toBe('test-🚀-success');
    });

    it('correctly processes two back-to-back tool calls split 1-byte at a time', async () => {
      const rawStream =
        '<tool_call><function=first><parameter=n>1</parameter></tool_call><tool_call><function=second><parameter=n>2</parameter></tool_call>';

      async function* generate() {
        for (let i = 0; i < rawStream.length; i++) {
          yield { type: 'text_delta' as const, delta: rawStream[i] };
        }
        yield { type: 'stream_end' as const, stopReason: 'stop' as const };
      }

      const intercepted = await collectEvents(applyXMLToolInterceptor(generate()));

      const toolStarts = intercepted.filter((e) => e.type === 'tool_call_start') as any[];
      expect(toolStarts.length).toBe(2);
      expect(toolStarts[0].name).toBe('first');
      expect(toolStarts[0].index).toBe(0);
      expect(toolStarts[1].name).toBe('second');
      expect(toolStarts[1].index).toBe(1);

      const toolDeltas = intercepted.filter((e) => e.type === 'tool_call_delta') as any[];
      expect(toolDeltas.length).toBe(2);
      expect(JSON.parse(toolDeltas[0].argumentsDelta)).toEqual({ n: 1 });
      expect(JSON.parse(toolDeltas[1].argumentsDelta)).toEqual({ n: 2 });
    });
  });
});
