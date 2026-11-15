/**
 * Tier 2 Boundary & Corner Cases: XML Tool Interceptor Split Chunk Boundaries
 * 
 * Verifies XML tool calling interceptor under difficult chunk fragmentation:
 * - <tool_call> tag split across multiple token chunks (<to, ol_, call>)
 * - <parameter> split across chunks (<param, eter=code>)
 * - Unclosed <tool_call> tag without closing </tool_call> at stream end
 * - Multiple tool calls within single stream turn (sequential indices 0, 1)
 * - Nested XML/HTML tags inside parameter content without premature termination
 * - <invoke name="..."> syntax split across chunks for Anthropic dialect
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient } from '../../harness/test-client';
import {
  assertToolCallsEmitted,
  assertStreamDone,
} from '../../harness/assertions';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class ChunkStreamingMockPlugin implements ProviderPlugin {
  readonly id = 'xml-mock';
  readonly displayName = 'XML Chunk Splitter Mock Provider';
  readonly defaultBaseUrl = 'https://xml-mock.lattice.local';

  // Configurable chunks per test
  public activeChunks: string[] = [];

  setChunks(chunks: string[]): void {
    this.activeChunks = chunks;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'xml-mock/splitter',
        name: 'XML Splitter Model',
        providerId: 'xml-mock',
        ownedBy: 'xml-mock',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'Non-streaming not primary focus of splitter' }],
      stopReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const chunks = [...this.activeChunks];
    const timestamp = Math.floor(Date.now() / 1000);

    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };

      for (const textChunk of chunks) {
        if (signal?.aborted) return;
        yield { type: 'text_delta', delta: textChunk };
      }

      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Tier 2 Boundary: XML Tool-Calling Split Chunk Boundaries', () => {
  let server: any;
  let plugin: ChunkStreamingMockPlugin;
  let client: TestClient;

  beforeAll(async () => {
    plugin = new ChunkStreamingMockPlugin();
    const app = createServer({ port: 0 }, [plugin]);
    server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${server.port}`);
  });

  afterAll(async () => {
    if (server) {
      server.stop(true);
    }
  });

  // 1. <tool_call> opening tag split across multiple token chunks (<to, ol_, call>)
  it('correctly intercepts <tool_call> tag split across token boundaries', async () => {
    plugin.setChunks([
      'Let me run that command for you.\n',
      '<to',
      'ol_',
      'call>\n',
      '{"name":"run_terminal","arguments":{"command":"uname -a"}}\n',
      '</tool_call>',
    ]);

    const stream = client.openaiChatStream({
      model: 'xml-mock/splitter',
      messages: [{ role: 'user', content: 'Check system info' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Verify raw XML was suppressed from content deltas
    const contentDeltas = chunks
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');
    expect(contentDeltas).toContain('Let me run that command for you.');
    expect(contentDeltas).not.toContain('<tool_call>');
    expect(contentDeltas).not.toContain('run_terminal');

    // Verify structured tool call was assembled
    const toolCalls = assertToolCallsEmitted(chunks, 'run_terminal');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('run_terminal');
    expect(toolCalls[0].arguments).toEqual({ command: 'uname -a' });

    // Verify finish_reason transitioned to tool_calls
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe('tool_calls');
  });

  // 2. <parameter> tag split across chunks (<param, eter=code>)
  it('correctly parses tagged parameters when parameter tags and content are fragmented', async () => {
    plugin.setChunks([
      '<tool_call>\n<function=calculate_metrics>\n',
      '<param',
      'eter=formula',
      '>',
      'sqrt(a^2 + ',
      'b^2)',
      '</param',
      'eter>\n',
      '<parameter=precision>4</parameter>\n',
      '</tool_call>',
    ]);

    const stream = client.openaiChatStream({
      model: 'xml-mock/splitter',
      messages: [{ role: 'user', content: 'Calculate hypotenuse' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    const toolCalls = assertToolCallsEmitted(chunks, 'calculate_metrics');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('calculate_metrics');
    expect(toolCalls[0].arguments).toEqual({
      formula: 'sqrt(a^2 + b^2)',
      precision: 4,
    });
  });

  // 3. Unclosed <tool_call> tag without closing </tool_call> at end of stream
  it('recovers partial tool call parameters when closing </tool_call> tag is omitted at stream end', async () => {
    plugin.setChunks([
      'Checking repository status.\n',
      '<tool_call>\n',
      '<function=git_status>\n',
      '<parameter=branch>main</parameter>\n',
      // Notice: stream ends without </tool_call>
    ]);

    const stream = client.openaiChatStream({
      model: 'xml-mock/splitter',
      messages: [{ role: 'user', content: 'Check git status' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Verify recovery logic parsed git_status
    const toolCalls = assertToolCallsEmitted(chunks, 'git_status');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('git_status');
    expect(toolCalls[0].arguments).toEqual({ branch: 'main' });
  });

  // 4. Multiple tool calls within single stream turn
  it('intercepts multiple consecutive tool calls in a single stream and assigns sequential indices', async () => {
    plugin.setChunks([
      '<tool_call>\n',
      '<function=fetch_url>\n',
      '<parameter=url>https://api.github.com/repos/test</parameter>\n',
      '</tool_call>\n',
      '<tool_call>\n',
      '<function=log_event>\n',
      '<parameter=msg>Fetch started</parameter>\n',
      '</tool_call>',
    ]);

    const stream = client.openaiChatStream({
      model: 'xml-mock/splitter',
      messages: [{ role: 'user', content: 'Fetch and log' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Filter all chunks that contain tool_calls deltas
    const toolDeltas = chunks
      .flatMap((c) => c.choices[0]?.delta?.tool_calls || [])
      .filter(Boolean);

    // Verify both tools are emitted
    const toolNames = toolDeltas
      .map((t) => t.function?.name)
      .filter((n): n is string => Boolean(n));
    expect(toolNames).toContain('fetch_url');
    expect(toolNames).toContain('log_event');

    // Verify sequential indices: first tool index 0, second tool index 1
    const indices = toolDeltas.map((t) => t.index);
    expect(indices).toContain(0);
    expect(indices).toContain(1);
  });

  // 5. Nested XML tags inside parameter content (code containing HTML/XML)
  it('preserves nested XML and HTML markup inside parameter values without corrupting tags', async () => {
    const htmlPayload = '<div class="alert"><span id="msg">Operation Successful</span></div>';

    plugin.setChunks([
      '<tool_call>\n',
      '<function=render_html>\n',
      `<parameter=template>${htmlPayload}</parameter>\n`,
      '</tool_call>',
    ]);

    const stream = client.openaiChatStream({
      model: 'xml-mock/splitter',
      messages: [{ role: 'user', content: 'Render template' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    const toolCalls = assertToolCallsEmitted(chunks, 'render_html');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('render_html');
    expect(toolCalls[0].arguments.template).toBe(htmlPayload);
  });

  // 6. <invoke name="..."> syntax split across chunks for Anthropic dialect
  it('transforms fragmented <invoke name="..."> XML syntax into Anthropic tool_use content blocks', async () => {
    plugin.setChunks([
      'Preparing tool invocation.\n',
      '<inv',
      'oke name="read_file">\n',
      '<parameters>\n',
      '{"path": "src/index.ts", "encoding": "utf-8"}\n',
      '</parameters>\n',
      '</invoke>',
    ]);

    const stream = client.anthropicMessagesStream({
      model: 'xml-mock/splitter',
      messages: [{ role: 'user', content: 'Read file contents' }],
    });

    const events = await TestClient.collect(stream);
    expect(events.length).toBeGreaterThan(0);

    // Verify tool_use block start
    const blockStart = events.find(
      (e) => e.data.type === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    );
    expect(blockStart).toBeDefined();
    expect(blockStart?.data.content_block?.type).toBe('tool_use');
    expect(blockStart?.data.content_block?.name).toBe('read_file');

    // Verify tool_use delta contains parsed json
    const blockDeltas = events.filter((e) => e.data.type === 'content_block_delta');
    const inputJsonParts = blockDeltas
      .map((d) => d.data.delta?.partial_json)
      .filter(Boolean)
      .join('');
    const parsedInput = JSON.parse(inputJsonParts);
    expect(parsedInput.path).toBe('src/index.ts');
    expect(parsedInput.encoding).toBe('utf-8');
  });
});
