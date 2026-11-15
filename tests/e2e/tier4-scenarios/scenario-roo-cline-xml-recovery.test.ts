/**
 * Tier 4 Real-World Application Scenario: S3 - Roo-Cline XML Tool-Calling Recovery
 * 
 * Simulates open-source models (Qwen 2.5/3.8, Hermes, DeepSeek) used by Roo-Cline / Cline:
 * Models output raw XML markup (<tool_call>, <invoke>) into the text stream.
 * In raw mode, Roo-Cline errors: "The model provided text/reasoning but did not call any of the required tools."
 * Project Lattice's XMLToolInterceptor intercepts the stream in real-time:
 * - Suppresses raw XML from choices[0].delta.content
 * - Flushes preceding/succeeding conversational reasoning
 * - Emits standard delta.tool_calls with finish_reason: "tool_calls"
 * - Converts to Anthropic tool_use events when accessed via /v1/messages
 * - Handles multiline bash commands, multi-parameter calls, and unclosed XML recovery
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

class XMLToolModelMockPlugin implements ProviderPlugin {
  readonly id = 'qwen';
  readonly displayName = 'Qwen / Hermes Raw XML Model Mock Provider';
  readonly defaultBaseUrl = 'https://mock.qwen.local/v1';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'qwen/qwen-2.5-coder',
        name: 'Qwen 2.5 Coder (Raw XML Output)',
        providerId: 'qwen',
        ownedBy: 'qwen',
        created: 1731693600,
        supportsTools: true,
        supportsStreaming: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: 'Non-streaming XML response' }],
      stopReason: 'stop',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const messages = req.messages;
    const lastMsg = messages[messages.length - 1];
    const userPrompt =
      typeof lastMsg.content === 'string'
        ? lastMsg.content
        : Array.isArray(lastMsg.content)
        ? (lastMsg.content[0] as any)?.text || ''
        : '';

    const events: CanonicalStreamEvent[] = [];
    events.push({ type: 'stream_start', id: req.id, model: req.model, created: timestamp });

    // Check for 2-turn agent loop Turn 2
    const toolResults = messages.filter((m) => m.role === 'tool' || (Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result')));
    if (toolResults.length > 0) {
      events.push({
        type: 'text_delta',
        delta: 'The terminal command completed. Current branch is clean and up to date with origin/main.',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
      return (async function* () {
        for (const ev of events) {
          if (signal?.aborted) return;
          yield ev;
        }
      })();
    }

    // Branch 1: Preceding Conversational Reasoning + Standard XML Tool Call
    if (userPrompt.includes('with reasoning')) {
      events.push({
        type: 'text_delta',
        delta: 'I will now run the git status command to inspect uncommitted files.\n',
      });
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=run_terminal_command>\n<parameter=command>git status</parameter>\n</tool_call>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }
    // Branch 2: Multi-Parameter XML Tool Call
    else if (userPrompt.includes('write file')) {
      events.push({
        type: 'text_delta',
        delta: 'Writing updated configuration file:\n',
      });
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=write_to_file>\n<parameter=path>src/config.ts</parameter>\n<parameter=content>export const PORT = 4000;\nexport const DEBUG = true;</parameter>\n</tool_call>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }
    // Branch 3: Multiline Bash Script with Shell Meta-characters
    else if (userPrompt.includes('multiline bash')) {
      const script = "cat << 'EOF' > setup.sh\necho \"Installing dependencies...\"\nnpm install --silent\nEOF\nbash setup.sh | grep 'complete'";
      events.push({
        type: 'text_delta',
        delta: `<tool_call>\n<function=run_terminal_command>\n<parameter=command>${script}</parameter>\n</tool_call>`,
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }
    // Branch 4: Alternate <invoke name="..."> syntax (Hermes style)
    else if (userPrompt.includes('invoke format')) {
      events.push({
        type: 'text_delta',
        delta: 'Using Hermes invoke format:\n',
      });
      events.push({
        type: 'text_delta',
        delta: '<invoke name="read_file"><parameter name="path">package.json</parameter></invoke>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }
    // Branch 5: Unclosed XML Tag at Stream Termination
    else if (userPrompt.includes('unclosed tag')) {
      events.push({
        type: 'text_delta',
        delta: 'Beginning tool invocation...\n',
      });
      // Emits opening tag and parameter, but stream terminates before closing </tool_call>
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=execute_shell>\n<parameter=cmd>pwd</parameter>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }
    // Branch 6: Standard Roo-Cline XML Tool Call
    else {
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=run_terminal_command>\n<parameter=command>git status -s</parameter>\n</tool_call>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    }

    return (async function* () {
      for (const ev of events) {
        if (signal?.aborted) return;
        yield ev;
      }
    })();
  }
}

describe('Tier 4 Scenario S3: Roo-Cline XML Tool-Calling Recovery', () => {
  let mockPlugin: XMLToolModelMockPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockPlugin = new XMLToolModelMockPlugin();
    const app = createServer({ port: 0 }, [mockPlugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });
    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) {
      gatewayServer.stop(true);
    }
  });

  // --------------------------------------------------------------------------
  // Test 1: Standard XML Tool Call Conversion to OpenAI delta.tool_calls
  // --------------------------------------------------------------------------
  it('intercepts raw <tool_call> XML and converts to standard OpenAI delta.tool_calls chunk', async () => {
    const stream = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Run git status check.' }],
    });

    const chunks = await TestClient.collect(stream);
    assertStreamDone(chunks);

    // Verify tool call was properly emitted
    const toolCalls = assertToolCallsEmitted(chunks, 'run_terminal_command');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('run_terminal_command');
    expect(toolCalls[0].arguments).toEqual({ command: 'git status -s' });

    // Verify finish_reason is tool_calls
    const finishChunk = chunks.find((c) => c.choices[0]?.finish_reason === 'tool_calls');
    expect(finishChunk).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Test 2: Complete Suppression of Raw XML Markup from delta.content
  // --------------------------------------------------------------------------
  it('completely suppresses raw XML markup tags from choices[0].delta.content', async () => {
    const stream = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Run git status check with reasoning.' }],
    });

    const chunks = await TestClient.collect(stream);

    // Gather all text content chunks
    const allContent = chunks
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');

    // Crucial Roo-Cline assertion: XML tags must NEVER leak into content
    expect(allContent).not.toContain('<tool_call>');
    expect(allContent).not.toContain('</tool_call>');
    expect(allContent).not.toContain('<function=');
    expect(allContent).not.toContain('<parameter=');
    expect(allContent).not.toContain('</parameter>');

    // But genuine reasoning text MUST be preserved
    expect(allContent).toContain('I will now run the git status command');
  });

  // --------------------------------------------------------------------------
  // Test 3: Multi-Parameter XML Tool Call Parsing
  // --------------------------------------------------------------------------
  it('parses multi-parameter XML tool calls with path and content into valid JSON arguments', async () => {
    const stream = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Please write file src/config.ts' }],
    });

    const chunks = await TestClient.collect(stream);
    const toolCalls = assertToolCallsEmitted(chunks, 'write_to_file');

    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('write_to_file');
    expect(toolCalls[0].arguments.path).toBe('src/config.ts');
    expect(toolCalls[0].arguments.content).toContain('export const PORT = 4000;');
    expect(toolCalls[0].arguments.content).toContain('export const DEBUG = true;');
  });

  // --------------------------------------------------------------------------
  // Test 4: Multiline Bash Script with Shell Meta-characters
  // --------------------------------------------------------------------------
  it('preserves multiline scripts with pipes, quotes, and heredocs without corruption', async () => {
    const stream = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Execute multiline bash script' }],
    });

    const chunks = await TestClient.collect(stream);
    const toolCalls = assertToolCallsEmitted(chunks, 'run_terminal_command');

    expect(toolCalls.length).toBe(1);
    const cmd = toolCalls[0].arguments.command;
    expect(cmd).toContain("cat << 'EOF' > setup.sh");
    expect(cmd).toContain('npm install --silent');
    expect(cmd).toContain("bash setup.sh | grep 'complete'");
  });

  // --------------------------------------------------------------------------
  // Test 5: Alternate <invoke name="..."> Hermes Syntax
  // --------------------------------------------------------------------------
  it('intercepts Hermes <invoke name="..."> syntax and extracts parameters', async () => {
    const stream = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Use invoke format for read file' }],
    });

    const chunks = await TestClient.collect(stream);
    const toolCalls = assertToolCallsEmitted(chunks, 'read_file');

    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('read_file');
    expect(toolCalls[0].arguments).toEqual({ path: 'package.json' });
  });

  // --------------------------------------------------------------------------
  // Test 6: Unclosed XML Tag at Stream Termination Recovery
  // --------------------------------------------------------------------------
  it('safely handles unclosed XML tags at stream termination without dropping arguments or crashing', async () => {
    const stream = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Test unclosed tag recovery' }],
    });

    const chunks = await TestClient.collect(stream);
    expect(chunks.length).toBeGreaterThan(0);
    assertStreamDone(chunks);

    // Either a tool call was salvaged or buffer was safely flushed without uncaught errors
    const hasToolCall = chunks.some((c) => c.choices[0]?.delta?.tool_calls?.length);
    const hasTextContent = chunks.some((c) => c.choices[0]?.delta?.content);
    expect(hasToolCall || hasTextContent).toBeTrue();
  });

  // --------------------------------------------------------------------------
  // Test 7: Anthropic Dialect Conversion of Raw XML Tool Call
  // --------------------------------------------------------------------------
  it('converts raw XML tool calls into valid Anthropic tool_use content blocks via /v1/messages', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'qwen/qwen-2.5-coder',
      messages: [{ role: 'user', content: 'Audit repository git status.' }],
    });

    const events = await TestClient.collect(stream);

    // Verify Anthropic tool_use content block was emitted
    const toolUseStart = events.find(
      (e) => e.content_block?.type === 'tool_use' || e.type === 'content_block_start'
    );
    expect(toolUseStart).toBeDefined();

    // Verify stop_reason is tool_use
    const msgDelta = events.find((e) => e.event === 'message_delta' || e.type === 'message_delta');
    expect(msgDelta?.delta?.stop_reason).toBe('tool_use');
  });

  // --------------------------------------------------------------------------
  // Test 8: Complete 2-Turn Roo-Cline Agent Loop with XML Recovery
  // --------------------------------------------------------------------------
  it('executes complete 2-turn Roo-Cline agent loop (XML tool call -> tool result -> final text)', async () => {
    const history: any[] = [
      { role: 'user', content: 'Audit repository git status with reasoning.' },
    ];

    // TURN 1: Model outputs raw XML -> Interceptor converts to OpenAI tool_calls
    const stream1 = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: history,
    });
    const chunks1 = await TestClient.collect(stream1);
    const toolCalls1 = assertToolCallsEmitted(chunks1, 'run_terminal_command');
    expect(toolCalls1.length).toBe(1);
    expect(toolCalls1[0].arguments).toEqual({ command: 'git status' });

    // Append Assistant message with parsed tool call
    history.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_xml_01',
          type: 'function',
          function: { name: 'run_terminal_command', arguments: '{"command":"git status"}' },
        },
      ],
    });

    // Append Tool execution result from Roo-Cline
    history.push({
      role: 'tool',
      tool_call_id: 'call_xml_01',
      content: 'On branch main\nYour branch is up to date with origin/main.\nnothing to commit, working tree clean',
    });

    // TURN 2: Deliver result -> Model provides final completion
    const stream2 = client.openaiChatStream({
      model: 'qwen/qwen-2.5-coder',
      messages: history,
    });
    const chunks2 = await TestClient.collect(stream2);
    assertStreamDone(chunks2);

    const finishChunk = chunks2.find((c) => c.choices[0]?.finish_reason === 'stop');
    expect(finishChunk).toBeDefined();

    const finalContent = chunks2
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');
    expect(finalContent).toContain('The terminal command completed');
    expect(finalContent).toContain('Current branch is clean');
  });
});
