/**
 * Tier 1 Feature Coverage: F3 - OpenAI Responses Dialect
 * 
 * Verifies standard OpenAI /v1/responses endpoint behavior:
 * - Standard /v1/responses request with string or structured input items
 * - Multi-turn conversation handling via input/output items
 * - Tool execution mapping within responses schema (function_call items)
 * - Handling temperature, max_output_tokens, instructions, and modalities
 * - Input validation and dialect-compliant 400 Bad Request error handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient } from '../../harness/test-client';
import { assertDialectError } from '../../harness/assertions';

describe('F3: OpenAI /v1/responses Dialect', () => {
  let gateway: GatewayInstance;
  let client: TestClient;

  beforeAll(async () => {
    gateway = await startGateway({ mode: 'in-process' });
    client = new TestClient(gateway.baseUrl);
  });

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  // 1. Standard /v1/responses request with input items
  it('handles standard /v1/responses request with string input and returns completed response', async () => {
    const res = await client.openaiResponses({
      model: 'mock-chat',
      input: 'Explain the purpose of Project Lattice',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('mock-chat');
    expect(body.id).toBeString();
    expect(body.created_at).toBeNumber();

    // Verify output array has assistant message
    expect(Array.isArray(body.output)).toBeTrue();
    expect(body.output.length).toBeGreaterThan(0);

    const msgItem = body.output.find((item: any) => item.type === 'message');
    expect(msgItem).toBeDefined();
    expect(msgItem.role).toBe('assistant');
    expect(msgItem.status).toBe('completed');
    expect(Array.isArray(msgItem.content)).toBeTrue();
    expect(msgItem.content[0].type).toBe('text');
    expect(msgItem.content[0].text).toContain('Explain the purpose of Project Lattice');

    // Verify usage metrics
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  // 2. Multi-turn conversation handling via input items
  it('processes multi-turn message items input and returns next turn in output', async () => {
    const res = await client.openaiResponses({
      model: 'mock-chat',
      input: [
        { type: 'message', role: 'user', content: 'Who created Bun?' },
        { type: 'message', role: 'assistant', content: 'Jarred Sumner created Bun.' },
        { type: 'message', role: 'user', content: 'What is its runtime?' },
      ],
      instructions: 'Answer concisely.',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.status).toBe('completed');
    const msgItem = body.output.find((item: any) => item.type === 'message');
    expect(msgItem).toBeDefined();
    expect(msgItem.content[0].text).toContain('What is its runtime?');
  });

  // 3. Tool execution mapping within responses schema
  it('maps tool execution request into structured function_call output item', async () => {
    const res = await client.openaiResponses({
      model: 'mock-tools',
      input: 'Execute command to check disk space',
      tools: [
        {
          type: 'function',
          name: 'execute_command',
          description: 'Run shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.status).toBe('completed');
    expect(Array.isArray(body.output)).toBeTrue();

    // Verify function_call output item
    const funcCallItem = body.output.find((item: any) => item.type === 'function_call');
    expect(funcCallItem).toBeDefined();
    expect(funcCallItem.name).toBe('execute_command');
    expect(funcCallItem.call_id).toBeDefined();
    expect(funcCallItem.status).toBe('completed');

    const parsedArgs = JSON.parse(funcCallItem.arguments);
    expect(parsedArgs.command).toBe('git status');
  });

  // 4. Function call output roundtrip in responses input
  it('accepts function_call_output item in multi-turn input stream', async () => {
    const res = await client.openaiResponses({
      model: 'mock-chat',
      input: [
        { type: 'message', role: 'user', content: 'Check system status' },
        {
          type: 'function_call_output',
          call_id: 'call_12345',
          output: 'Disk OK: 45GB free',
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('completed');
  });

  // 5. Handling temperature, max_output_tokens, and modality settings
  it('accepts temperature, max_output_tokens, and modality settings without error', async () => {
    const res = await client.openaiResponses({
      model: 'mock-chat',
      input: 'Generate greeting with custom hyperparameters',
      temperature: 0.2,
      max_output_tokens: 64,
      modalities: ['text'],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('completed');
    expect(body.usage).toBeDefined();
  });

  // 6. Input validation and error handling for /v1/responses
  it('rejects malformed body with HTTP 400 Bad Request error envelope', async () => {
    const res = await client.openaiResponses({
      // Missing required model parameter
      input: 'Invalid request missing model',
    });

    expect(res.status).toBe(400);
    const errBody = (await res.json()) as any;
    assertDialectError(errBody, 'openai', 400);
    expect(errBody.error.message).toBeDefined();
  });

  // 7. Streaming /v1/responses endpoint returns proper SSE event sequence
  it('streams /v1/responses with SSE events: response.created → output_stream.delta → response.completed', async () => {
    const res = await client.openaiResponses({
      model: 'mock-chat',
      input: 'Say hello',
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    if (!res.body) throw new Error('No response body');
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const text = chunks.join('');

    expect(text).toContain('event: response.created');
    expect(text).toContain('"status":"in_progress"');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('"status":"completed"');
    expect(text).toContain('Lattice Gateway Mock Stream');
  });
});
