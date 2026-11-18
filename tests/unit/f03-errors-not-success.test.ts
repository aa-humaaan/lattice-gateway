import { describe, it, expect } from 'bun:test';
import {
  serializeOpenAIChat,
  serializeAnthropicMessage,
  serializeOpenAIResponse,
} from '../../src/engine/dialect/serializer';
import {
  createOpenAISSEStream,
  createAnthropicSSEStream,
} from '../../src/engine/dialect/stream-adapter';
import { CanonicalResponse, CanonicalStreamEvent } from '../../src/core/types/canonical';

const errorResponse: CanonicalResponse = {
  id: 'resp_error_1',
  model: 'some-model',
  created: 1731693600,
  content: [{ type: 'text', text: 'partial output before failure' }],
  stopReason: 'error',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) result += decoder.decode(value, { stream: true });
  }
  return result;
}

describe('F-03 / P0-3: canonical error stop reason must not look like success', () => {
  it('OpenAI Chat serializer never maps an error stop reason to a success finish_reason', () => {
    const out = serializeOpenAIChat(errorResponse);
    expect(out.choices[0].finish_reason).toBe('error');
  });

  it('Anthropic serializer never maps an error stop reason to a success stop_reason', () => {
    const out = serializeAnthropicMessage(errorResponse);
    expect(out.stop_reason).toBe('error');
  });

  it('Responses serializer marks error as failed and includes an explicit error object', () => {
    const out = serializeOpenAIResponse(errorResponse);
    expect(out.status).toBe('failed');
    expect(out.error).toBeTruthy();
    expect(out.error!.message).toBeTruthy();
  });

  it('OpenAI SSE stream ends an error stop reason with a non-success finish_reason and [DONE]', async () => {
    async function* gen(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'chunk_err', model: 'some-model', created: 1731693600 };
      yield { type: 'text_delta', delta: 'partial ' };
      yield { type: 'stream_end', stopReason: 'error' };
    }
    const text = await streamToText(createOpenAISSEStream(gen()));
    expect(text).toContain('"finish_reason":"error"');
    expect(text).toContain('data: [DONE]\n\n');
  });

  it('Anthropic SSE stream ends an error stop reason with a non-success stop_reason', async () => {
    async function* gen(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'msg_err', model: 'some-model', created: 1731693600 };
      yield { type: 'text_delta', delta: 'partial ' };
      yield { type: 'stream_end', stopReason: 'error' };
    }
    const text = await streamToText(createAnthropicSSEStream(gen()));
    expect(text).toContain('"stop_reason":"error"');
  });
});
