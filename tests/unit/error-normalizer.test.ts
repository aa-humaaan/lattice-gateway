import { describe, it, expect } from 'bun:test';
import {
  GatewayError,
  toOpenAIError,
  toAnthropicError,
  serializeDialectError,
} from '../../src/core/types/errors';

describe('Error Normalizer & Dialect Serialization', () => {
  it('E1: Map 400 Bad Request to OpenAI format', () => {
    const err = new GatewayError(400, 'bad_request', 'Invalid model requested');
    const { status, payload } = toOpenAIError(err);

    expect(status).toBe(400);
    expect(payload.error.message).toBe('Invalid model requested');
    expect(payload.error.type).toBe('invalid_request_error');
    expect(payload.error.code).toBe('bad_request');
  });

  it('E2: Map 400 Bad Request to Anthropic format', () => {
    const err = new GatewayError(400, 'bad_request', 'Invalid model requested');
    const { status, payload } = toAnthropicError(err);

    expect(status).toBe(400);
    expect(payload.type).toBe('error');
    expect(payload.error.type).toBe('invalid_request_error');
    expect(payload.error.message).toBe('Invalid model requested');
  });

  it('E3: Map 429 Rate Limit with Retry-After', () => {
    const err = new GatewayError(429, 'rate_limit_exceeded', 'Rate limit hit', {
      retryAfter: 20,
    });
    expect(err.status).toBe(429);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe(20);

    const openAIErr = toOpenAIError(err);
    expect(openAIErr.status).toBe(429);
    expect(openAIErr.payload.error.type).toBe('rate_limit_error');

    const anthropicErr = toAnthropicError(err);
    expect(anthropicErr.status).toBe(429);
    expect(anthropicErr.payload.error.type).toBe('rate_limit_error');
  });

  it('E4: Map 500 Internal Error', () => {
    const err = new GatewayError(500, 'api_error', 'Upstream failure');
    const openAIErr = toOpenAIError(err);
    expect(openAIErr.status).toBe(500);
    expect(openAIErr.payload.error.type).toBe('api_error');

    const anthropicErr = toAnthropicError(err);
    expect(anthropicErr.status).toBe(500);
    expect(anthropicErr.payload.error.type).toBe('api_error');
  });

  it('Handles non-GatewayError exceptions safely', () => {
    const genericErr = new Error('Database disconnected');
    const openAI = serializeDialectError(genericErr, 'openai') as any;
    expect(openAI.error.message).toBe('Database disconnected');
    expect(openAI.error.type).toBe('api_error');

    const anthropic = serializeDialectError(genericErr, 'anthropic') as any;
    expect(anthropic.type).toBe('error');
    expect(anthropic.error.message).toBe('Database disconnected');
  });
});
