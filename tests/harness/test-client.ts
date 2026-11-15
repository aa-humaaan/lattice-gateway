/**
 * Test Client for Lattice Gateway E2E Testing
 * 
 * Provides high-level client wrappers for interacting with Lattice Gateway:
 * - OpenAI dialect: chat completions (JSON) and SSE streaming
 * - Anthropic dialect: messages (JSON) and SSE streaming with thinking & tools
 * - Admin REST APIs: accounts, combos, logs, and live log stream
 * - Models catalog & health check probes
 * - Robust SSE stream parsing resilient to chunk splitting across TCP boundaries
 */

export interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
  logprobs?: any;
}

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'redacted_thinking';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
}

export interface AnthropicSSEEvent {
  event: string;
  data: any;
  // Common Anthropic event properties flattened for ease of access
  type?: string;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type: 'text_delta' | 'thinking_delta' | 'signature_delta' | 'input_json_delta';
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  message?: {
    id: string;
    type: string;
    role: string;
    model: string;
    content: AnthropicContentBlock[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
  usage?: { output_tokens: number };
}

export interface ClientRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Robust Server-Sent Events parser that handles arbitrary chunk slicing,
 * CRLF / LF line endings, keepalive ping comments, and multiple data lines.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  options?: { onComment?: (comment: string) => void }
): AsyncIterable<{ event: string; data: string; id?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE blocks are delimited by double newlines (\n\n or \r\n\r\n)
      let boundaryIndex: number;
      while ((boundaryIndex = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.substring(0, boundaryIndex);
        buffer = buffer.substring(boundaryIndex + (buffer[boundaryIndex] === '\r' ? 4 : 2));

        if (!rawEvent.trim()) continue;

        let eventType = 'message';
        let eventId: string | undefined;
        const dataLines: string[] = [];

        const lines = rawEvent.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith(':')) {
            // Comment / ping keepalive
            options?.onComment?.(line.substring(1).trim());
            continue;
          }
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.substring(5).trimStart());
          } else if (line.startsWith('id:')) {
            eventId = line.substring(3).trim();
          }
        }

        if (dataLines.length > 0) {
          yield {
            event: eventType,
            data: dataLines.join('\n'),
            id: eventId,
          };
        }
      }
    }

    // Flush any remaining buffer if it ends with a valid event
    if (buffer.trim()) {
      const lines = buffer.split(/\r?\n/);
      let eventType = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.substring(5).trimStart());
        }
      }
      if (dataLines.length > 0) {
        yield { event: eventType, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findEventBoundary(str: string): number {
  const match = /\r?\n\r?\n/.exec(str);
  return match ? match.index : -1;
}

export class TestClient {
  public readonly baseUrl: string;
  public readonly defaultApiKey: string;
  public readonly defaultAnthropicVersion: string;

  constructor(
    baseUrl: string,
    options: {
      apiKey?: string;
      anthropicVersion?: string;
    } = {}
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultApiKey = options.apiKey ?? 'sk-lattice-test-key';
    this.defaultAnthropicVersion = options.anthropicVersion ?? '2023-06-01';
  }

  // --- OpenAI Dialect Methods ---

  /**
   * Send a JSON request to OpenAI /v1/chat/completions
   */
  async openaiChat(payload: any, options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.defaultApiKey}`,
      ...options.headers,
    };

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  }

  /**
   * Send a streaming request to OpenAI /v1/chat/completions and yield typed chunks
   */
  async *openaiChatStream(
    payload: any,
    options: ClientRequestOptions = {}
  ): AsyncIterable<OpenAIStreamChunk> {
    const streamPayload = { ...payload, stream: true };
    const res = await this.openaiChat(streamPayload, options);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI stream request failed with status ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error('Response body is null');
    }

    for await (const raw of parseSSEStream(res.body)) {
      if (raw.data === '[DONE]') {
        break;
      }
      try {
        const chunk = JSON.parse(raw.data) as OpenAIStreamChunk;
        yield chunk;
      } catch (err) {
        // Yield error event or throw
        throw new Error(`Failed to parse OpenAI SSE chunk: ${raw.data}`);
      }
    }
  }

  // --- Anthropic Dialect Methods ---

  /**
   * Send a JSON request to Anthropic /v1/messages
   */
  async anthropicMessages(payload: any, options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.defaultApiKey,
      'anthropic-version': this.defaultAnthropicVersion,
      ...options.headers,
    };

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  }

  /**
   * Send a streaming request to Anthropic /v1/messages and yield typed events
   */
  async *anthropicMessagesStream(
    payload: any,
    options: ClientRequestOptions = {}
  ): AsyncIterable<AnthropicSSEEvent> {
    const streamPayload = { ...payload, stream: true };
    const res = await this.anthropicMessages(streamPayload, options);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic stream request failed with status ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error('Response body is null');
    }

    for await (const raw of parseSSEStream(res.body)) {
      try {
        const parsed = JSON.parse(raw.data);
        const eventObj: AnthropicSSEEvent = {
          event: raw.event,
          data: parsed,
          ...parsed,
        };
        yield eventObj;
      } catch (err) {
        throw new Error(`Failed to parse Anthropic SSE chunk: ${raw.data}`);
      }
    }
  }

  // --- OpenAI /v1/responses Endpoint ---

  async openaiResponses(payload: any, options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/responses`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.defaultApiKey}`,
      ...options.headers,
    };

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  }

  // --- Catalog & Health Methods ---

  /**
   * Fetch aggregated models catalog from /v1/models
   */
  async getModels(options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/models`;
    const headers = {
      'Authorization': `Bearer ${this.defaultApiKey}`,
      ...options.headers,
    };

    return fetch(url, { method: 'GET', headers, signal: options.signal });
  }

  /**
   * Fetch health check from /healthz or /live
   */
  async getHealth(endpoint: '/healthz' | '/live' = '/healthz'): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    return fetch(url, { method: 'GET' });
  }

  // --- Admin API Methods ---

  /**
   * Fetch accounts list from /api/accounts
   */
  async getAccounts(options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/api/accounts`;
    return fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.defaultApiKey}`, ...options.headers },
      signal: options.signal,
    });
  }

  /**
   * Fetch virtual model combos from /api/combos
   */
  async getCombos(options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/api/combos`;
    return fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.defaultApiKey}`, ...options.headers },
      signal: options.signal,
    });
  }

  /**
   * Fetch logs from /api/logs
   */
  async getLogs(options: ClientRequestOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/api/logs`;
    return fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.defaultApiKey}`, ...options.headers },
      signal: options.signal,
    });
  }

  /**
   * Subscribe to real-time log stream from /api/logs/stream
   */
  async *getLogStream(options: ClientRequestOptions = {}): AsyncIterable<any> {
    const url = `${this.baseUrl}/api/logs/stream`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.defaultApiKey}`, ...options.headers },
      signal: options.signal,
    });

    if (!res.ok) {
      throw new Error(`Log stream failed with status ${res.status}`);
    }

    if (!res.body) throw new Error('Response body is null');

    for await (const raw of parseSSEStream(res.body)) {
      try {
        yield JSON.parse(raw.data);
      } catch {
        yield raw.data;
      }
    }
  }

  /**
   * Helper to collect an async iterable stream into an array
   */
  static async collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    return items;
  }
}
