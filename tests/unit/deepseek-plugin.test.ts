import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import {
  DeepSeekPoolPlugin,
  parseDeepSeekChromeSession,
  parseDeepSeekRetryAfter,
  StreamingThinkingExtractor,
  type ChromeSessionExport,
} from '../../src/plugins/deepseek';
import type { CanonicalRequest, CanonicalStreamEvent } from '../../src/core/types/canonical';
import { GatewayError } from '../../src/core/types/errors';
import { createMockUpstream, type MockUpstreamServer } from '../harness/mock-upstream';

describe('DeepSeek Production Logic Unit Tests', () => {
  describe('1. Cookie & Session Ingestion', () => {
    it('ingests userToken, cookie string, and sessionId correctly', () => {
      const data: ChromeSessionExport = {
        userToken: 'token_abc_123',
        sessionId: 'sess_custom_99',
        cookies: 'HAPO=123; d_sec=secret_val',
      };
      const account = parseDeepSeekChromeSession('acc_1', data);
      expect(account.id).toBe('acc_1');
      expect(account.providerId).toBe('deepseek');
      expect(account.authType).toBe('cookie_pool');
      expect(account.status).toBe('active');
      expect(account.credentials.accessToken).toBe('token_abc_123');
      expect(account.credentials.cookies).toBe('HAPO=123; d_sec=secret_val');
      expect(account.credentials.customData?.sessionId).toBe('sess_custom_99');
    });

    it('ingests cookie object and converts to key=value string', () => {
      const data: ChromeSessionExport = {
        userToken: 'token_xyz',
        cookies: {
          session_id: 'val_1',
          cf_clearance: 'cf_2',
        },
      };
      const account = parseDeepSeekChromeSession('acc_2', data);
      expect(account.credentials.accessToken).toBe('token_xyz');
      expect(account.credentials.cookies).toContain('session_id=val_1');
      expect(account.credentials.cookies).toContain('cf_clearance=cf_2');
      expect(account.credentials.customData?.sessionId).toBeDefined();
    });

    it('extracts userToken from cookie string if userToken field is omitted', () => {
      const data: ChromeSessionExport = {
        cookies: 'foo=bar; userToken=extracted_token_val; baz=qux',
      };
      const account = parseDeepSeekChromeSession('acc_3', data);
      expect(account.credentials.accessToken).toBe('extracted_token_val');
    });

    it('throws error when userToken is missing and cannot be extracted', () => {
      expect(() => {
        parseDeepSeekChromeSession('acc_fail', {
          cookies: 'no_token_here=1',
        });
      }).toThrow('Invalid DeepSeek session export: missing userToken');
    });
  });

  describe('2. Base URL & Endpoints', () => {
    it('defaults to https://chat.deepseek.com/api/v0', () => {
      const plugin = new DeepSeekPoolPlugin();
      expect(plugin.defaultBaseUrl).toBe('https://chat.deepseek.com/api/v0');
    });

    it('exposes deepseek-reasoner and deepseek-chat models in catalog', async () => {
      const plugin = new DeepSeekPoolPlugin();
      const models = await plugin.listModels();
      const ids = models.map((m) => m.id);
      expect(ids).toContain('deepseek/deepseek-reasoner');
      expect(ids).toContain('deepseek/deepseek-chat');
      expect(ids).toContain('deepseek/deepseek-r1');
      expect(ids).toContain('deepseek/deepseek-v3');

      const reasoner = models.find((m) => m.id === 'deepseek/deepseek-reasoner');
      expect(reasoner?.supportsThinking).toBe(true);
      expect(reasoner?.contextWindow).toBe(64000);
    });
  });

  describe('3. Browser User-Agent and Headers', () => {
    it('builds authentic browser headers with User-Agent, platform, and credentials', () => {
      const plugin = new DeepSeekPoolPlugin();
      const account = parseDeepSeekChromeSession('ds_acc', {
        userToken: 'token_sample_123',
        cookies: 'HAPO=1; d_sec=2',
        userAgent: 'CustomBrowser/1.0',
        hif_dliq: 'dliq_val',
        hif_leim: 'leim_val',
      });
      plugin.addAccount(account);

      const headers = (plugin as any).buildHeaders(account);
      expect(headers['User-Agent']).toBe('CustomBrowser/1.0');
      expect(headers['x-client-platform']).toBe('web');
      expect(headers['x-client-version']).toBe('2.0.2');
      expect(headers['Origin']).toBe('https://chat.deepseek.com');
      expect(headers['Referer']).toBe('https://chat.deepseek.com/');
      expect(headers['Authorization']).toBe('Bearer token_sample_123');
      expect(headers['Cookie']).toBe('HAPO=1; d_sec=2');
      expect(headers['x-hif-dliq']).toBe('dliq_val');
      expect(headers['x-hif-leim']).toBe('leim_val');
    });

    it('falls back to default browser User-Agent when not specified in account', () => {
      const plugin = new DeepSeekPoolPlugin();
      const account = parseDeepSeekChromeSession('ds_acc_default', {
        userToken: 'token_test',
        cookies: 'a=b',
      });
      const headers = (plugin as any).buildHeaders(account);
      expect(headers['User-Agent']).toContain('Mozilla/5.0');
      expect(headers['User-Agent']).toContain('Safari');
    });
  });

  describe('4. Extract & Preserve <think>...</think> Reasoning Delta Tokens', () => {
    it('StreamingThinkingExtractor separates <think> tags into thinking_delta and content into text_delta', () => {
      const thinkingDeltas: string[] = [];
      const textDeltas: string[] = [];

      const extractor = new StreamingThinkingExtractor(
        (td) => thinkingDeltas.push(td),
        (cd) => textDeltas.push(cd)
      );

      extractor.processChunk('Hello, <think>let us calculate 2 + 2 = 4</think> the answer is 4.');
      extractor.flush();

      expect(thinkingDeltas.join('')).toBe('let us calculate 2 + 2 = 4');
      expect(textDeltas.join('')).toBe('Hello,  the answer is 4.');
    });

    it('handles <think> and </think> split across arbitrary chunk boundaries', () => {
      const thinkingDeltas: string[] = [];
      const textDeltas: string[] = [];

      const extractor = new StreamingThinkingExtractor(
        (td) => thinkingDeltas.push(td),
        (cd) => textDeltas.push(cd)
      );

      extractor.processChunk('Start <thi');
      extractor.processChunk('nk>reasoning step 1. ');
      extractor.processChunk('reasoning step 2.</th');
      extractor.processChunk('ink>Done!');
      extractor.flush();

      expect(thinkingDeltas.join('')).toBe('reasoning step 1. reasoning step 2.');
      expect(textDeltas.join('')).toBe('Start Done!');
    });

    it('safely flushes unclosed <think> tag at end of stream as thinking delta', () => {
      const thinkingDeltas: string[] = [];
      const textDeltas: string[] = [];

      const extractor = new StreamingThinkingExtractor(
        (td) => thinkingDeltas.push(td),
        (cd) => textDeltas.push(cd)
      );

      extractor.processChunk('Preamble <think>unclosed thoughts');
      extractor.flush();

      expect(thinkingDeltas.join('')).toBe('unclosed thoughts');
      expect(textDeltas.join('')).toBe('Preamble ');
    });

    it('preserves plain text without <think> tags without alteration', () => {
      const thinkingDeltas: string[] = [];
      const textDeltas: string[] = [];

      const extractor = new StreamingThinkingExtractor(
        (td) => thinkingDeltas.push(td),
        (cd) => textDeltas.push(cd)
      );

      extractor.processChunk('This is a completely normal text response with no reasoning.');
      extractor.flush();

      expect(thinkingDeltas.length).toBe(0);
      expect(textDeltas.join('')).toBe(
        'This is a completely normal text response with no reasoning.'
      );
    });

    it('handles false alarms like "<thin line" correctly as text', () => {
      const thinkingDeltas: string[] = [];
      const textDeltas: string[] = [];

      const extractor = new StreamingThinkingExtractor(
        (td) => thinkingDeltas.push(td),
        (cd) => textDeltas.push(cd)
      );

      extractor.processChunk('A <thin');
      extractor.processChunk(' line of code.');
      extractor.flush();

      expect(thinkingDeltas.length).toBe(0);
      expect(textDeltas.join('')).toBe('A <thin line of code.');
    });
  });

  describe('5. Auto-cooldown & Rate Limit Backoff', () => {
    it('parses natural language Retry-After durations', () => {
      expect(parseDeepSeekRetryAfter(null, 'Try again in 5 minutes.')).toBe(300);
      expect(parseDeepSeekRetryAfter(null, 'Rate limit. Please try again in 2 hours.')).toBe(7200);
      expect(parseDeepSeekRetryAfter(null, 'Wait and try again in 45 seconds.')).toBe(45);
      expect(parseDeepSeekRetryAfter('120')).toBe(120);
      expect(parseDeepSeekRetryAfter(null, 'Generic error')).toBe(30);
    });

    it('classifies errors correctly into authentication and rate_limit categories', () => {
      const plugin = new DeepSeekPoolPlugin();
      const authError = plugin.classifyError(new Error('Unauthorized'), 401);
      expect(authError.category).toBe('authentication');
      expect(authError.isRetryable).toBe(false);

      const forbiddenError = plugin.classifyError(new Error('Forbidden'), 403);
      expect(forbiddenError.category).toBe('authentication');
      expect(forbiddenError.isRetryable).toBe(false);

      const rateLimitError = plugin.classifyError(new Error('Too Many Requests'), 429);
      expect(rateLimitError.category).toBe('rate_limit');
      expect(rateLimitError.isRetryable).toBe(true);
      expect(rateLimitError.cooldownDurationMs).toBe(60_000);
    });

    it('rotates through active accounts in round-robin sequence', () => {
      const plugin = new DeepSeekPoolPlugin();
      const acc1 = parseDeepSeekChromeSession('acc1', { userToken: 'tok1', cookies: 'a=1' });
      const acc2 = parseDeepSeekChromeSession('acc2', { userToken: 'tok2', cookies: 'a=2' });
      plugin.addAccount(acc1);
      plugin.addAccount(acc2);

      expect(plugin.getNextAccount().id).toBe('acc1');
      expect(plugin.getNextAccount().id).toBe('acc2');
      expect(plugin.getNextAccount().id).toBe('acc1');
    });

    it('skips accounts currently in cooldown', () => {
      const plugin = new DeepSeekPoolPlugin();
      const acc1 = parseDeepSeekChromeSession('acc1', { userToken: 'tok1', cookies: 'a=1' });
      const acc2 = parseDeepSeekChromeSession('acc2', { userToken: 'tok2', cookies: 'a=2' });
      acc1.status = 'cooldown';
      acc1.cooldownUntil = Date.now() + 60000;

      plugin.addAccount(acc1);
      plugin.addAccount(acc2);

      const next = plugin.getNextAccount();
      expect(next.id).toBe('acc2');
    });

    it('throws 429 when all accounts are in cooldown with appropriate retryAfter', () => {
      const plugin = new DeepSeekPoolPlugin();
      const acc1 = parseDeepSeekChromeSession('acc1', { userToken: 'tok1', cookies: 'a=1' });
      acc1.status = 'cooldown';
      acc1.cooldownUntil = Date.now() + 25000;
      plugin.addAccount(acc1);

      expect(() => plugin.getNextAccount()).toThrow(GatewayError);
      try {
        plugin.getNextAccount();
      } catch (err: any) {
        expect(err.status).toBe(429);
        expect(err.retryAfter).toBeGreaterThan(0);
      }
    });

    it('reports healthCheck correctly based on active accounts', async () => {
      const plugin = new DeepSeekPoolPlugin();
      const acc = parseDeepSeekChromeSession('acc_active', { userToken: 'tok', cookies: 'c=1' });
      plugin.addAccount(acc);

      let health = await plugin.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.message).toContain('1/1 DeepSeek sessions active');

      acc.status = 'expired';
      health = await plugin.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('0/1 DeepSeek sessions active');
    });
  });

  describe('6. Mock Upstream Integration & Auto-Healing', () => {
    let mockServer: MockUpstreamServer;

    beforeAll(async () => {
      mockServer = await createMockUpstream();
    });

    afterAll(async () => {
      if (mockServer) await mockServer.stop();
    });

    beforeEach(() => {
      mockServer.reset();
    });

    it('executes non-streaming request and extracts <think> tags into thinking content part', async () => {
      mockServer.configureOpenAIChat({
        content: '<think>Calculated step by step proof.</think>Here is the solution.',
      });

      const plugin = new DeepSeekPoolPlugin(mockServer.url);
      const acc = parseDeepSeekChromeSession('acc_exec', { userToken: 'tok_live', cookies: 'c=1' });
      plugin.addAccount(acc);

      const req: CanonicalRequest = {
        id: 'req_test_01',
        clientDialect: 'openai-chat',
        model: 'deepseek/deepseek-reasoner',
        messages: [{ role: 'user', content: 'Solve theorem' }],
        stream: false,
      };

      const res = await plugin.execute(req);
      expect(res.id).toBeDefined();
      expect(res.content.length).toBe(2);
      expect(res.content[0].type).toBe('thinking');
      expect((res.content[0] as any).thinking).toBe('Calculated step by step proof.');
      expect(res.content[1].type).toBe('text');
      expect((res.content[1] as any).text).toBe('Here is the solution.');
    });

    it('auto-heals to Account 2 when Account 1 receives 401', async () => {
      mockServer.simulateError({
        status: 401,
        message: 'Token expired',
        dialect: 'openai',
        count: 1,
      });

      const plugin = new DeepSeekPoolPlugin(mockServer.url);
      const acc1 = parseDeepSeekChromeSession('acc_heal_1', { userToken: 'tok_fail_1', cookies: 'c=1' });
      const acc2 = parseDeepSeekChromeSession('acc_heal_2', { userToken: 'tok_success_2', cookies: 'c=2' });
      plugin.addAccount(acc1);
      plugin.addAccount(acc2);

      const req: CanonicalRequest = {
        id: 'req_heal_01',
        clientDialect: 'openai-chat',
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      };

      const res = await plugin.execute(req);
      expect(res).toBeDefined();
      expect(acc1.status).toBe('expired');
      expect(acc2.status).toBe('active');

      const requests = mockServer.getRequests();
      expect(requests.length).toBe(2);
      expect(requests[0].headers['authorization']).toBe('Bearer tok_fail_1');
      expect(requests[1].headers['authorization']).toBe('Bearer tok_success_2');
    });

    it('auto-heals to Account 2 when Account 1 receives 429 rate limit', async () => {
      mockServer.simulateRateLimit({
        retryAfterSeconds: 15,
        message: 'Rate limit hit',
        dialect: 'openai',
        count: 1,
      });

      const plugin = new DeepSeekPoolPlugin(mockServer.url);
      const acc1 = parseDeepSeekChromeSession('acc_429_1', { userToken: 'tok_rl_1', cookies: 'c=1' });
      const acc2 = parseDeepSeekChromeSession('acc_429_2', { userToken: 'tok_rl_2', cookies: 'c=2' });
      plugin.addAccount(acc1);
      plugin.addAccount(acc2);

      const req: CanonicalRequest = {
        id: 'req_429_01',
        clientDialect: 'openai-chat',
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'Ping' }],
        stream: false,
      };

      const res = await plugin.execute(req);
      expect(res).toBeDefined();
      expect(acc1.status).toBe('cooldown');
      expect(acc1.cooldownUntil).toBeGreaterThan(Date.now());
      expect(acc2.status).toBe('active');
    });

    it('streams SSE response separating reasoning_content into thinking_delta', async () => {
      mockServer.configureOpenAIChat({
        reasoningContent: 'Reasoning thought chunk',
        content: 'Final answer chunk',
      });

      const plugin = new DeepSeekPoolPlugin(mockServer.url);
      const acc = parseDeepSeekChromeSession('acc_stream', { userToken: 'tok_stream', cookies: 'c=1' });
      plugin.addAccount(acc);

      const req: CanonicalRequest = {
        id: 'req_stream_01',
        clientDialect: 'openai-chat',
        model: 'deepseek/deepseek-reasoner',
        messages: [{ role: 'user', content: 'Think and answer' }],
        stream: true,
      };

      const stream = await plugin.executeStream(req);
      const events: CanonicalStreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const thinkingEvents = events.filter((e) => e.type === 'thinking_delta');
      const textEvents = events.filter((e) => e.type === 'text_delta');

      expect(thinkingEvents.length).toBeGreaterThan(0);
      expect((thinkingEvents[0] as any).delta).toBe('Reasoning thought chunk');
      expect(textEvents.length).toBeGreaterThan(0);
      expect((textEvents[0] as any).delta).toBe('Final answer chunk');
    });

    it('solves session challenge via challenge/verify endpoints', async () => {
      const plugin = new DeepSeekPoolPlugin(mockServer.url);
      const token = await plugin.solveChallenge();
      expect(token).toBe('ds_session_cookie_mock');
    });
  });
});
