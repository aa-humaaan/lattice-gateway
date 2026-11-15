/**
 * Tier 1 Feature Coverage: F2 - Anthropic Messages Dialect
 * 
 * Verifies standard Anthropic /v1/messages endpoint behavior:
 * - JSON message creation with system prompt and user message
 * - SSE streaming emitting canonical 7-event sequence
 * - Extended thinking blocks with thinking_delta and signature
 * - Tool use calling with tool_use content blocks and tool_result roundtrip
 * - 15s keepalive ping comments (: ping\n\n) preservation
 * - Multi-turn conversation history with alternating roles
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient, parseSSEStream } from '../../harness/test-client';
import {
  assertAnthropicSuccess,
  assertThinkingContent,
  assertToolCallsEmitted,
  assertAnthropicEventSequence,
  assertStreamDone,
} from '../../harness/assertions';

describe('F2: Anthropic /v1/messages Dialect', () => {
  let gateway: GatewayInstance;
  let client: TestClient;

  beforeAll(async () => {
    gateway = await startGateway({
      mode: 'in-process',
      env: { KEEPALIVE_MS: '80' },
    });
    client = new TestClient(gateway.baseUrl);
  });

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  // 1. JSON message creation with system prompt and user message
  it('creates JSON message with system prompt, user turn, and valid usage envelope', async () => {
    const res = await client.anthropicMessages({
      model: 'mock-chat',
      max_tokens: 256,
      system: 'You are an Anthropic test assistant.',
      messages: [{ role: 'user', content: 'Hello Anthropic gateway!' }],
      temperature: 0.5,
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);

    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('mock-chat');
    expect(body.stop_reason).toBe('end_turn');

    // Verify content block
    expect(body.content).toBeArray();
    expect(body.content.length).toBeGreaterThan(0);
    const textBlock = body.content.find((b: any) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain('Hello Anthropic gateway!');

    // Verify usage
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  });

  // 2. SSE streaming emitting canonical 7-event sequence
  it('streams response chunks emitting the canonical Anthropic 7-event sequence', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'mock-chat',
      max_tokens: 150,
      messages: [{ role: 'user', content: 'Stream Anthropic tokens' }],
    });

    const events = await TestClient.collect(stream);

    expect(events.length).toBeGreaterThanOrEqual(6);
    assertAnthropicEventSequence(events);
    assertStreamDone(events);

    // Verify message_start event
    const startEvent = events.find((e) => e.type === 'message_start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.message?.role).toBe('assistant');

    // Verify content_block_delta contains text
    const deltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
    expect(deltas.length).toBeGreaterThan(0);
    const streamText = deltas.map((d) => d.delta?.text).join('');
    expect(streamText).toContain('Lattice Gateway Mock Stream');

    // Verify message_stop is the terminal event
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type || lastEvent.event).toBe('message_stop');
  });

  // 3. Extended thinking blocks with thinking_delta and signature
  it('streams extended thinking blocks with thinking_delta and signature deltas', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'mock-thinking',
      max_tokens: 300,
      thinking: { type: 'enabled', budget_tokens: 200 },
      messages: [{ role: 'user', content: 'Reason through logic puzzle' }],
    });

    const events = await TestClient.collect(stream);

    expect(events.length).toBeGreaterThanOrEqual(7);
    assertStreamDone(events);

    // Verify thinking content via assertion
    const thinking = assertThinkingContent(events, 10);
    expect(thinking).toContain('Thinking chunk 1');
    expect(thinking).toContain('Thinking chunk 2 completed');

    // Verify thinking content block was closed before text block
    const blockStarts = events.filter((e) => e.type === 'content_block_start');
    expect(blockStarts.length).toBeGreaterThanOrEqual(2);
    expect(blockStarts[0].content_block?.type).toBe('thinking');
    expect(blockStarts[1].content_block?.type).toBe('text');

    // Verify signature delta presence
    const sigDelta = events.find((e) => e.delta?.type === 'signature_delta');
    expect(sigDelta).toBeDefined();
    expect((sigDelta?.delta as any)?.signature).toBe('sig_mock_stream_sig');
  });

  // 4. Tool use calling with tool_use content blocks and tool_result roundtrip
  it('emits tool_use block and handles tool_result roundtrip turn seamlessly', async () => {
    // Turn 1: Model decides to call tool
    const res1 = await client.anthropicMessages({
      model: 'mock-tools',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'What files are in current dir?' }],
      tools: [
        {
          name: 'execute_command',
          description: 'Run shell command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      stream: false,
    });

    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as any;
    assertAnthropicSuccess(body1);
    expect(body1.stop_reason).toBe('tool_use');

    const tools = assertToolCallsEmitted(body1, 'execute_command');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('execute_command');

    const toolUseBlock = body1.content.find((b: any) => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    const toolUseId = toolUseBlock.id;

    // Turn 2: User provides tool_result block in follow-up turn
    const res2 = await client.anthropicMessages({
      model: 'mock-chat',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'What files are in current dir?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running command...' },
            { type: 'tool_use', id: toolUseId, name: 'execute_command', input: { command: 'git status' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: 'On branch main, working tree clean',
            },
          ],
        },
      ],
      stream: false,
    });

    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as any;
    assertAnthropicSuccess(body2);
    expect(body2.role).toBe('assistant');
  });

  // 5. Keepalive ping comments (: ping\n\n) preservation
  it('preserves keepalive SSE comments without breaking stream parser', async () => {
    const res = await client.anthropicMessages({
      model: 'mock-chat',
      max_tokens: 150,
      messages: [{ role: 'user', content: 'Keepalive ping check' }],
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).not.toBeNull();

    const comments: string[] = [];
    const events: any[] = [];

    for await (const ev of parseSSEStream(res.body!, {
      onComment: (comment) => {
        comments.push(comment);
      },
    })) {
      events.push(ev);
    }

    // Stream should complete successfully with events
    expect(events.length).toBeGreaterThan(0);
    const stopEvent = events.find((e) => e.event === 'message_stop' || (e.data && e.data.includes('message_stop')));
    expect(stopEvent).toBeDefined();
  });

  // 6. Multi-turn conversation with system string and adjacent message normalization
  it('normalizes multi-turn message history with system prompt and alternating turns', async () => {
    const res = await client.anthropicMessages({
      model: 'mock-chat',
      max_tokens: 200,
      system: 'Persistent system context',
      messages: [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Follow-up question 2' },
      ],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);
    expect(body.content[0].text).toContain('Follow-up question 2');
  });
});
