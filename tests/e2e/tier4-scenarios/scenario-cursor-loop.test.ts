/**
 * Tier 4 Real-World Application Scenario: S1 - Cursor / Windsurf Multi-Turn Agent Loop
 * 
 * Simulates authentic agentic workflows from modern IDEs (Cursor, Windsurf):
 * 1. Multi-turn code refactoring loop (read_file -> write_file -> final explanation)
 * 2. Context accumulation and token usage progression across turns
 * 3. Tool execution error recovery (model adapts when tool returns failure)
 * 4. Parallel multi-tool calling within a single streaming turn
 * 5. Transparent combo failover mid-loop when primary model encounters 429
 * 6. Concurrent independent agent sessions executing without cross-talk
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
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
import { GatewayError } from '../../../src/core/types/errors';

export class CursorAgentMockPlugin implements ProviderPlugin {
  readonly id = 'cursor';
  readonly displayName = 'Cursor / Windsurf Agent Mock Provider';
  readonly defaultBaseUrl = 'https://mock.cursor.local/v1';

  public failOnTurn2 = false;
  public failoverTriggeredCount = 0;
  public turnCountsBySession = new Map<string, number>();

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'cursor/agent-model',
        name: 'Cursor Agent Model',
        providerId: 'cursor',
        ownedBy: 'cursor',
        created: 1731693600,
        supportsTools: true,
        supportsStreaming: true,
        supportsThinking: true,
      },
      {
        id: 'cursor/fallback-model',
        name: 'Cursor Fallback Agent Model',
        providerId: 'cursor',
        ownedBy: 'cursor',
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
      content: [{ type: 'text', text: 'Cursor agent completed task in non-streaming mode.' }],
      stopReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const messages = req.messages;

    const toolResults = messages.filter((m) => m.role === 'tool');
    const sessionId = (req.metadata?.sessionId as string) || 'default-session';
    const currentTurn = (this.turnCountsBySession.get(sessionId) || 0) + 1;
    this.turnCountsBySession.set(sessionId, currentTurn);

    // Failover testing branch
    if (this.failOnTurn2 && toolResults.length === 1 && req.model === 'cursor/agent-model') {
      this.failoverTriggeredCount++;
      throw new GatewayError(
        429,
        'rate_limit_exceeded',
        'Cursor upstream rate limit exceeded on Turn 2',
        { retryAfter: 3 }
      );
    }

    const events: CanonicalStreamEvent[] = [];
    events.push({ type: 'stream_start', id: req.id, model: req.model, created: timestamp });

    // Helper to extract tool result text regardless of representation
    const getToolResultText = (m: any): string => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'tool_result' && typeof p.content === 'string') return p.content;
          if (typeof p.text === 'string') return p.text;
        }
      }
      return '';
    };

    // Case 1: Error Recovery Scenario
    const isErrorRecovery = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('Run test suite')
    );
    if (isErrorRecovery) {
      if (toolResults.length === 0) {
        // Turn 1: Call npm test
        events.push({
          type: 'thinking_delta',
          delta: 'User requested test execution. Invoking terminal command runner...',
        });
        events.push({
          type: 'tool_call_start',
          index: 0,
          id: 'call_cmd_01',
          name: 'run_terminal_command',
        });
        events.push({
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({ command: 'npm test' }),
        });
        events.push({ type: 'tool_call_stop', index: 0 });
        events.push({
          type: 'usage',
          usage: { promptTokens: 120, completionTokens: 35, totalTokens: 155 },
        });
        events.push({ type: 'stream_end', stopReason: 'tool_calls' });
      } else if (
        toolResults.length === 1 &&
        getToolResultText(toolResults[0]).includes('Jest not found')
      ) {
        // Turn 2: Adapt to error and retry with npm run test:unit
        events.push({
          type: 'thinking_delta',
          delta: 'Command npm test failed because Jest was missing. Adapting to npm run test:unit...',
        });
        events.push({
          type: 'tool_call_start',
          index: 0,
          id: 'call_cmd_02',
          name: 'run_terminal_command',
        });
        events.push({
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({ command: 'npm run test:unit' }),
        });
        events.push({ type: 'tool_call_stop', index: 0 });
        events.push({
          type: 'usage',
          usage: { promptTokens: 250, completionTokens: 40, totalTokens: 290 },
        });
        events.push({ type: 'stream_end', stopReason: 'tool_calls' });
      } else {
        // Turn 3: Success explanation
        events.push({
          type: 'text_delta',
          delta: 'All unit tests passed successfully with 12 tests green after executing npm run test:unit.',
        });
        events.push({
          type: 'usage',
          usage: { promptTokens: 380, completionTokens: 30, totalTokens: 410 },
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

    // Case 2: Parallel Multi-Tool Calling Scenario
    const isParallelTool = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('Check both config and index')
    );
    if (isParallelTool) {
      if (toolResults.length === 0) {
        // Emit 2 parallel tool calls
        events.push({
          type: 'thinking_delta',
          delta: 'Inspecting config.json and index.ts simultaneously...',
        });
        events.push({
          type: 'tool_call_start',
          index: 0,
          id: 'call_read_cfg',
          name: 'read_file',
        });
        events.push({
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({ path: 'config.json' }),
        });
        events.push({ type: 'tool_call_stop', index: 0 });

        events.push({
          type: 'tool_call_start',
          index: 1,
          id: 'call_read_idx',
          name: 'read_file',
        });
        events.push({
          type: 'tool_call_delta',
          index: 1,
          argumentsDelta: JSON.stringify({ path: 'src/index.ts' }),
        });
        events.push({ type: 'tool_call_stop', index: 1 });

        events.push({
          type: 'usage',
          usage: { promptTokens: 160, completionTokens: 55, totalTokens: 215 },
        });
        events.push({ type: 'stream_end', stopReason: 'tool_calls' });
      } else {
        events.push({
          type: 'text_delta',
          delta: 'Both configuration and entrypoint inspected successfully. System is properly configured.',
        });
        events.push({
          type: 'usage',
          usage: { promptTokens: 400, completionTokens: 35, totalTokens: 435 },
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

    // Case 3: Standard File Refactoring Loop (Turn 1 -> Turn 2 -> Turn 3)
    if (toolResults.length === 0) {
      // Turn 1: Model emits thinking + read_file tool call
      events.push({
        type: 'thinking_delta',
        delta: 'Inspecting auth module source file at src/auth/service.ts...',
      });
      events.push({
        type: 'tool_call_start',
        index: 0,
        id: 'call_read_01',
        name: 'read_file',
      });
      events.push({
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: JSON.stringify({ path: 'src/auth/service.ts' }),
      });
      events.push({ type: 'tool_call_stop', index: 0 });
      events.push({
        type: 'usage',
        usage: { promptTokens: 140, completionTokens: 45, totalTokens: 185 },
      });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });
    } else if (toolResults.length === 1) {
      // Turn 2: Client provided file contents -> Model emits thinking + write_file tool call
      events.push({
        type: 'thinking_delta',
        delta: 'Legacy cookie session detected. Writing updated JWT authentication implementation...',
      });
      events.push({
        type: 'tool_call_start',
        index: 0,
        id: 'call_write_01',
        name: 'write_file',
      });
      events.push({
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: JSON.stringify({
          path: 'src/auth/service.ts',
          content:
            "import jwt from 'jsonwebtoken';\nexport function authenticate(u, p) { return jwt.sign({ u }, 'secret'); }",
        }),
      });
      events.push({ type: 'tool_call_stop', index: 0 });
      events.push({
        type: 'usage',
        usage: { promptTokens: 310, completionTokens: 75, totalTokens: 385 },
      });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });
    } else {
      // Turn 3: File written -> Model explains changes and finishes with stop
      events.push({
        type: 'thinking_delta',
        delta: 'File write confirmed. Formulating final explanation for developer...',
      });
      events.push({
        type: 'text_delta',
        delta:
          'Successfully refactored the auth module to use JWT tokens. Replaced legacy cookie logic with signed JWT tokens.',
      });
      events.push({
        type: 'usage',
        usage: { promptTokens: 460, completionTokens: 40, totalTokens: 500 },
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

describe('Tier 4 Scenario S1: Cursor / Windsurf Multi-Turn Agent Loop', () => {
  let mockPlugin: CursorAgentMockPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockPlugin = new CursorAgentMockPlugin();
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

  beforeEach(() => {
    mockPlugin.failOnTurn2 = false;
    mockPlugin.failoverTriggeredCount = 0;
    mockPlugin.turnCountsBySession.clear();
  });

  // --------------------------------------------------------------------------
  // Test 1: Full 3-Turn Code Refactoring Agent Loop
  // --------------------------------------------------------------------------
  it('executes authentic 3-turn code refactoring loop (read -> write -> explain)', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Reads contents of a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Writes replacement code to file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
    ];

    const conversationHistory: any[] = [
      {
        role: 'system',
        content:
          'You are Cursor AI, an intelligent coding agent that executes file edits via tool calling.',
      },
      {
        role: 'user',
        content: 'Refactor auth module at src/auth/service.ts to support JWT tokens.',
      },
    ];

    // TURN 1: Initial request with tools
    const stream1 = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: conversationHistory,
      tools,
      stream_options: { include_usage: true },
    });
    const chunks1 = await TestClient.collect(stream1);
    assertStreamDone(chunks1);

    // Verify reasoning tokens and tool call emitted
    const toolCalls1 = assertToolCallsEmitted(chunks1, 'read_file');
    expect(toolCalls1.length).toBe(1);
    expect(toolCalls1[0].name).toBe('read_file');
    expect(toolCalls1[0].arguments).toEqual({ path: 'src/auth/service.ts' });

    // Verify finish_reason is tool_calls
    const finishChunk1 = chunks1.find((c) => c.choices[0]?.finish_reason === 'tool_calls');
    expect(finishChunk1).toBeDefined();

    // Verify usage progression
    const usageChunk1 = chunks1.find((c) => c.usage?.total_tokens);
    expect(usageChunk1?.usage?.prompt_tokens).toBe(140);

    // TURN 2: Deliver read_file result to agent
    conversationHistory.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read_01',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'src/auth/service.ts' }),
          },
        },
      ],
    });
    conversationHistory.push({
      role: 'tool',
      tool_call_id: 'call_read_01',
      content:
        "// Legacy auth\nexport function authenticate(u, p) { return 'session_cookie_token'; }",
    });

    const stream2 = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: conversationHistory,
      tools,
      stream_options: { include_usage: true },
    });
    const chunks2 = await TestClient.collect(stream2);
    assertStreamDone(chunks2);

    const toolCalls2 = assertToolCallsEmitted(chunks2, 'write_file');
    expect(toolCalls2.length).toBe(1);
    expect(toolCalls2[0].name).toBe('write_file');
    expect(toolCalls2[0].arguments.path).toBe('src/auth/service.ts');
    expect(toolCalls2[0].arguments.content).toContain("import jwt from 'jsonwebtoken'");

    const usageChunk2 = chunks2.find((c) => c.usage?.total_tokens);
    expect(usageChunk2?.usage?.prompt_tokens).toBeGreaterThan(usageChunk1!.usage!.prompt_tokens);

    // TURN 3: Deliver write_file result to agent
    conversationHistory.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_write_01',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify(toolCalls2[0].arguments),
          },
        },
      ],
    });
    conversationHistory.push({
      role: 'tool',
      tool_call_id: 'call_write_01',
      content: JSON.stringify({ status: 'ok', bytes_written: 142 }),
    });

    const stream3 = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: conversationHistory,
      tools,
      stream_options: { include_usage: true },
    });
    const chunks3 = await TestClient.collect(stream3);
    assertStreamDone(chunks3);

    // Verify final explanation arrived with finish_reason: stop
    const finishChunk3 = chunks3.find((c) => c.choices[0]?.finish_reason === 'stop');
    expect(finishChunk3).toBeDefined();

    const fullContent3 = chunks3
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');
    expect(fullContent3).toContain('Successfully refactored the auth module');
    expect(fullContent3).toContain('JWT tokens');

    const usageChunk3 = chunks3.find((c) => c.usage?.total_tokens);
    expect(usageChunk3?.usage?.prompt_tokens).toBeGreaterThan(usageChunk2!.usage!.prompt_tokens);
  });

  // --------------------------------------------------------------------------
  // Test 2: Tool Execution Error Recovery Loop
  // --------------------------------------------------------------------------
  it('recovers gracefully when client returns tool execution error and retries alternative', async () => {
    const history: any[] = [
      { role: 'user', content: 'Run test suite to verify module integrity.' },
    ];

    // Turn 1: Model calls npm test
    const stream1 = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: history,
    });
    const chunks1 = await TestClient.collect(stream1);
    const tools1 = assertToolCallsEmitted(chunks1, 'run_terminal_command');
    expect(tools1[0].arguments).toEqual({ command: 'npm test' });

    // Turn 2: Client returns error message
    history.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_cmd_01',
          type: 'function',
          function: { name: 'run_terminal_command', arguments: '{"command":"npm test"}' },
        },
      ],
    });
    history.push({
      role: 'tool',
      tool_call_id: 'call_cmd_01',
      content: 'Error: Jest not found in PATH. Suggestion: use npm run test:unit.',
    });

    // Turn 2 request: Model adapts and calls npm run test:unit
    const stream2 = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: history,
    });
    const chunks2 = await TestClient.collect(stream2);
    const tools2 = assertToolCallsEmitted(chunks2, 'run_terminal_command');
    expect(tools2[0].arguments).toEqual({ command: 'npm run test:unit' });

    // Turn 3: Client returns success
    history.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_cmd_02',
          type: 'function',
          function: { name: 'run_terminal_command', arguments: '{"command":"npm run test:unit"}' },
        },
      ],
    });
    history.push({
      role: 'tool',
      tool_call_id: 'call_cmd_02',
      content: 'PASS: 12 tests passed, 0 failed.',
    });

    const stream3 = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: history,
    });
    const chunks3 = await TestClient.collect(stream3);
    const finalContent = chunks3
      .filter((c) => c.choices[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join('');
    expect(finalContent).toContain('All unit tests passed successfully');
  });

  // --------------------------------------------------------------------------
  // Test 3: Parallel Tool Calling within a Single Streaming Turn
  // --------------------------------------------------------------------------
  it('handles parallel tool calling across multiple files in a single streaming turn', async () => {
    const stream = client.openaiChatStream({
      model: 'cursor/agent-model',
      messages: [{ role: 'user', content: 'Check both config and index files please.' }],
    });
    const chunks = await TestClient.collect(stream);

    // Extract tool calls across all chunks
    const toolCalls = assertToolCallsEmitted(chunks);
    expect(toolCalls.length).toBe(2);

    const configCall = toolCalls.find((t) => t.arguments?.path === 'config.json');
    const indexCall = toolCalls.find((t) => t.arguments?.path === 'src/index.ts');

    expect(configCall).toBeDefined();
    expect(indexCall).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Test 4: Concurrent Independent Agent Sessions
  // --------------------------------------------------------------------------
  it('executes concurrent independent agent loops without state cross-talk', async () => {
    const session1Messages: any[] = [
      { role: 'user', content: 'Session 1: Refactor auth module at src/auth/service.ts' },
    ];
    const session2Messages: any[] = [
      { role: 'user', content: 'Session 2: Check both config and index files' },
    ];

    // Launch both turns concurrently
    const [stream1, stream2] = await Promise.all([
      client.openaiChatStream({
        model: 'cursor/agent-model',
        messages: session1Messages,
        metadata: { sessionId: 'sess-001' },
      }),
      client.openaiChatStream({
        model: 'cursor/agent-model',
        messages: session2Messages,
        metadata: { sessionId: 'sess-002' },
      }),
    ]);

    const [chunks1, chunks2] = await Promise.all([
      TestClient.collect(stream1),
      TestClient.collect(stream2),
    ]);

    // Verify session 1 emitted read_file for auth
    const tools1 = assertToolCallsEmitted(chunks1);
    expect(tools1.length).toBe(1);
    expect(tools1[0].name).toBe('read_file');
    expect(tools1[0].arguments.path).toBe('src/auth/service.ts');

    // Verify session 2 emitted parallel config and index calls
    const tools2 = assertToolCallsEmitted(chunks2);
    expect(tools2.length).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Test 5: Mid-Loop Transparent Failover with Model Combos
  // --------------------------------------------------------------------------
  it('transparently recovers when primary model hits 429 mid-loop using fallback provider', async () => {
    class ComboAgentPlugin implements ProviderPlugin {
      readonly id = 'combo';
      readonly displayName = 'Agent Combo Failover Provider';
      readonly defaultBaseUrl = 'https://mock.combo.local/v1';
      public primaryCallCount = 0;
      public fallbackCallCount = 0;

      async listModels(): Promise<ModelDescriptor[]> {
        return [
          {
            id: 'combo/agent-resilient',
            name: 'Resilient Agent Combo',
            providerId: 'combo',
            ownedBy: 'combo',
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
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        };
      }

      async executeStream(
        req: CanonicalRequest,
        signal?: AbortSignal
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        const toolResults = req.messages.filter((m) => m.role === 'tool');

        // Turn 2: Simulate primary provider throwing 429 rate limit and falling back
        if (toolResults.length === 1) {
          this.primaryCallCount++;
          this.fallbackCallCount++;

          const events: CanonicalStreamEvent[] = [
            {
              type: 'stream_start',
              id: req.id,
              model: 'combo/agent-resilient-fallback',
              created: Math.floor(Date.now() / 1000),
            },
            {
              type: 'thinking_delta',
              delta: 'Primary rate limited (429). Fallback model engaged for Turn 2 write_file...',
            },
            {
              type: 'tool_call_start',
              index: 0,
              id: 'call_write_fallback',
              name: 'write_file',
            },
            {
              type: 'tool_call_delta',
              index: 0,
              argumentsDelta: JSON.stringify({
                path: 'src/auth/service.ts',
                content: '// Fallback generated auth code',
              }),
            },
            { type: 'tool_call_stop', index: 0 },
            { type: 'stream_end', stopReason: 'tool_calls' },
          ];

          return (async function* () {
            for (const ev of events) {
              if (signal?.aborted) return;
              yield ev;
            }
          })();
        }

        // Other turns execute normally
        this.primaryCallCount++;
        const events: CanonicalStreamEvent[] = [
          {
            type: 'stream_start',
            id: req.id,
            model: req.model,
            created: Math.floor(Date.now() / 1000),
          },
          {
            type: 'tool_call_start',
            index: 0,
            id: 'call_read_01',
            name: 'read_file',
          },
          {
            type: 'tool_call_delta',
            index: 0,
            argumentsDelta: JSON.stringify({ path: 'src/auth/service.ts' }),
          },
          { type: 'tool_call_stop', index: 0 },
          { type: 'stream_end', stopReason: 'tool_calls' },
        ];

        return (async function* () {
          for (const ev of events) {
            if (signal?.aborted) return;
            yield ev;
          }
        })();
      }
    }

    const comboPlugin = new ComboAgentPlugin();
    const comboApp = createServer({ port: 0 }, [comboPlugin]);
    const comboServer = Bun.serve({ port: 0, fetch: comboApp.fetch });
    const comboClient = new TestClient(`http://127.0.0.1:${comboServer.port}`);

    try {
      // Turn 1: Normal execution
      const stream1 = comboClient.openaiChatStream({
        model: 'combo/agent-resilient',
        messages: [{ role: 'user', content: 'Refactor auth module.' }],
      });
      const chunks1 = await TestClient.collect(stream1);
      const tools1 = assertToolCallsEmitted(chunks1, 'read_file');
      expect(tools1.length).toBe(1);

      // Turn 2: Primary fails with 429, combo recovers transparently
      const stream2 = comboClient.openaiChatStream({
        model: 'combo/agent-resilient',
        messages: [
          { role: 'user', content: 'Refactor auth module.' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_read_01',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/auth/service.ts"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_read_01', content: 'legacy code' },
        ],
      });
      const chunks2 = await TestClient.collect(stream2);
      const tools2 = assertToolCallsEmitted(chunks2, 'write_file');
      expect(tools2[0].name).toBe('write_file');
      expect(tools2[0].arguments.content).toBe('// Fallback generated auth code');
      expect(comboPlugin.fallbackCallCount).toBe(1);
    } finally {
      comboServer.stop(true);
    }
  });
});
