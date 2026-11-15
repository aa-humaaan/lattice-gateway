/**
 * Verification Test Suite for Lattice Gateway Test Harness
 * 
 * Verifies that all harness components function with complete fidelity:
 * - Mock Upstream: OpenAI & Anthropic JSON, SSE streaming, thinking blocks, tool calls
 * - Rate limit simulation: HTTP 429 with Retry-After header and cooldown body
 * - Error simulation: 500, 502, 401 with dialect-specific error schemas
 * - Provider auth endpoints: Kilo, Nous, Cline, OpenCode, DeepSeek
 * - Request spy & recorder: captures headers, query params, body, and paths
 * - SSE line buffer resilience: handles chunk boundaries split across TCP fragments
 * - Test Client & Assertions: typed streams, matchers, and gateway runner lifecycle
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from './mock-upstream';
import { TestClient, parseSSEStream } from './test-client';
import { startGateway, getAvailablePort } from './gateway-runner';
import {
  assertOpenAISuccess,
  assertAnthropicSuccess,
  assertThinkingContent,
  assertToolCallsEmitted,
  assertDialectError,
  assertStreamDone,
  assertModelPresent,
  assertRetryAfterHeader,
  assertAnthropicEventSequence,
} from './assertions';

describe('Lattice Gateway E2E Test Harness Verification', () => {
  let mockServer: MockUpstreamServer;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();
    client = new TestClient(mockServer.url);
  });

  afterAll(async () => {
    if (mockServer) {
      await mockServer.stop();
    }
  });

  // 1. Upstream Server & Port Isolation
  it('starts mock upstream on an ephemeral OS-assigned port > 1024', () => {
    expect(mockServer.port).toBeGreaterThan(1024);
    expect(mockServer.url).toBe(`http://127.0.0.1:${mockServer.port}`);
  });

  // 2. OpenAI Dialect: JSON Completion
  it('simulates OpenAI /v1/chat/completions JSON mode with valid schema', async () => {
    mockServer.configureOpenAIChat({
      content: 'Hello from OpenAI mock!',
      model: 'gpt-4o',
      finishReason: 'stop',
    });

    const res = await client.openaiChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Say hello' }],
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    assertOpenAISuccess(body);
    expect(body.choices[0].message.content).toBe('Hello from OpenAI mock!');
    expect(body.model).toBe('gpt-4o');
  });

  // 3. OpenAI Dialect: SSE Streaming with Reasoning and Tool Calls
  it('simulates OpenAI SSE streaming with content, reasoning_content, tool_calls, and [DONE]', async () => {
    mockServer.configureOpenAIChat({
      content: 'Calculated value: 42',
      reasoningContent: 'Step 1: Analyzed input. Step 2: Computed result.',
      toolCalls: [
        {
          id: 'call_calc_1',
          type: 'function',
          function: { name: 'calculate', arguments: '{"expression":"6*7"}' },
        },
      ],
      finishReason: 'tool_calls',
    });

    const chunks = await TestClient.collect(
      client.openaiChatStream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Compute 6*7' }],
      })
    );

    expect(chunks.length).toBeGreaterThan(1);
    assertStreamDone(chunks);

    // Verify reasoning content assertion
    const thinking = assertThinkingContent(chunks, 10);
    expect(thinking).toContain('Analyzed input');

    // Verify tool calls assertion
    const tools = assertToolCallsEmitted(chunks, 'calculate');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('calculate');

    // Verify content chunks
    const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
    expect(textChunks.length).toBeGreaterThan(0);
    expect(textChunks[0].choices[0].delta.content).toBe('Calculated value: 42');
  });

  // 4. Anthropic Dialect: JSON Messages
  it('simulates Anthropic /v1/messages JSON mode with thinking blocks', async () => {
    mockServer.configureAnthropicMessages({
      text: 'Hello from Claude mock!',
      thinking: 'Claude deep reasoning block...',
      model: 'claude-3-7-sonnet',
      stopReason: 'end_turn',
    });

    const res = await client.anthropicMessages({
      model: 'claude-3-7-sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    assertAnthropicSuccess(body);

    const thinking = assertThinkingContent(body, 5);
    expect(thinking).toBe('Claude deep reasoning block...');

    const textBlock = body.content.find((b: any) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toBe('Hello from Claude mock!');
  });

  // 5. Anthropic Dialect: SSE Streaming with 7 Canonical Events & Tool Use
  it('simulates Anthropic SSE streaming with full 7-event sequence and thinking_delta', async () => {
    mockServer.configureAnthropicMessages({
      text: 'Anthropic streaming answer',
      thinking: 'Step-by-step thinking token sequence.',
      toolUse: {
        id: 'toolu_search_1',
        name: 'web_search',
        input: { query: 'bun test runner' },
      },
      stopReason: 'tool_use',
    });

    const events = await TestClient.collect(
      client.anthropicMessagesStream({
        model: 'claude-3-7-sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Search bun docs' }],
      })
    );

    expect(events.length).toBeGreaterThan(5);
    assertAnthropicEventSequence(events);
    assertStreamDone(events);

    // Verify thinking tokens in stream
    const thinking = assertThinkingContent(events, 10);
    expect(thinking).toContain('Step-by-step thinking');

    // Verify tool use in stream
    const tools = assertToolCallsEmitted(events, 'web_search');
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('web_search');
    expect(tools[0].arguments).toEqual({ query: 'bun test runner' });
  });

  // 6. Rate Limit (HTTP 429) Simulation
  it('simulates 429 rate limit with Retry-After header and recovers on subsequent calls', async () => {
    mockServer.reset();
    mockServer.simulateRateLimit({
      retryAfterSeconds: 7,
      message: 'Rate limit exceeded: 50 requests per minute allowed',
      count: 1,
    });

    // First call: Should fail with 429
    const res1 = await client.openaiChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Call 1' }],
    });

    expect(res1.status).toBe(429);
    assertRetryAfterHeader(res1.headers, 7);
    const errBody: any = await res1.json();
    assertDialectError(errBody, 'openai', 429);
    expect(errBody.error.message).toContain('Rate limit exceeded');

    // Second call: Rate limit was configured with count: 1, so this call should succeed 200 OK
    const res2 = await client.openaiChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Call 2' }],
    });
    expect(res2.status).toBe(200);
  });

  // 7. Error Status Simulation (500, 502, 401)
  it('simulates HTTP 500, 502, 401 errors with dialect-compliant envelopes', async () => {
    mockServer.reset();

    // 502 Bad Gateway (OpenAI dialect)
    mockServer.simulateError({
      status: 502,
      message: 'Bad gateway from upstream cluster',
      dialect: 'openai',
    });
    const res502 = await client.openaiChat({ model: 'gpt-4o', messages: [] });
    expect(res502.status).toBe(502);
    const body502 = await res502.json();
    assertDialectError(body502, 'openai', 502);

    // 401 Unauthorized (Anthropic dialect)
    mockServer.simulateError({
      status: 401,
      message: 'Invalid API key provided',
      dialect: 'anthropic',
    });
    const res401 = await client.anthropicMessages({ model: 'claude-3-7-sonnet', messages: [] });
    expect(res401.status).toBe(401);
    const body401 = await res401.json();
    assertDialectError(body401, 'anthropic', 401);
  });

  // 8. Provider Auth & Service Endpoints
  it('simulates Kilo Code OAuth device code and token exchange', async () => {
    // 1. Device Code
    const devRes = await fetch(`${mockServer.url}/api/v1/auth/device/code`, { method: 'POST' });
    expect(devRes.status).toBe(200);
    const devData: any = await devRes.json();
    expect(devData.user_code).toBe('KILO-7890');
    expect(devData.device_code).toBeDefined();

    // 2. Token Exchange
    const tokenRes = await fetch(`${mockServer.url}/api/v1/auth/token`, { method: 'POST' });
    expect(tokenRes.status).toBe(200);
    const tokenData: any = await tokenRes.json();
    expect(tokenData.access_token).toBe('kilo_access_token_mock');
  });

  it('simulates Nous Research Portal OAuth endpoints', async () => {
    const authRes = await fetch(`${mockServer.url}/v1/portal/auth`, { method: 'POST' });
    expect(authRes.status).toBe(200);
    const authData: any = await authRes.json();
    expect(authData.auth_url).toContain('portal.nousresearch.com');

    const tokenRes = await fetch(`${mockServer.url}/v1/portal/token`, { method: 'POST' });
    expect(tokenRes.status).toBe(200);
    const tokenData: any = await tokenRes.json();
    expect(tokenData.access_token).toBe('sk-nous-valid-token-mock');
  });

  it('simulates Cline WorkOS token refresh and user profile', async () => {
    const refRes = await fetch(`${mockServer.url}/api/v1/auth/refresh`, { method: 'POST' });
    expect(refRes.status).toBe(200);
    const refData: any = await refRes.json();
    expect(refData.access_token).toBe('cline_refreshed_access_token');

    const userRes = await fetch(`${mockServer.url}/api/v1/auth/user`, { method: 'GET' });
    expect(userRes.status).toBe(200);
    const userData: any = await userRes.json();
    expect(userData.email).toBe('cline_user@example.com');
  });

  it('simulates OpenCode gate tools discovery', async () => {
    const res = await fetch(`${mockServer.url}/api/gate/tools`, { method: 'GET' });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data.tools)).toBeTrue();
    expect(data.tools[0].name).toBe('execute_command');
  });

  it('simulates DeepSeek session challenge and proof-of-work verification', async () => {
    const chalRes = await fetch(`${mockServer.url}/api/v1/session/challenge`, { method: 'POST' });
    expect(chalRes.status).toBe(200);
    const chalData: any = await chalRes.json();
    expect(chalData.challenge).toContain('ds_nonce');

    const verifyRes = await fetch(`${mockServer.url}/api/v1/session/verify`, {
      method: 'POST',
      body: JSON.stringify({ solution: 'valid_nonce_result' }),
    });
    expect(verifyRes.status).toBe(200);
    const verifyData: any = await verifyRes.json();
    expect(verifyData.success).toBeTrue();
    expect(verifyData.session_token).toBe('ds_session_cookie_mock');
  });

  // 9. Request Recorder & Spy
  it('records incoming requests with full fidelity for assertion testing', async () => {
    mockServer.reset();
    const testHeaderValue = 'custom-test-agent/2.0';

    await client.openaiChat(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Spy check' }] },
      { headers: { 'X-Custom-Agent': testHeaderValue } }
    );

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);

    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers['x-custom-agent']).toBe(testHeaderValue);
    expect(req.body.model).toBe('gpt-4o');
    expect(req.body.messages[0].content).toBe('Spy check');
  });

  // 10. Robust SSE Parser: Chunk Slicing & Boundary Fragmentation
  it('correctly reassembles SSE chunks split arbitrarily across network read chunks', async () => {
    const rawSSEStream = [
      'event: message_st',
      'art\ndata: {"type":"message_start","id":"123"}\n\n: ping\n\nevent: content_blo',
      'ck_delta\ndata: {"type":"content_block_delta"',
      ',"delta":{"type":"text_delta","text":"fragmented message"}}\n\nevent: message_stop\ndata: {}\n\n',
    ];

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        for (const fragment of rawSSEStream) {
          controller.enqueue(enc.encode(fragment));
        }
        controller.close();
      },
    });

    const parsedEvents: any[] = [];
    for await (const evt of parseSSEStream(stream)) {
      parsedEvents.push(evt);
    }

    expect(parsedEvents.length).toBe(3);
    expect(parsedEvents[0].event).toBe('message_start');
    expect(parsedEvents[1].event).toBe('content_block_delta');
    expect(JSON.parse(parsedEvents[1].data).delta.text).toBe('fragmented message');
    expect(parsedEvents[2].event).toBe('message_stop');
  });

  // 10b. Raw Custom Stream Simulation (XML tool calling simulation)
  it('simulates raw custom stream chunks for XML tool interceptor testing', async () => {
    mockServer.reset();
    const xmlChunks = [
      'data: {"id":"chatcmpl-xml","choices":[{"delta":{"content":"<tool_call><function=run_command>"}}]}\n\n',
      'data: {"id":"chatcmpl-xml","choices":[{"delta":{"content":"<parameter=cmd>bun test</parameter></function></tool_call>"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    mockServer.simulateRawStream(xmlChunks);

    const chunks = await TestClient.collect(
      client.openaiChatStream({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Run test' }],
      })
    );

    expect(chunks.length).toBe(2);
    expect(chunks[0].choices[0].delta.content).toContain('<tool_call>');
    expect(chunks[1].choices[0].delta.content).toContain('bun test');
  });

  // 11. Models Catalog & Matcher Assertion
  it('returns models catalog and passes assertModelPresent matcher', async () => {
    const res = await client.getModels();
    expect(res.status).toBe(200);
    const catalog = await res.json();
    assertModelPresent(catalog, 'mock-gpt-4o');
    assertModelPresent(catalog, 'claude-3-7-sonnet');
    assertModelPresent(catalog, 'kilo/free-model:free');
    assertModelPresent(catalog, 'hermes-3-llama-3.1-8b');
  });

  // 12. Gateway Runner Lifecycle & Ephemeral Port Isolation
  it('probes ephemeral port and launches gateway runner instance with isolated data dir', async () => {
    const freePort = getAvailablePort();
    expect(freePort).toBeGreaterThan(1024);

    const instance = await startGateway({ port: freePort, mode: 'in-process' });
    expect(instance.baseUrl).toBe(`http://127.0.0.1:${freePort}`);
    expect(instance.port).toBe(freePort);

    const runnerClient = new TestClient(instance.baseUrl);
    const health = await runnerClient.getHealth();
    expect(health.status).toBe(200);
    const healthJson: any = await health.json();
    expect(['ok', 'healthy']).toContain(healthJson.status);

    await instance.stop();
  });
});
