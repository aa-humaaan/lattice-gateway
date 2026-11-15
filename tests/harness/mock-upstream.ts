/**
 * Mock Upstream Server for Lattice Gateway E2E Testing
 * 
 * Programmable mock server using native Bun.serve({ port: 0 }) with ephemeral port binding.
 * Simulates:
 * - OpenAI /v1/chat/completions (JSON & SSE streaming with reasoning_content and tool_calls)
 * - Anthropic /v1/messages (JSON & SSE with full 7-event sequence, thinking_delta, tool_use)
 * - HTTP error status codes (400, 401, 404, 429 with Retry-After, 500, 502)
 * - Provider-specific endpoints: Kilo OAuth, Nous Portal, Cline WorkOS, OpenCode gate tools, DeepSeek session challenge
 * - Request spy / recorder for inspecting forwarded requests
 */

export interface RecordedRequest {
  id: string;
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: any;
  rawBody: string;
  timestamp: number;
}

export interface OpenAIChatMockOptions {
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  finishReason?: string;
  model?: string;
  delayMs?: number;
}

export interface AnthropicMessagesMockOptions {
  text?: string;
  thinking?: string;
  toolUse?: {
    id: string;
    name: string;
    input: Record<string, any>;
  };
  stopReason?: string;
  model?: string;
  delayMs?: number;
}

export interface RateLimitOptions {
  retryAfterSeconds?: number;
  message?: string;
  dialect?: 'openai' | 'anthropic';
  count?: number; // Number of times to return 429 before returning to normal (default: 1)
}

export interface ErrorResponseOptions {
  status: number;
  message?: string;
  code?: string | number;
  type?: string;
  dialect?: 'openai' | 'anthropic';
  count?: number;
}

export type RequestHandler = (
  req: Request,
  body: any,
  recorded: RecordedRequest
) => Response | Promise<Response> | undefined | null;

export interface MockUpstreamServer {
  readonly url: string;
  readonly port: number;
  readonly server: any;
  stop(): Promise<void>;
  reset(): void;
  getRequests(): RecordedRequest[];
  findRequests(predicate: (req: RecordedRequest) => boolean): RecordedRequest[];
  clearRequests(): void;

  // Custom route handlers
  onOpenAIChat(handler: (req: Request, body: any) => Response | Promise<Response>): void;
  onAnthropicMessages(handler: (req: Request, body: any) => Response | Promise<Response>): void;
  onPath(path: string, handler: (req: Request, body: any) => Response | Promise<Response>): void;
  onRequest(handler: RequestHandler): void;

  // Simulation controls
  simulateRateLimit(options?: RateLimitOptions): void;
  simulateError(options: ErrorResponseOptions): void;
  simulateRawStream(chunks: string[], delayMs?: number): void;
  configureOpenAIChat(options: OpenAIChatMockOptions): void;
  configureAnthropicMessages(options: AnthropicMessagesMockOptions): void;
}

export interface CreateMockUpstreamOptions {
  port?: number;
  openAIDefaults?: OpenAIChatMockOptions;
  anthropicDefaults?: AnthropicMessagesMockOptions;
}

