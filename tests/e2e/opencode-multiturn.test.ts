import { describe, it, expect } from 'bun:test';
import { createServer } from '../../src/core/server';
import { TestClient } from '../harness/test-client';
import { createMockUpstream } from '../harness/mock-upstream';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';

describe('OpenCode Multi-Turn Tool Loop Simulation', () => {
  it('successfully handles Turn 1 tool call and Turn 2 tool result without dropping turns', async () => {
    const mockUpstream = await createMockUpstream();

    // Turn 1 setup: model decides to call tool read_file
    mockUpstream.configureOpenAIChat({
      toolCalls: [
        {
          id: 'call_test_123',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'src/index.ts' }),
          },
        },
      ],
      content: 'I will read the file.',
      finishReason: 'tool_calls',
      model: 'particle-ai/particle-1:free',
    });

    const originalKilo = globalPluginRegistry.get('kilo');
    const kiloPlugin = new KiloProviderPlugin(mockUpstream.url);
    kiloPlugin.setAccount({
      id: 'acc_kilo_test',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'kilo-test-key' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    });
    globalPluginRegistry.register(kiloPlugin);

    const app = createServer(
      { port: 0 },
      [kiloPlugin, new LatticeComboPlugin()]
    );

    const server = Bun.serve({
      fetch: app.fetch,
      port: 0,
    });

    const client = new TestClient(server.url.origin);

    // Turn 1 from OpenCode: user asks to inspect file
    const turn1Res = await client.openaiChat({
      model: 'lattice/1m-free',
      messages: [{ role: 'user', content: 'Please inspect src/index.ts' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    });

    expect(turn1Res.status).toBe(200);
    const turn1Body = (await turn1Res.json()) as any;
    expect(turn1Body.choices[0].finish_reason).toBe('tool_calls');
    expect(turn1Body.choices[0].message.tool_calls[0].function.name).toBe('read_file');

    // Turn 2 setup: model sees tool output and produces final answer
    mockUpstream.configureOpenAIChat({
      toolCalls: undefined,
      content: 'The file exports ready = true.',
      finishReason: 'stop',
      model: 'particle-ai/particle-1:free',
    });

    // Turn 2 from OpenCode: sends assistant tool call + tool result
    const turn2Res = await client.openaiChat({
      model: 'lattice/lattice/1m-free', // Test double prefix as sent by OpenCode
      messages: [
        { role: 'user', content: 'Please inspect src/index.ts' },
        turn1Body.choices[0].message,
        {
          role: 'tool',
          tool_call_id: 'call_test_123',
          content: 'export const ready = true;',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    });

    expect(turn2Res.status).toBe(200);
    const turn2Body = (await turn2Res.json()) as any;
    expect(turn2Body.choices[0].message.content).toBe('The file exports ready = true.');
    expect(turn2Body.choices[0].finish_reason).toBe('stop');

    // Inspect recorded requests to ensure upstream received clean OpenAI messages
    const recorded = mockUpstream.getRequests();
    expect(recorded.length).toBe(2);

    const turn2Req = recorded[1].body;
    expect(Array.isArray(turn2Req.messages)).toBe(true);

    const lastMsg = turn2Req.messages[turn2Req.messages.length - 1];
    expect(lastMsg.role).toBe('tool');
    expect(lastMsg.tool_call_id).toBe('call_test_123');
    expect(lastMsg.content).toBe('export const ready = true;');

    const assistantMsg = turn2Req.messages[turn2Req.messages.length - 2];
    expect(assistantMsg.role).toBe('assistant');
    expect(Array.isArray(assistantMsg.tool_calls)).toBe(true);
    expect(assistantMsg.tool_calls[0].id).toBe('call_test_123');

    server.stop();
    mockUpstream.stop();
    if (originalKilo) {
      globalPluginRegistry.register(originalKilo);
    } else {
      globalPluginRegistry.unregister('kilo');
    }
  });
});
