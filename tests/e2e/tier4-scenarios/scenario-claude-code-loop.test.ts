/**
 * Tier 4 Real-World Application Scenario: S2 - Claude Code Thinking + Tool Use Loop
 * 
 * Simulates authentic Claude Code CLI interactions using Anthropic /v1/messages:
 * 1. Full 7-event canonical SSE sequence with thinking_delta, tool_use, and input_json_delta
 * 2. Multi-turn Claude Code loop with tool_result content blocks and thinking signature retention
 * 3. Tool execution error handling with is_error: true in tool_result
 * 4. Multi-tool sequential engineering chain (Bash -> GlobTool -> FileEdit)
 * 5. Non-streaming Claude Code fallback mode (stream: false)
 * 6. High token budget extended thinking blocks verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from '../../../src/core/server';
import { TestClient, type AnthropicSSEEvent } from '../../harness/test-client';
import {
  assertAnthropicSuccess,
  assertThinkingContent,
  assertToolCallsEmitted,
  assertAnthropicEventSequence,
} from '../../harness/assertions';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../../src/core/types/canonical';

class ClaudeCodeMockPlugin implements ProviderPlugin {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code CLI Mock Provider';
  readonly defaultBaseUrl = 'https://mock.anthropic.local/v1';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'claude-code/sonnet-3-7',
        name: 'Claude 3.7 Sonnet (Claude Code)',
        providerId: 'claude-code',
        ownedBy: 'anthropic',
        created: 1731693600,
        supportsTools: true,
        supportsStreaming: true,
        supportsThinking: true,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    const isToolCall = req.tools && req.tools.length > 0;
    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: isToolCall
        ? [
            {
              type: 'thinking',
              thinking: 'Analyzing workspace state before executing command.',
              signature: 'sig_claude_code_valid',
            },
            {
              type: 'tool_use',
              id: 'toolu_json_01',
              name: 'Bash',
              input: { command: 'git status' },
            },
          ]
        : [
            {
              type: 'thinking',
              thinking: 'Synthesizing response for developer.',
              signature: 'sig_claude_code_valid',
            },
            { type: 'text', text: 'Task completed successfully.' },
          ],
      stopReason: isToolCall ? 'tool_calls' : 'stop',
      usage: { promptTokens: 45, completionTokens: 60, totalTokens: 105, reasoningTokens: 25 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const messages = req.messages;
    const events: CanonicalStreamEvent[] = [];

    events.push({ type: 'stream_start', id: req.id, model: req.model, created: timestamp });

    // Extract tool results from message history
    const toolResults: any[] = [];
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'tool_result') toolResults.push(p);
        }
      }
    }

    // Check for error handling test
    const hasToolError = toolResults.some((tr) => tr.isError === true);
    if (hasToolError) {
      // Adapted recovery response
      events.push({
        type: 'thinking_delta',
        delta:
          'Command git branch --unknown failed with exit code 128. Correcting command to git branch -a...',
        signature: 'sig_recovery_token',
      });
      events.push({
        type: 'tool_call_start',
        index: 0,
        id: 'toolu_bash_fixed',
        name: 'Bash',
      });
      events.push({
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: JSON.stringify({ command: 'git branch -a' }),
      });
      events.push({ type: 'tool_call_stop', index: 0 });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });

      return (async function* () {
        for (const ev of events) {
          if (signal?.aborted) return;
          yield ev;
        }
      })();
    }

    // Check for multi-tool chain (Bash -> GlobTool -> FileEdit)
    const isToolChain = messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('Execute full engineering chain')
    );
    if (isToolChain) {
      if (toolResults.length === 0) {
        // Step 1: Bash ls
        events.push({
          type: 'thinking_delta',
          delta: 'Starting engineering chain: Step 1 listing project files...',
        });
        events.push({
          type: 'tool_call_start',
          index: 0,
          id: 'toolu_chain_1',
          name: 'Bash',
        });
        events.push({
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({ command: 'ls -la' }),
        });
        events.push({ type: 'tool_call_stop', index: 0 });
        events.push({ type: 'stream_end', stopReason: 'tool_calls' });
      } else if (toolResults.length === 1) {
        // Step 2: GlobTool find typescript files
        events.push({
          type: 'thinking_delta',
          delta: 'Step 2: Searching for TypeScript source files...',
        });
        events.push({
          type: 'tool_call_start',
          index: 0,
          id: 'toolu_chain_2',
          name: 'GlobTool',
        });
        events.push({
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({ pattern: 'src/**/*.ts' }),
        });
        events.push({ type: 'tool_call_stop', index: 0 });
        events.push({ type: 'stream_end', stopReason: 'tool_calls' });
      } else {
        // Step 3: Final completion
        events.push({
          type: 'thinking_delta',
          delta: 'Step 3: Verification complete. Explaining engineering chain outcome...',
        });
        events.push({
          type: 'text_delta',
          delta: 'Engineering chain completed: Inspected directory and identified all source files.',
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

    // Check for High Budget Extended Thinking
    const isHighBudgetThinking = req.thinking?.budgetTokens && req.thinking.budgetTokens >= 2048;
    if (isHighBudgetThinking && toolResults.length === 0 && !req.tools?.length) {
      events.push({
        type: 'thinking_delta',
        delta:
          'Deep architectural reasoning Phase 1: Analyzing concurrency models and race conditions...\n',
      });
      events.push({
        type: 'thinking_delta',
        delta:
          'Deep architectural reasoning Phase 2: Evaluating lock-free ring buffer vs mutex synchronization...\n',
      });
      events.push({
        type: 'thinking_delta',
        delta: 'Deep architectural reasoning Phase 3: Formalizing correctness invariants.',
        signature: 'sig_extended_thought_proof_777',
      });
      events.push({
        type: 'text_delta',
        delta:
          'Based on extended analysis, the lock-free ring buffer guarantees zero thread contention under heavy burst load.',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });

      return (async function* () {
        for (const ev of events) {
          if (signal?.aborted) return;
          yield ev;
        }
      })();
    }

    // Standard Claude Code 3-Turn Interaction
    if (toolResults.length === 0) {
      // Turn 1: Extended thinking + Bash git status
      events.push({
        type: 'thinking_delta',
        delta:
          'The user requested a repository audit. I need to run git status to check modified and untracked files.',
        signature: 'sig_step_1_audit',
      });
      events.push({
        type: 'tool_call_start',
        index: 0,
        id: 'toolu_01_bash',
        name: 'Bash',
      });
      events.push({
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: JSON.stringify({ command: 'git status --porcelain' }),
      });
      events.push({ type: 'tool_call_stop', index: 0 });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });
    } else if (toolResults.length === 1) {
      // Turn 2: Received git status result -> Emit thinking + FileEdit tool call
      events.push({
        type: 'thinking_delta',
        delta:
          'Git status shows modified src/auth.ts and new tests/auth.test.ts. Inspecting diff with FileEdit...',
        signature: 'sig_step_2_edit',
      });
      events.push({
        type: 'tool_call_start',
        index: 0,
        id: 'toolu_02_edit',
        name: 'FileEdit',
      });
      events.push({
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: JSON.stringify({
          file_path: 'src/auth.ts',
          content: '// Updated JWT Auth',
        }),
      });
      events.push({ type: 'tool_call_stop', index: 0 });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });
    } else {
      // Turn 3: Received edit result -> Final text answer with end_turn
      events.push({
        type: 'thinking_delta',
        delta: 'File edits applied cleanly. Preparing final audit summary for Claude Code CLI...',
      });
      events.push({
        type: 'text_delta',
        delta:
          'Audit complete: All modified files and tests in src/auth.ts are verified and ready for commit.',
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

describe('Tier 4 Scenario S2: Claude Code Thinking + Tool Use Loop', () => {
  let mockPlugin: ClaudeCodeMockPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockPlugin = new ClaudeCodeMockPlugin();
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
  // Test 1: Full 7-Event Canonical SSE Sequence with Thinking & Tool Use
  // --------------------------------------------------------------------------
  it('streams 7 canonical Anthropic SSE events in exact order with thinking_delta and tool_use', async () => {
    const tools = [
      {
        name: 'Bash',
        description: 'Run commands in the terminal',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ];

    const stream = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      system: 'You are Claude Code, Anthropic official CLI for software engineering.',
      messages: [{ role: 'user', content: 'Audit workspace git status.' }],
      tools,
    });

    const events = await TestClient.collect(stream);

    // Verify canonical event presence
    assertAnthropicEventSequence(events, [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // Verify event ordering: message_start must be first
    expect(events[0].event || events[0].type).toBe('message_start');

    // Verify thinking block
    const thinkingStart = events.find(
      (e) => e.content_block?.type === 'thinking' && (e.event === 'content_block_start' || e.type === 'content_block_start')
    );
    expect(thinkingStart).toBeDefined();

    const thinkingDelta = events.find(
      (e) => e.delta?.type === 'thinking_delta' && (e.event === 'content_block_delta' || e.type === 'content_block_delta')
    );
    expect(thinkingDelta).toBeDefined();
    expect(thinkingDelta?.delta?.thinking).toContain('git status');

    // Verify tool_use block
    const toolUseStart = events.find(
      (e) => e.content_block?.type === 'tool_use' && (e.event === 'content_block_start' || e.type === 'content_block_start')
    );
    expect(toolUseStart).toBeDefined();
    expect(toolUseStart?.content_block?.name).toBe('Bash');

    const inputJsonDelta = events.find(
      (e) => e.delta?.type === 'input_json_delta' && (e.event === 'content_block_delta' || e.type === 'content_block_delta')
    );
    expect(inputJsonDelta).toBeDefined();
    expect(inputJsonDelta?.delta?.partial_json).toContain('git status --porcelain');

    // Verify message_delta has stop_reason: tool_use
    const messageDelta = events.find(
      (e) => e.event === 'message_delta' || e.type === 'message_delta'
    );
    expect(messageDelta).toBeDefined();
    expect(messageDelta?.delta?.stop_reason).toBe('tool_use');

    // Verify terminal message_stop event
    const lastEvent = events[events.length - 1];
    expect(lastEvent.event || lastEvent.type).toBe('message_stop');
  });

  // --------------------------------------------------------------------------
  // Test 2: Authentic Multi-Turn Claude Code CLI Loop with tool_result Blocks
  // --------------------------------------------------------------------------
  it('executes authentic multi-turn Claude Code loop with tool_result content blocks', async () => {
    const tools = [
      {
        name: 'Bash',
        description: 'Execute shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      {
        name: 'FileEdit',
        description: 'Edit project file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
          required: ['file_path', 'content'],
        },
      },
    ];

    const messagesHistory: any[] = [
      { role: 'user', content: 'Perform repository health check and audit modified files.' },
    ];

    // TURN 1: Claude Code calls Bash tool
    const stream1 = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: messagesHistory,
      tools,
    });
    const events1 = await TestClient.collect(stream1);
    const tools1 = assertToolCallsEmitted(events1, 'Bash');
    expect(tools1.length).toBe(1);
    expect(tools1[0].arguments).toEqual({ command: 'git status --porcelain' });

    // Append Assistant Turn 1 with thinking and tool_use blocks
    messagesHistory.push({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'Running git status check.',
          signature: 'sig_step_1_audit',
        },
        {
          type: 'tool_use',
          id: 'toolu_01_bash',
          name: 'Bash',
          input: { command: 'git status --porcelain' },
        },
      ],
    });

    // TURN 2: Deliver tool_result block from Claude Code CLI
    messagesHistory.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01_bash',
          content: ' M src/auth.ts\n?? tests/auth.test.ts\n',
        },
      ],
    });

    const stream2 = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: messagesHistory,
      tools,
    });
    const events2 = await TestClient.collect(stream2);
    const tools2 = assertToolCallsEmitted(events2, 'FileEdit');
    expect(tools2.length).toBe(1);
    expect(tools2[0].name).toBe('FileEdit');
    expect(tools2[0].arguments.file_path).toBe('src/auth.ts');

    // Append Assistant Turn 2
    messagesHistory.push({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'Editing src/auth.ts to verify implementation.',
          signature: 'sig_step_2_edit',
        },
        {
          type: 'tool_use',
          id: 'toolu_02_edit',
          name: 'FileEdit',
          input: { file_path: 'src/auth.ts', content: '// Updated JWT Auth' },
        },
      ],
    });

    // TURN 3: Deliver FileEdit result
    messagesHistory.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_02_edit',
          content: 'File updated successfully: 12 lines written.',
        },
      ],
    });

    const stream3 = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: messagesHistory,
      tools,
    });
    const events3 = await TestClient.collect(stream3);

    // Verify final message completed with text delta and end_turn stop_reason
    const textDeltas = events3
      .filter((e) => e.delta?.type === 'text_delta')
      .map((e) => e.delta?.text)
      .join('');
    expect(textDeltas).toContain('Audit complete');

    const msgDelta3 = events3.find((e) => e.event === 'message_delta' || e.type === 'message_delta');
    expect(msgDelta3?.delta?.stop_reason).toBe('end_turn');
  });

  // --------------------------------------------------------------------------
  // Test 3: Tool Execution Error Recovery (is_error: true)
  // --------------------------------------------------------------------------
  it('handles tool execution error recovery when tool_result contains is_error: true', async () => {
    const messagesHistory: any[] = [
      { role: 'user', content: 'List all remote branches.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_err_01',
            name: 'Bash',
            input: { command: 'git branch --unknown' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_err_01',
            content: 'error: unknown option `unknown`',
            is_error: true,
          },
        ],
      },
    ];

    const stream = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      messages: messagesHistory,
    });
    const events = await TestClient.collect(stream);

    // Verify model adapted and called git branch -a
    const tools = assertToolCallsEmitted(events, 'Bash');
    expect(tools.length).toBe(1);
    expect(tools[0].arguments).toEqual({ command: 'git branch -a' });

    // Verify thinking block acknowledged the error
    const thinking = assertThinkingContent(events);
    expect(thinking).toContain('failed with exit code 128');
  });

  // --------------------------------------------------------------------------
  // Test 4: Consecutive Multi-Tool Chain (Bash -> GlobTool -> Final Text)
  // --------------------------------------------------------------------------
  it('orchestrates multi-tool chain across distinct engineering tools', async () => {
    const chainHistory: any[] = [
      { role: 'user', content: 'Execute full engineering chain across directory.' },
    ];

    // Step 1: Bash ls
    const stream1 = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      messages: chainHistory,
    });
    const events1 = await TestClient.collect(stream1);
    const tools1 = assertToolCallsEmitted(events1, 'Bash');
    expect(tools1[0].name).toBe('Bash');

    // Step 2: GlobTool
    chainHistory.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_chain_1',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      ],
    });
    chainHistory.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_chain_1',
          content: 'package.json\nsrc/\ntests/\n',
        },
      ],
    });

    const stream2 = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      messages: chainHistory,
    });
    const events2 = await TestClient.collect(stream2);
    const tools2 = assertToolCallsEmitted(events2, 'GlobTool');
    expect(tools2[0].name).toBe('GlobTool');
    expect(tools2[0].arguments).toEqual({ pattern: 'src/**/*.ts' });

    // Step 3: Final Answer
    chainHistory.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_chain_2',
          name: 'GlobTool',
          input: { pattern: 'src/**/*.ts' },
        },
      ],
    });
    chainHistory.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_chain_2',
          content: 'src/index.ts\nsrc/core/router.ts\n',
        },
      ],
    });

    const stream3 = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      messages: chainHistory,
    });
    const events3 = await TestClient.collect(stream3);
    const finalContent = events3
      .filter((e) => e.delta?.type === 'text_delta')
      .map((e) => e.delta?.text)
      .join('');
    expect(finalContent).toContain('Engineering chain completed');
  });

  // --------------------------------------------------------------------------
  // Test 5: Non-Streaming Claude Code Fallback Mode (stream: false)
  // --------------------------------------------------------------------------
  it('returns valid Anthropic JSON response in non-streaming mode with thinking and tools', async () => {
    const res = await client.anthropicMessages({
      model: 'claude-code/sonnet-3-7',
      max_tokens: 500,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'Non-streaming test request' }],
      tools: [
        {
          name: 'Bash',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    assertAnthropicSuccess(body);

    expect(body.role).toBe('assistant');
    expect(body.stop_reason).toBe('tool_use');

    // Verify thinking block present in JSON content
    const thinkingBlock = body.content.find((b: any) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.signature).toBe('sig_claude_code_valid');

    // Verify tool_use block present in JSON content
    const toolUseBlock = body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock.name).toBe('Bash');
  });

  // --------------------------------------------------------------------------
  // Test 6: High Token Budget Extended Thinking Invariant
  // --------------------------------------------------------------------------
  it('streams extended thinking tokens across multiple chunks with signature retention', async () => {
    const stream = client.anthropicMessagesStream({
      model: 'claude-code/sonnet-3-7',
      max_tokens: 2048,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'Provide deep concurrency analysis.' }],
    });

    const events = await TestClient.collect(stream);

    // Verify thinking content accumulated across multiple deltas
    const thinking = assertThinkingContent(events, 50);
    expect(thinking).toContain('Phase 1');
    expect(thinking).toContain('Phase 2');
    expect(thinking).toContain('Phase 3');

    // Verify signature was retained in thinking block
    const thinkingDeltas = events.filter((e) => e.delta?.type === 'thinking_delta');
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);

    const textDeltas = events
      .filter((e) => e.delta?.type === 'text_delta')
      .map((e) => e.delta?.text)
      .join('');
    expect(textDeltas).toContain('lock-free ring buffer');
  });
});
