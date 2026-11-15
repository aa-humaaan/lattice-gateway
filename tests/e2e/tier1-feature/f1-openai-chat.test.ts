/**
 * Tier 1 Feature Coverage: F1 - OpenAI Chat Completions Dialect
 * 
 * Verifies standard OpenAI /v1/chat/completions endpoint behavior:
 * - JSON completions with standard parameters (model, messages, temperature)
 * - SSE streaming with choices[0].delta.content chunks
 * - Streaming with reasoning_content (thinking tokens)
 * - Tool calling in JSON mode (tool_calls array with arguments)
 * - Streaming tool calling with incremental chunks and finish_reason: "tool_calls"
 * - End-of-stream [DONE] marker verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient, parseSSEStream } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertThinkingContent,
  assertToolCallsEmitted,
  assertStreamDone,
} from '../../harness/assertions';

describe('F1: OpenAI /v1/chat/completions Dialect', () => {
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

  // 1. JSON completions with standard parameters
  it('handles standard JSON completion request with expected envelope and usage', async () => {
    const res = await client.openaiChat({
      model: 'mock-chat',
      messages: [
        { role: 'system', content: 'You are a test assistant' },
        { role: 'user', content: 'Hello Project Lattice' },
      ],
      temperature: 0.7,
      max_tokens: 150,
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);

    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('mock-chat');
    expect(body.choices).toBeArray();
    expect(body.choices.length).toBe(1);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toContain('Hello Project Lattice');
    expect(body.choices[0].finish_reason).toBe('stop');

    // Verify usage statistics
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  // 2. SSE streaming with choices[0].delta.content chunks
  it('streams response chunks with delta.content and preserves chunk sequence', async () => {
    const stream = client.openaiChatStream({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Stream test message' }],
    });

    const chunks = await TestClient.collect(stream);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    assertStreamDone(chunks);

    // Filter chunks containing text delta
    const contentChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
    expect(contentChunks.length).toBeGreaterThan(0);

    const fullText = contentChunks.map((c) => c.choices[0].delta.content).join('');
    expect(fullText).toContain('Lattice Gateway Mock Stream');

    // Verify initial chunk has role assistant
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
  });

  // 3. Streaming with reasoning_content (thinking tokens)
  it('streams reasoning_content thinking tokens and final text completion', async () => {
    const stream = client.openaiChatStream({
      model: 'mock-thinking',
      messages: [{ role: 'user', content: 'Deep problem requiring thought' }],
    });

    const chunks = await TestClient.collect(stream);

    expect(chunks.length).toBeGreaterThan(2);
    assertStreamDone(chunks);

    // Verify thinking tokens using domain assertion
    const thinking = assertThinkingContent(chunks, 10);
    expect(thinking).toContain('Thinking chunk 1');
    expect(thinking).toContain('Thinking chunk 2 completed');

    // Verify text result following reasoning
    const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
    const resultText = textChunks.map((c) => c.choices[0].delta.content).join('');
    expect(resultText).toContain('Result following deep reasoning');
  });

  // 4. Tool calling in JSON mode (tool_calls array with arguments)
  it('returns structured tool_calls in JSON mode when tool is invoked', async () => {
    const res = await client.openaiChat({
      model: 'mock-tools',
      messages: [{ role: 'user', content: 'Run command git status' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'execute_command',
            description: 'Run terminal command',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertOpenAISuccess(body);

    const choice = body.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toBeArray();
    expect(choice.message.tool_calls.length).toBe(1);

    const toolCall = choice.message.tool_calls[0];
    expect(toolCall.type).toBe('function');
    expect(toolCall.id).toBeDefined();
    expect(toolCall.function.name).toBe('execute_command');

    const parsedArgs = JSON.parse(toolCall.function.arguments);
    expect(parsedArgs.command).toBe('git status');
  });

  // 5. Streaming tool calling with incremental chunks and finish_reason: "tool_calls"
  it('streams tool_calls with incremental argument deltas and final tool_calls finish_reason', async () => {
    const stream = client.openaiChatStream({
      model: 'mock-tools',
      messages: [{ role: 'user', content: 'Execute shell command' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'execute_command',
            parameters: { type: 'object' },
          },
        },
      ],
    });

    const chunks = await TestClient.collect(stream);

    expect(chunks.length).toBeGreaterThan(2);
    assertStreamDone(chunks);

    // Verify tool calls using domain assertion
    const tools = assertToolCallsEmitted(chunks, 'execute_command');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('execute_command');
    expect(tools[0].arguments).toEqual({ cmd: 'ls -la' });

    // Verify final chunk finish_reason
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('tool_calls');
  });

  // 6. End-of-stream [DONE] marker verification
  it('terminates SSE stream cleanly with explicit data: [DONE] marker', async () => {
    const res = await client.openaiChat({
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'Test stream termination' }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).not.toBeNull();

    const rawEvents: Array<{ event: string; data: string }> = [];
    for await (const ev of parseSSEStream(res.body!)) {
      rawEvents.push(ev);
    }

    expect(rawEvents.length).toBeGreaterThan(0);
    const lastEvent = rawEvents[rawEvents.length - 1];
    expect(lastEvent.data).toBe('[DONE]');
  });
});
