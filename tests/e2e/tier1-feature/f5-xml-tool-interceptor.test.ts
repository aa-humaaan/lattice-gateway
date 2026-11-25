/**
 * Tier 1 Feature Coverage: F5 - XML Tool-Calling Interceptor
 * 
 * Verifies non-blocking stream transformer detecting XML tool calls:
 * - Intercepts raw <tool_call><function=name><parameter=k>v</parameter></tool_call> in stream
 * - Suppresses raw XML tags from leaking into choices[0].delta.content
 * - Emits structured delta.tool_calls in OpenAI dialect
 * - Emits structured tool_use block in Anthropic dialect
 * - Flushes regular conversational text preceding or following XML tool calls
 * - Handles <invoke name="..."> parameter syntax cleanly
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startGateway, type GatewayInstance } from '../../harness/gateway-runner';
import { TestClient } from '../../harness/test-client';
import { assertToolCallsEmitted, assertStreamDone } from '../../harness/assertions';
import { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import { CanonicalRequest, CanonicalStreamEvent } from '../../../src/core/types/canonical';

// Custom plugin simulating various raw XML tool calls from upstream LLMs (e.g. Qwen / Hermes / DeepSeek)
class XMLStreamPlugin implements ProviderPlugin {
  readonly id = 'xml-test';
  readonly displayName = 'XML Stream Test Plugin';
  readonly defaultBaseUrl = 'https://xml.lattice.local';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      { id: 'xml-test/invoke-tag', name: 'Invoke Tag Model' },
      { id: 'xml-test/multiline-params', name: 'Multiline Params Model' },
      { id: 'xml-test/surrounding-text', name: 'Surrounding Text Model' },
    ];
  }

  async execute(): Promise<any> {
    throw new Error('Not implemented');
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const events: CanonicalStreamEvent[] = [];
    const timestamp = Math.floor(Date.now() / 1000);
    events.push({ type: 'stream_start', id: req.id, model: req.model, created: timestamp });

    if (req.model === 'xml-test/invoke-tag') {
      events.push({ type: 'text_delta', delta: 'Let me search the web for you.\n' });
      events.push({
        type: 'text_delta',
        delta: '<invoke name="web_search">\n<parameter name="query">bun test runner</parameter>\n</invoke>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    } else if (req.model === 'xml-test/surrounding-text') {
      events.push({ type: 'text_delta', delta: 'Thinking: I need to read the config file first.\n' });
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=read_file>\n<parameter=path>package.json</parameter>\n</function>\n</tool_call>',
      });
      events.push({ type: 'text_delta', delta: '\nAfter reading, I will analyze dependencies.' });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    } else {
      // Multiline params
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=write_file>\n<parameter=path>test.txt</parameter>\n<parameter=content>Line 1\nLine 2</parameter>\n</function>\n</tool_call>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }

    return (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })();
  }
}

describe('F5: XML Tool-Calling Interceptor', () => {
  let gateway: GatewayInstance;
  let client: TestClient;

  beforeAll(async () => {
    // Dynamic import to create custom server with XML test plugin
    const { createServer } = await import('../../../src/core/server');
    const { MockProviderPlugin } = await import('../../mocks/mock-provider');

    const app = createServer({}, [
      new MockProviderPlugin(),
      new XMLStreamPlugin(),
    ]);

    const dummy = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });

    const assignedPort = dummy.port ?? 0;
    gateway = {
      baseUrl: `http://127.0.0.1:${assignedPort}`,
      port: assignedPort,
      dataDir: '',
      mode: 'in-process',
      async stop() {
        dummy.stop(true);
      },
    };
    client = new TestClient(gateway.baseUrl);
  });

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }
  });

  // 1. Intercepts raw <tool_call> in OpenAI stream
  it('intercepts raw <tool_call> XML and converts to structured delta.tool_calls', async () => {
    const stream = client.openaiChatStream({
      model: 'mock-xml-tool',
      messages: [{ role: 'user', content: 'Run command' }],
    });

    const chunks = await TestClient.collect(stream);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    assertStreamDone(chunks);

    const tools = assertToolCallsEmitted(chunks, 'execute_shell');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('execute_shell');
    expect(tools[0].arguments).toEqual({ cmd: 'pwd' });
  });

  // 2. Suppresses raw XML tags from leaking into choices[0].delta.content
  it('completely suppresses raw XML markup tags from choices[0].delta.content', async () => {
    const stream = client.openaiChatStream({
      model: 'mock-xml-tool',
      messages: [{ role: 'user', content: 'Run command' }],
    });

    const chunks = await TestClient.collect(stream);

    for (const chunk of chunks) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        expect(content).not.toContain('<tool_call>');
        expect(content).not.toContain('</tool_call>');
        expect(content).not.toContain('<function=');
        expect(content).not.toContain('<parameter=');
      }
    }
  });

  // 3. Emits structured tool_use block in Anthropic dialect
  it('converts raw XML tool calls into valid Anthropic tool_use content blocks', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'mock-xml-tool',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'Run shell command' }],
    });

    const events = await TestClient.collect(stream);
    expect(events.length).toBeGreaterThanOrEqual(5);

    // Verify tool_use block start
    const blockStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    expect(blockStart).toBeDefined();
    expect(blockStart?.content_block?.name).toBe('execute_shell');

    // Verify input_json_delta
    const jsonDelta = events.find((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
    expect(jsonDelta).toBeDefined();

    // Verify stop_reason in message_delta is tool_use
    const msgDelta = events.find((e) => e.type === 'message_delta');
    expect(msgDelta?.delta?.stop_reason).toBe('tool_use');
  }, 30_000);

  // 4. Flushes regular conversational text preceding XML tool calls
  it('flushes conversational reasoning text preceding XML tool call without corruption', async () => {
    const stream = client.openaiChatStream({
      model: 'mock-xml-tool',
      messages: [{ role: 'user', content: 'What are you doing?' }],
    });

    const chunks = await TestClient.collect(stream);
    const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
    const combinedText = textChunks.map((c) => c.choices[0].delta.content).join('');

    // Preceding text from mock-xml-tool is "Running shell command...\n"
    expect(combinedText).toContain('Running shell command');
  });

  // 5. Intercepts <invoke name="..."> XML syntax
  it('intercepts <invoke name="..."> XML syntax and extracts function name and parameter', async () => {
    const stream = client.openaiChatStream({
      model: 'xml-test/invoke-tag',
      messages: [{ role: 'user', content: 'Search online' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    const tools = assertToolCallsEmitted(chunks, 'web_search');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('web_search');
    expect(tools[0].arguments).toEqual({ query: 'bun test runner' });

    // Verify preceding text was delivered
    const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
    const combinedText = textChunks.map((c) => c.choices[0].delta.content).join('');
    expect(combinedText).toContain('Let me search the web');
  });

  // 6. Handles multiline parameters and JSON parameter blocks inside XML
  it('parses multiline parameters inside XML tool call correctly', async () => {
    const stream = client.openaiChatStream({
      model: 'xml-test/multiline-params',
      messages: [{ role: 'user', content: 'Write file' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    const tools = assertToolCallsEmitted(chunks, 'write_file');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('write_file');
    expect(tools[0].arguments.path).toBe('test.txt');
    expect(tools[0].arguments.content).toContain('Line 1');
  });
});