export async function createMockUpstream(
  options: CreateMockUpstreamOptions = {}
): Promise<MockUpstreamServer> {
  let recordedRequests: RecordedRequest[] = [];
  let customHandlers: RequestHandler[] = [];
  const pathHandlers = new Map<string, (req: Request, body: any) => Response | Promise<Response>>();

  let rateLimitConfig: RateLimitOptions | null = null;
  let rateLimitCountRemaining = 0;

  let errorConfig: ErrorResponseOptions | null = null;
  let errorCountRemaining = 0;

  let rawStreamChunks: string[] | null = null;
  let rawStreamDelayMs = 0;

  function createRawStreamResponse(chunks: string[], delayMs = 0): Response {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  let openAIOpts: OpenAIChatMockOptions = {
    content: 'Hello! I am a simulated response from the mock upstream.',
    finishReason: 'stop',
    model: 'mock-gpt-4o',
    ...options.openAIDefaults,
  };

  let anthropicOpts: AnthropicMessagesMockOptions = {
    text: 'Hello! I am a simulated Claude response from the mock upstream.',
    stopReason: 'end_turn',
    model: 'claude-3-7-sonnet',
    ...options.anthropicDefaults,
  };

  // Helper to build OpenAI SSE stream
  function createOpenAISSEStream(body: any, opts: OpenAIChatMockOptions): Response {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const id = `chatcmpl-${Math.random().toString(36).substring(2, 10)}`;
        const created = Math.floor(Date.now() / 1000);
        const model = body?.model || opts.model || 'mock-gpt-4o';
        const delay = opts.delayMs ?? 0;

        // 1. Initial role chunk
        const roleChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));

        // 2. Reasoning chunk if present
        if (opts.reasoningContent) {
          const reasoningChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: opts.reasoningContent },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(reasoningChunk)}\n\n`));
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        // 3. Content chunk if present
        if (opts.content) {
          const contentChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: opts.content },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        // 4. Tool calls chunk if present
        if (opts.toolCalls && opts.toolCalls.length > 0) {
          const toolCallsChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: opts.toolCalls.map((tc, idx) => ({
                    index: idx,
                    id: tc.id,
                    type: tc.type,
                    function: tc.function,
                  })),
                },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolCallsChunk)}\n\n`));
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        // 5. Final finish chunk
        const finishReason = opts.finishReason || (opts.toolCalls?.length ? 'tool_calls' : 'stop');
        const finalChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));

        // 6. [DONE] terminal chunk
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Helper to build Anthropic SSE stream
  function createAnthropicSSEStream(body: any, opts: AnthropicMessagesMockOptions): Response {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const id = `msg_${Math.random().toString(36).substring(2, 12)}`;
        const model = body?.model || opts.model || 'claude-3-7-sonnet';
        const delay = opts.delayMs ?? 0;
        let blockIndex = 0;

        // 1. message_start
        const messageStart = {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 1 },
          },
        };
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));

        // 2. thinking block if present
        if (opts.thinking) {
          const thinkingIndex = blockIndex++;
          controller.enqueue(
            encoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: thinkingIndex,
                content_block: { type: 'thinking', thinking: '' },
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          controller.enqueue(
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: thinkingIndex,
                delta: { type: 'thinking_delta', thinking: opts.thinking },
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          controller.enqueue(
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: thinkingIndex,
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        // 3. text block if present
        if (opts.text !== undefined) {
          const textIndex = blockIndex++;
          controller.enqueue(
            encoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: textIndex,
                content_block: { type: 'text', text: '' },
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          controller.enqueue(
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'text_delta', text: opts.text },
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          controller.enqueue(
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: textIndex,
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        // 4. tool_use block if present
        if (opts.toolUse) {
          const toolIndex = blockIndex++;
          controller.enqueue(
            encoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: toolIndex,
                content_block: {
                  type: 'tool_use',
                  id: opts.toolUse.id,
                  name: opts.toolUse.name,
                  input: {},
                },
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          const jsonStr = JSON.stringify(opts.toolUse.input);
          controller.enqueue(
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: toolIndex,
                delta: { type: 'input_json_delta', partial_json: jsonStr },
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          controller.enqueue(
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: toolIndex,
              })}\n\n`
            )
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        // 5. message_delta
        const stopReason = opts.stopReason || (opts.toolUse ? 'tool_use' : 'end_turn');
        controller.enqueue(
          encoder.encode(
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: 30 },
            })}\n\n`
          )
        );

        // 6. message_stop
        controller.enqueue(
          encoder.encode(
            `event: message_stop\ndata: ${JSON.stringify({
              type: 'message_stop',
            })}\n\n`
          )
        );

        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;

      // Parse headers
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      // Parse query params
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      // Read raw body
      let rawBody = '';
      let parsedBody: any = null;
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          rawBody = await req.text();
          if (rawBody.trim()) {
            parsedBody = JSON.parse(rawBody);
          }
        } catch {
          parsedBody = rawBody;
        }
      }

      // Record request
      const recorded: RecordedRequest = {
        id: `req_${Math.random().toString(36).substring(2, 10)}`,
        method,
        path,
        url: req.url,
        headers,
        query,
        body: parsedBody,
        rawBody,
        timestamp: Date.now(),
      };
      recordedRequests.push(recorded);

      // 1. Check custom general request handlers
      for (const handler of customHandlers) {
        const handled = await handler(req, parsedBody, recorded);
        if (handled) return handled;
      }

      // 2. Check path-specific custom handlers
      if (pathHandlers.has(path)) {
        const handler = pathHandlers.get(path)!;
        const res = await handler(req, parsedBody);
        if (res) return res;
      }

      // 3. Check simulated 429 rate limit
      if (rateLimitConfig && rateLimitCountRemaining > 0) {
        rateLimitCountRemaining--;
        const retryAfter = rateLimitConfig.retryAfterSeconds ?? 5;
        const message =
          rateLimitConfig.message ?? `Rate limit reached. Please wait ${retryAfter} seconds.`;
        const dialect = rateLimitConfig.dialect ?? (path.includes('messages') ? 'anthropic' : 'openai');

        if (rateLimitCountRemaining <= 0) {
          rateLimitConfig = null;
        }

        const bodyPayload =
          dialect === 'anthropic'
            ? {
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message,
                },
              }
            : {
                error: {
                  message,
                  type: 'rate_limit_error',
                  param: null,
                  code: 429,
                },
              };

        return new Response(JSON.stringify(bodyPayload), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfter),
          },
        });
      }

      // 4. Check simulated error
      if (errorConfig && errorCountRemaining > 0) {
        errorCountRemaining--;
        const { status, message = 'Internal Server Error', code = status, type = 'api_error' } = errorConfig;
        const dialect = errorConfig.dialect ?? (path.includes('messages') ? 'anthropic' : 'openai');

        if (errorCountRemaining <= 0) {
          errorConfig = null;
        }

        const bodyPayload =
          dialect === 'anthropic'
            ? {
                type: 'error',
                error: {
                  type: String(type),
                  message,
                },
              }
            : {
                error: {
                  message,
                  type: String(type),
                  code,
                },
              };

        return new Response(JSON.stringify(bodyPayload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 4b. Check simulated raw stream
      if (rawStreamChunks) {
        const streamResponse = createRawStreamResponse(rawStreamChunks, rawStreamDelayMs);
        rawStreamChunks = null;
        rawStreamDelayMs = 0;
        return streamResponse;
      }

      // 5. OpenAI /v1/chat/completions
      if (path === '/v1/chat/completions') {
        const isStream = parsedBody?.stream === true;
        if (isStream) {
          return createOpenAISSEStream(parsedBody, openAIOpts);
        }

        const finishReason = openAIOpts.finishReason || (openAIOpts.toolCalls?.length ? 'tool_calls' : 'stop');
        const jsonResponse = {
          id: `chatcmpl-${Math.random().toString(36).substring(2, 10)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsedBody?.model || openAIOpts.model || 'mock-gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: openAIOpts.content ?? null,
                ...(openAIOpts.reasoningContent ? { reasoning_content: openAIOpts.reasoningContent } : {}),
                ...(openAIOpts.toolCalls ? { tool_calls: openAIOpts.toolCalls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 25,
            total_tokens: 40,
          },
        };

        return new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 6. Anthropic /v1/messages
      if (path === '/v1/messages') {
        const isStream = parsedBody?.stream === true;
        if (isStream) {
          return createAnthropicSSEStream(parsedBody, anthropicOpts);
        }

        const contentBlocks: any[] = [];
        if (anthropicOpts.thinking) {
          contentBlocks.push({ type: 'thinking', thinking: anthropicOpts.thinking });
        }
        if (anthropicOpts.text !== undefined) {
          contentBlocks.push({ type: 'text', text: anthropicOpts.text });
        }
        if (anthropicOpts.toolUse) {
          contentBlocks.push({
            type: 'tool_use',
            id: anthropicOpts.toolUse.id,
            name: anthropicOpts.toolUse.name,
            input: anthropicOpts.toolUse.input,
          });
        }

        const stopReason = anthropicOpts.stopReason || (anthropicOpts.toolUse ? 'tool_use' : 'end_turn');
        const jsonResponse = {
          id: `msg_${Math.random().toString(36).substring(2, 12)}`,
          type: 'message',
          role: 'assistant',
          model: parsedBody?.model || anthropicOpts.model || 'claude-3-7-sonnet',
          content: contentBlocks,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: {
            input_tokens: 20,
            output_tokens: 35,
          },
        };

        return new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 7. Models catalog
      if (path === '/v1/models' || path === '/models') {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mock-gpt-4o', object: 'model', created: 1700000000, owned_by: 'mock-openai' },
              { id: 'claude-3-7-sonnet', object: 'model', created: 1700000000, owned_by: 'mock-anthropic' },
              { id: 'kilo/free-model:free', object: 'model', created: 1700000000, owned_by: 'kilo' },
              { id: 'hermes-3-llama-3.1-8b', object: 'model', created: 1700000000, owned_by: 'nous' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 8. Provider Specific Auth Endpoints
      // Kilo Code Device Auth & Token
      if (path === '/api/v1/auth/device/code') {
        return new Response(
          JSON.stringify({
            user_code: 'KILO-7890',
            device_code: 'dev_code_kilo_xyz',
            verification_uri: 'https://kilo.ai/auth',
            expires_in: 900,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (path === '/api/v1/auth/token') {
        return new Response(
          JSON.stringify({
            access_token: 'kilo_access_token_mock',
            refresh_token: 'kilo_refresh_token_mock',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Nous Portal OAuth
      if (path === '/v1/portal/auth') {
        return new Response(
          JSON.stringify({
            auth_url: 'https://portal.nousresearch.com/oauth/authorize?client_id=nous_client_mock',
            session_id: 'nous_sess_mock_123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (path === '/v1/portal/token') {
        return new Response(
          JSON.stringify({
            access_token: 'sk-nous-valid-token-mock',
            refresh_token: 'nous_ref_token_mock',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Cline WorkOS Refresh
      if (path === '/api/v1/auth/refresh') {
        return new Response(
          JSON.stringify({
            access_token: 'cline_refreshed_access_token',
            refresh_token: 'cline_refreshed_refresh_token',
            expires_in: 7200,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (path === '/api/v1/auth/user') {
        return new Response(
          JSON.stringify({
            id: 'user_cline_mock',
            email: 'cline_user@example.com',
            quota: { remaining_turns: 250, plan: 'pro' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // OpenCode Gate Tools & Zen
      if (path === '/api/gate/tools') {
        return new Response(
          JSON.stringify({
            tools: [
              { name: 'execute_command', description: 'Run bash commands' },
              { name: 'read_file', description: 'Read file contents' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (path === '/api/zen/completions') {
        return new Response(
          JSON.stringify({
            text: 'Zen completion response',
            finish_reason: 'stop',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // DeepSeek Session Challenge
      if (path === '/api/v1/session/challenge') {
        return new Response(
          JSON.stringify({
            challenge: 'challenge_ds_nonce_12345',
            difficulty: 1,
            algorithm: 'sha256',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (path === '/api/v1/session/verify') {
        return new Response(
          JSON.stringify({
            success: true,
            session_token: 'ds_session_cookie_mock',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Health
      if (path === '/healthz' || path === '/live') {
        return new Response(JSON.stringify({ status: 'healthy', uptime: process.uptime() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Default 404 for unknown endpoints
      return new Response(
        JSON.stringify({
          error: {
            message: `Endpoint ${method} ${path} not found on mock upstream`,
            type: 'not_found_error',
            code: 404,
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const upstream: MockUpstreamServer = {
    get url() {
      return `http://127.0.0.1:${server.port}`;
    },
    get port() {
      return server.port ?? 0;
    },
    server,

    async stop() {
      server.stop(true);
    },

    reset() {
      recordedRequests = [];
      customHandlers = [];
      pathHandlers.clear();
      rateLimitConfig = null;
      rateLimitCountRemaining = 0;
      errorConfig = null;
      errorCountRemaining = 0;
      rawStreamChunks = null;
      rawStreamDelayMs = 0;
      openAIOpts = {
        content: 'Hello! I am a simulated response from the mock upstream.',
        finishReason: 'stop',
        model: 'mock-gpt-4o',
        ...options.openAIDefaults,
      };
      anthropicOpts = {
        text: 'Hello! I am a simulated Claude response from the mock upstream.',
        stopReason: 'end_turn',
        model: 'claude-3-7-sonnet',
        ...options.anthropicDefaults,
      };
    },

    getRequests() {
      return [...recordedRequests];
    },

    findRequests(predicate: (req: RecordedRequest) => boolean) {
      return recordedRequests.filter(predicate);
    },

    clearRequests() {
      recordedRequests = [];
    },

    onOpenAIChat(handler: (req: Request, body: any) => Response | Promise<Response>) {
      pathHandlers.set('/v1/chat/completions', handler);
    },

    onAnthropicMessages(handler: (req: Request, body: any) => Response | Promise<Response>) {
      pathHandlers.set('/v1/messages', handler);
    },

    onPath(path: string, handler: (req: Request, body: any) => Response | Promise<Response>) {
      pathHandlers.set(path, handler);
    },

    onRequest(handler: RequestHandler) {
      customHandlers.push(handler);
    },

    simulateRateLimit(opts: RateLimitOptions = {}) {
      rateLimitConfig = opts;
      rateLimitCountRemaining = opts.count ?? 1;
    },

    simulateError(opts: ErrorResponseOptions) {
      errorConfig = opts;
      errorCountRemaining = opts.count ?? 1;
    },

    simulateRawStream(chunks: string[], delayMs = 0) {
      rawStreamChunks = chunks;
      rawStreamDelayMs = delayMs;
    },

    configureOpenAIChat(opts: OpenAIChatMockOptions) {
      openAIOpts = { ...openAIOpts, ...opts };
    },

    configureAnthropicMessages(opts: AnthropicMessagesMockOptions) {
      anthropicOpts = { ...anthropicOpts, ...opts };
    },
  };

  return upstream;
}
