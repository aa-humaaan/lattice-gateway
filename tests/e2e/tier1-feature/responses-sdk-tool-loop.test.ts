import { describe, it, expect } from 'bun:test';
import OpenAI from 'openai';
import { createServer } from '../../../src/core/server';
import type { CanonicalRequest, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import type { ProviderPlugin } from '../../../src/core/types/plugin';

/**
 * Acceptance: a two-turn function-calling loop driven by the official OpenAI
 * SDK. Protocol names come from the docs fetched 2026-11-20:
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 */

const PROVIDER = 'sdk-tool-stub';
const CALL_ID = 'call_provider_sdk_123';

function makePlugin(): ProviderPlugin {
  return {
    id: PROVIDER,
    displayName: PROVIDER,
    defaultBaseUrl: 'http://localhost',
    async listModels() {
      return [{ id: `${PROVIDER}/model`, name: 'm', providerId: PROVIDER, created: 1, contextWindow: 100000, supportsStreaming: true }];
    },
    async execute(req: CanonicalRequest) {
      return {
        id: req.id, model: req.model, created: 1,
        content: [], stopReason: 'stop' as const,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      return (async function* () {
        yield { type: 'stream_start', id: 'resp_sdk_tool', model: req.model, created: 1 };
        if (hasToolResult) {
          yield { type: 'thinking_delta', delta: 'Tool result received. ' };
          yield { type: 'text_delta', delta: 'It is sunny in Paris.' };
        } else {
          yield { type: 'thinking_delta', delta: 'I should check the weather. ' };
          yield { type: 'text_delta', delta: 'Checking the weather. ' };
          yield { type: 'tool_call_start', index: 0, id: CALL_ID, name: 'get_weather' };
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city":"Paris"}' };
          yield { type: 'tool_call_stop', index: 0 };
        }
        yield { type: 'stream_end', stopReason: hasToolResult ? 'stop' : 'tool_calls' };
      })();
    },
  } as ProviderPlugin;
}

describe('P0-2: official OpenAI SDK two-turn tool loop', () => {
  it('completes a function call and its follow-up against the mock upstream', async () => {
    const server = Bun.serve({ port: 0, fetch: createServer({}, [makePlugin()]).fetch });
    try {
      const client = new OpenAI({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.port}/v1` });
      const tools = [{
        type: 'function' as const,
        name: 'get_weather',
        description: 'Look up weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        strict: false,
      }];

      const first = await client.responses.create({
        model: PROVIDER,
        input: 'What is the weather in Paris?',
        tools,
        stream: true,
      });
      let firstResponse: any;
      for await (const event of first) {
        if (event.type === 'response.completed') firstResponse = (event as any).response;
      }
      expect(firstResponse).toBeDefined();
      const call = firstResponse.output.find((item: any) => item.type === 'function_call');
      expect(call).toBeDefined();
      expect(call.call_id).toBe(CALL_ID);
      expect(JSON.parse(call.arguments)).toEqual({ city: 'Paris' });

      const second = await client.responses.create({
        model: PROVIDER,
        input: [
          call,
          { type: 'function_call_output', call_id: call.call_id, output: 'sunny, 22C' },
        ] as any,
        tools,
        stream: true,
      });
      let answer = '';
      for await (const event of second) {
        if (event.type === 'response.completed') {
          answer = (event as any).response.output
            .filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text')
            .map((part: any) => part.text)
            .join('');
        }
      }
      expect(answer).toContain('sunny in Paris');
    } finally {
      server.stop(true);
    }
  });
});
