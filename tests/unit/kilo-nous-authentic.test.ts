import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { KiloProviderPlugin, KILO_DEFAULT_BASE_URL } from '../../src/plugins/kilo';
import { NousProviderPlugin, NOUS_DEFAULT_BASE_URL } from '../../src/plugins/nous';
import { createMockUpstream, type MockUpstreamServer } from '../harness/mock-upstream';
import type { CanonicalRequest } from '../../src/core/types/canonical';

describe('Unit: Authentic Kilo Code & Nous Research Gateway Clients', () => {
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

  // ==========================================================================
  // Kilo Code Authentic Client Tests
  // ==========================================================================
  describe('Kilo Code Upstream Client', () => {
    it('initializes with production default base URL', () => {
      const kilo = new KiloProviderPlugin();
      expect(kilo.defaultBaseUrl).toBe('https://ai-gateway.kilo.ai/api/v1');
      expect(KILO_DEFAULT_BASE_URL).toBe('https://ai-gateway.kilo.ai/api/v1');
    });

    it('propagates Bearer apiKey and X-KiloCode-OrganizationId headers', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);
      kilo.setAccount({
        id: 'acc_kilo_test',
        providerId: 'kilo',
        authType: 'api_key',
        credentials: {
          apiKey: 'kilo_sec_key_abc123',
          organizationId: 'org_kilo_enterprise_456',
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      });

      mockServer.configureOpenAIChat({
        content: 'Kilo authenticated response',
        model: 'code-fast:free',
      });

      const req: CanonicalRequest = {
        id: 'req_lat_kilo_01',
        clientDialect: 'openai-chat',
        model: 'kilo/code-fast:free',
        messages: [{ role: 'user', content: 'Test Kilo' }],
        stream: false,
      };

      const res = await kilo.execute(req);
      expect((res.content[0] as any).text).toBe('Kilo authenticated response');

      const recorded = mockServer.getRequests();
      expect(recorded.length).toBe(1);
      expect(recorded[0].headers['authorization']).toBe('Bearer kilo_sec_key_abc123');
      expect(recorded[0].headers['x-kilocode-organizationid']).toBe('org_kilo_enterprise_456');
    });

    it('supports accessToken when apiKey is absent', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);
      kilo.setAccount({
        id: 'acc_kilo_oauth',
        providerId: 'kilo',
        authType: 'oauth',
        credentials: {
          accessToken: 'kilo_oauth_bearer_tok',
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      });

      mockServer.configureOpenAIChat({ content: 'OAuth OK' });

      const req: CanonicalRequest = {
        id: 'req_lat_kilo_oauth',
        clientDialect: 'openai-chat',
        model: 'kilo/code-fast:free',
        messages: [{ role: 'user', content: 'OAuth test' }],
        stream: false,
      };

      await kilo.execute(req);
      const recorded = mockServer.getRequests();
      expect(recorded[0].headers['authorization']).toBe('Bearer kilo_oauth_bearer_tok');
    });

    it('lists curated model catalog with :free models tagged correctly', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);
      const models = await kilo.listModels();

      expect(models.length).toBeGreaterThanOrEqual(10);
      const freeModels = models.filter((m) => m.isFree);
      expect(freeModels.length).toBeGreaterThanOrEqual(5);

      const codeFast = models.find((m) => m.id === 'kilo/code-fast:free');
      expect(codeFast).toBeDefined();
      expect(codeFast?.isFree).toBe(true);

      const qwenCoder = models.find((m) => m.id === 'kilo/qwen-2.5-coder:free');
      expect(qwenCoder).toBeDefined();
      expect(qwenCoder?.isFree).toBe(true);

      const sonnet = models.find((m) => m.id === 'kilo/claude-3-7-sonnet');
      expect(sonnet).toBeDefined();
      expect(sonnet?.isFree).toBe(false);
      expect(sonnet?.supportsThinking).toBe(true);
    });

    it('executes dynamic model catalog sync and deep connection probe', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);
      const probeResult = await kilo.probe();

      expect(probeResult.healthy).toBe(true);
      expect(probeResult.latencyMs).toBeDefined();
      expect(probeResult.latencyMs).toBeGreaterThanOrEqual(0);
      expect(probeResult.modelsCount).toBeGreaterThan(0);
    });

    it('executes Kilo OAuth device flow authorization and token exchange', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);

      // 1. Device Code
      const devCode = await kilo.requestDeviceCode('kilo_ide_client');
      expect(devCode.device_code).toBe('dev_code_kilo_xyz');
      expect(devCode.user_code).toBe('KILO-7890');
      expect(devCode.verification_uri).toBe('https://kilo.ai/auth');

      // 2. Token Exchange
      const token = await kilo.exchangeDeviceToken(devCode.device_code);
      expect(token.access_token).toBe('kilo_access_token_mock');
      expect(token.token_type).toBe('Bearer');
    });

    it('performs live healthCheck returning operational status and latency', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);
      const health = await kilo.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('operational');
      expect(health.checkedAt).toBeGreaterThan(0);
    });

    it('normalizes XML tool calls in non-streaming responses', async () => {
      const kilo = new KiloProviderPlugin(mockServer.url);
      mockServer.configureOpenAIChat({
        content: '<tool_call>\n<function=read_file>\n<parameter=path>test.txt</parameter>\n</tool_call>',
      });

      const req: CanonicalRequest = {
        id: 'req_lat_kilo_xml',
        clientDialect: 'openai-chat',
        model: 'kilo/code-fast:free',
        messages: [{ role: 'user', content: 'Read file' }],
        stream: false,
      };

      const res = await kilo.execute(req);
      expect(res.stopReason).toBe('tool_calls');
      expect(res.content.some((c) => c.type === 'tool_use' && c.name === 'read_file')).toBe(true);
    });

    it('classifies 401, 403, and 429 errors appropriately', () => {
      const kilo = new KiloProviderPlugin();
      const authErr = kilo.classifyError(new Error('401'), 401);
      expect(authErr.category).toBe('authentication');
      expect(authErr.isRetryable).toBe(false);

      const permErr = kilo.classifyError(new Error('403'), 403);
      expect(permErr.category).toBe('permission_denied');
      expect(permErr.isRetryable).toBe(false);

      const rateErr = kilo.classifyError(new Error('429'), 429);
      expect(rateErr.category).toBe('rate_limit');
      expect(rateErr.isRetryable).toBe(true);
      expect(rateErr.cooldownDurationMs).toBe(60_000);
    });
  });

  // ==========================================================================
  // Nous Research Authentic Client Tests
  // ==========================================================================
  describe('Nous Research Upstream Client', () => {
    it('initializes with production default base URL', () => {
      const nous = new NousProviderPlugin();
      expect(nous.defaultBaseUrl).toBe('https://inference-api.nousresearch.com/v1');
      expect(NOUS_DEFAULT_BASE_URL).toBe('https://inference-api.nousresearch.com/v1');
    });

    it('authenticates with sk-nous-... Bearer token', async () => {
      const nous = new NousProviderPlugin(mockServer.url);
      nous.setAccount({
        id: 'acc_nous_test',
        providerId: 'nous',
        authType: 'api_key',
        credentials: {
          apiKey: 'sk-nous-super-secret-key-999',
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      });

      mockServer.configureOpenAIChat({
        content: 'Hermes reasoning answer',
        model: 'hermes-3-llama-3.1-70b',
      });

      const req: CanonicalRequest = {
        id: 'req_lat_nous_01',
        clientDialect: 'openai-chat',
        model: 'nous/hermes-3-llama-3.1-70b',
        messages: [{ role: 'user', content: 'Explain logic' }],
        stream: false,
      };

      const res = await nous.execute(req);
      expect((res.content[0] as any).text).toBe('Hermes reasoning answer');

      const recorded = mockServer.getRequests();
      expect(recorded.length).toBe(1);
      expect(recorded[0].headers['authorization']).toBe('Bearer sk-nous-super-secret-key-999');
      expect(recorded[0].headers['connection']).toBe('close');
    });

    it('lists curated Hermes model catalog including direct aliases', async () => {
      const nous = new NousProviderPlugin(mockServer.url);
      const models = await nous.listModels();

      expect(models.length).toBeGreaterThanOrEqual(8);
      const hermes8b = models.find((m) => m.id === 'nous/hermes-3-llama-3.1-8b');
      expect(hermes8b).toBeDefined();
      expect(hermes8b?.supportsTools).toBe(true);
      expect(hermes8b?.supportsThinking).toBe(true);

      const hermes70b = models.find((m) => m.id === 'nous/hermes-3-llama-3.1-70b');
      expect(hermes70b).toBeDefined();

      const hermes405b = models.find((m) => m.id === 'nous/hermes-3-llama-3.1-405b');
      expect(hermes405b).toBeDefined();

      const directAlias = models.find((m) => m.id === 'hermes-3-llama-3.1-8b');
      expect(directAlias).toBeDefined();
    });

    it('executes Nous Portal OAuth device flow and token exchange', async () => {
      const nous = new NousProviderPlugin(mockServer.url);

      // 1. Request Portal Auth
      const auth = await nous.requestPortalAuth('nous_hermes_cli');
      expect(auth.auth_url).toContain('portal.nousresearch.com');
      expect(auth.session_id).toBe('nous_sess_mock_123');

      // 2. Poll Portal Token
      const token = await nous.pollPortalToken(auth.session_id);
      expect(token.access_token).toBe('sk-nous-valid-token-mock');
      expect(token.token_type).toBe('Bearer');

      // 3. refreshAuth
      const refreshed = await nous.refreshAuth({
        id: 'acc_nous_oauth',
        providerId: 'nous',
        authType: 'oauth',
        credentials: {
          customData: { sessionId: auth.session_id },
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      });
      expect(refreshed.credentials.apiKey).toBe('sk-nous-valid-token-mock');
    });

    it('performs live healthCheck and probe methods', async () => {
      const nous = new NousProviderPlugin(mockServer.url);
      const health = await nous.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('operational');
      expect(health.checkedAt).toBeGreaterThan(0);

      const probe = await nous.probe();
      expect(probe.healthy).toBe(true);
      expect(probe.modelsCount).toBeGreaterThan(0);
    });

    it('normalizes Hermes XML tool calls in non-streaming execute()', async () => {
      const nous = new NousProviderPlugin(mockServer.url);
      mockServer.configureOpenAIChat({
        content:
          'Calculating expression...\n<tool_call>\n<function=calculator>\n<parameter=expr>2+2</parameter>\n</tool_call>',
      });

      const req: CanonicalRequest = {
        id: 'req_lat_nous_xml',
        clientDialect: 'openai-chat',
        model: 'nous/hermes-3-llama-3.1-8b',
        messages: [{ role: 'user', content: 'Compute 2+2' }],
        stream: false,
      };

      const res = await nous.execute(req);
      expect(res.stopReason).toBe('tool_calls');
      expect(res.content.some((c) => c.type === 'tool_use' && c.name === 'calculator')).toBe(true);
      const textPart = res.content.find((c) => c.type === 'text');
      expect(textPart?.text).toBe('Calculating expression...');
    });

    it('normalizes Hermes XML tool calls in streaming executeStream()', async () => {
      const nous = new NousProviderPlugin(mockServer.url);

      // Raw chunks containing Hermes XML markup
      mockServer.simulateRawStream([
        'data: {"choices":[{"delta":{"content":"Let me calculate:\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<tool_call>\\n<function=calculator>\\n<parameter=expr>5*5</parameter>\\n</tool_call>"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);

      const req: CanonicalRequest = {
        id: 'req_lat_nous_stream_xml',
        clientDialect: 'openai-chat',
        model: 'nous/hermes-3-llama-3.1-8b',
        messages: [{ role: 'user', content: 'Compute 5*5' }],
        stream: true,
      };

      const stream = await nous.executeStream(req);
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify that XML tool markup was stripped from text_delta and converted to tool_call events
      const textEvents = events.filter((e) => e.type === 'text_delta');
      for (const te of textEvents) {
        expect((te as any).delta).not.toContain('<tool_call>');
      }

      const toolStart = events.find((e) => e.type === 'tool_call_start') as any;
      expect(toolStart).toBeDefined();
      expect(toolStart.name).toBe('calculator');

      const toolDelta = events.find((e) => e.type === 'tool_call_delta') as any;
      expect(toolDelta).toBeDefined();
      expect(toolDelta.argumentsDelta).toContain('5*5');

      const endEvent = events.find((e) => e.type === 'stream_end') as any;
      expect(endEvent).toBeDefined();
      expect(endEvent.stopReason).toBe('tool_calls');
    });

    it('classifies 401, 429, and upstream errors', () => {
      const nous = new NousProviderPlugin();
      const authErr = nous.classifyError(new Error('401'), 401);
      expect(authErr.category).toBe('authentication');
      expect(authErr.isRetryable).toBe(false);

      const rateErr = nous.classifyError(new Error('429'), 429);
      expect(rateErr.category).toBe('rate_limit');
      expect(rateErr.isRetryable).toBe(true);
      expect(rateErr.cooldownDurationMs).toBe(60_000);
    });
  });
});
