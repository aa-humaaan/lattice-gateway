import { describe, it, expect } from 'bun:test';
import {
  serializeOpenAIChat,
  serializeAnthropicMessage,
  serializeOpenAIResponse,
} from '../../src/engine/dialect/serializer';
import {
  createOpenAISSEStream,
  createAnthropicSSEStream,
  createResponsesSSEStream,
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

describe('F-03 / P0-3: upstream stream failures surface as dialect errors and terminate', () => {
  const upstreamFailure = {
    message: 'Upstream connection reset',
    type: 'upstream_error',
    code: 'upstream_reset',
    status: 502,
  };

  async function drain(stream: ReadableStream<Uint8Array>): Promise<{ text: string; terminated: boolean }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let terminated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        terminated = true;
        break;
      }
      if (value) text += decoder.decode(value, { stream: true });
    }
    return { text, terminated };
  }

  it('Chat stream with an upstream failure emits a dialect error payload and [DONE], then terminates', async () => {
    async function* gen(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'chat_fail', model: 'some-model', created: 1731693600 };
      yield { type: 'text_delta', delta: 'partial ' };
      yield { type: 'stream_error', error: upstreamFailure };
    }
    const { text, terminated } = await drain(createOpenAISSEStream(gen()));
    expect(text).toContain('"error"');
    expect(text).toContain('Upstream connection reset');
    expect(text).toContain('data: [DONE]\n\n');
    expect(terminated).toBe(true);
  });

  it('Anthropic stream with an upstream failure emits a dialect error event, then terminates', async () => {
    async function* gen(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'msg_fail', model: 'some-model', created: 1731693600 };
      yield { type: 'text_delta', delta: 'partial ' };
      yield { type: 'stream_error', error: upstreamFailure };
    }
    const { text, terminated } = await drain(createAnthropicSSEStream(gen()));
    expect(text).toContain('event: error');
    expect(text).toContain('Upstream connection reset');
    expect(terminated).toBe(true);
  });

  it('Responses stream with an upstream failure emits a failed response payload, then terminates', async () => {
    async function* gen(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: 'stream_start', id: 'resp_fail', model: 'some-model', created: 1731693600 };
      yield { type: 'text_delta', delta: 'partial ' };
      yield { type: 'stream_error', error: upstreamFailure };
    }
    const { text, terminated } = await drain(createResponsesSSEStream(gen()));
    expect(text).toContain('"status":"failed"');
    expect(text).toContain('"error"');
    expect(text).toContain('Upstream connection reset');
    expect(terminated).toBe(true);
  });
});
