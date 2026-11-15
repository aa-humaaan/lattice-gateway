import { ProviderPlugin, ModelDescriptor } from '../../src/core/types/plugin';
import {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';
import { GatewayError } from '../../src/core/types/errors';

export class MockProviderPlugin implements ProviderPlugin {
  readonly id = 'mock';
  readonly displayName = 'Project Lattice Mock Provider';
  readonly defaultBaseUrl = 'https://mock.lattice.local/v1';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      { id: 'mock-chat', name: 'Mock Chat Model', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-thinking', name: 'Mock Thinking Model', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-tools', name: 'Mock Tool-Calling Model', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-xml-tool', name: 'Mock XML Tool Model', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-error-400', name: 'Mock Error 400', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-error-401', name: 'Mock Error 401', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-error-429', name: 'Mock Error 429', ownedBy: 'lattice-mock', created: 1731693600 },
      { id: 'mock-error-500', name: 'Mock Error 500', ownedBy: 'lattice-mock', created: 1731693600 },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    if (signal?.aborted) throw new Error('Request aborted');

    // Error simulation
    if (req.model === 'mock-error-400') {
      throw new GatewayError(400, 'invalid_request_error', 'Mock provider simulated 400 Bad Request');
    }
    if (req.model === 'mock-error-401') {
      throw new GatewayError(401, 'authentication_error', 'Mock provider simulated 401 Unauthorized');
    }
    if (req.model === 'mock-error-429') {
      throw new GatewayError(429, 'rate_limit_error', 'Mock provider simulated 429 Rate Limit Exceeded', { retryAfter: 20 });
    }
    if (req.model === 'mock-error-500') {
      throw new GatewayError(500, 'api_error', 'Mock provider simulated 500 Server Error');
    }

    // Thinking mode
    if (req.model === 'mock-thinking' || req.thinking?.type === 'enabled') {
      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [
          { type: 'thinking', thinking: 'Let me analyze the problem systematically.', signature: 'sig_mock_proof' },
          { type: 'text', text: 'This is the verified answer after thorough analysis.' },
        ],
        stopReason: 'stop',
        usage: { promptTokens: 25, completionTokens: 40, totalTokens: 65, reasoningTokens: 15 },
      };
    }

    // Tool calling mode
    if (req.model === 'mock-tools' || (req.tools && req.tools.length > 0)) {
      return {
        id: req.id,
        model: req.model,
        created: Math.floor(Date.now() / 1000),
        content: [
          { type: 'text', text: 'I am calling the requested tool.' },
          {
            type: 'tool_use',
            id: 'call_mock_123',
            name: req.tools?.[0]?.function.name || 'run_command',
            input: { command: 'git status' },
          },
        ],
        stopReason: 'tool_calls',
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      };
    }

    // Standard echo / chat
    const lastMsg = req.messages[req.messages.length - 1];
    const userPrompt = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : (Array.isArray(lastMsg?.content) ? (lastMsg.content[0] as any)?.text : 'Hello');

    return {
      id: req.id,
      model: req.model,
      created: Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: `Echo: ${userPrompt}` }],
      stopReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    // Error simulation pre-stream
    if (req.model === 'mock-error-429') {
      throw new GatewayError(429, 'rate_limit_error', 'Mock 429 pre-stream rate limit', { retryAfter: 20 });
    }
    if (req.model === 'mock-error-500') {
      throw new GatewayError(500, 'api_error', 'Mock 500 upstream failure');
    }

    const events: CanonicalStreamEvent[] = [];
    const timestamp = Math.floor(Date.now() / 1000);

    events.push({ type: 'stream_start', id: req.id, model: req.model, created: timestamp });

    if (req.model === 'mock-thinking' || req.thinking?.type === 'enabled') {
      events.push({ type: 'thinking_delta', delta: 'Thinking chunk 1... ' });
      events.push({ type: 'thinking_delta', delta: 'Thinking chunk 2 completed.', signature: 'sig_mock_stream_sig' });
      events.push({ type: 'text_delta', delta: 'Result following deep reasoning.' });
      events.push({
        type: 'usage',
        usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50, reasoningTokens: 15 },
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    } else if (req.model === 'mock-tools') {
      events.push({ type: 'text_delta', delta: 'Initiating tool execution.\n' });
      events.push({ type: 'tool_call_start', index: 0, id: 'call_mock_stream_1', name: 'execute_command' });
      events.push({ type: 'tool_call_delta', index: 0, argumentsDelta: '{"cmd":' });
      events.push({ type: 'tool_call_delta', index: 0, argumentsDelta: '"ls -la"}' });
      events.push({ type: 'tool_call_stop', index: 0 });
      events.push({ type: 'stream_end', stopReason: 'tool_calls' });
    } else if (req.model === 'mock-xml-tool') {
      // Emits raw XML text delta to test XMLToolInterceptor
      events.push({ type: 'text_delta', delta: 'Running shell command...\n' });
      events.push({
        type: 'text_delta',
        delta: '<tool_call>\n<function=execute_shell>\n<parameter=cmd>pwd</parameter>\n</tool_call>',
      });
      events.push({ type: 'stream_end', stopReason: 'stop' });
    } else {
      // Standard chat stream
      events.push({ type: 'text_delta', delta: 'Hello from ' });
      events.push({ type: 'text_delta', delta: 'Lattice Gateway Mock Stream!' });
      events.push({
        type: 'usage',
        usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
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
