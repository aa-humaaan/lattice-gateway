import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ClinePoolPlugin,
  WORKOS_CLIENT_ID,
  WORKOS_DEVICE_AUTH_URL,
  WORKOS_AUTHENTICATE_URL,
  CLINE_API_BASE,
  CLINE_CHAT_URL,
  CLINE_CLIENT_VERSION,
  CLINE_CORE_VERSION,
  startWorkosDeviceAuth,
  pollWorkosToken,
  registerWithCline,
  refreshClineToken,
  parseClineRetryAfter,
  parseHumanDurationSeconds,
  isClineQuotaExhausted,
  parseClineExpiry,
} from '../../src/plugins/cline';
import type { StoredAccount } from '../../src/core/types/plugin';

describe('Cline Plugin Production Logic & Contract Suite', () => {
  let plugin: ClinePoolPlugin;

  beforeEach(() => {
    plugin = new ClinePoolPlugin();
  });

  // Requirement 1: WorkOS Client ID & Constants
  it('1. configures authentic WorkOS client ID, version numbers, and API URLs', () => {
    expect(WORKOS_CLIENT_ID).toBe('client_01K3A541FN8TA3EPPHTD2325AR');
    expect(WORKOS_DEVICE_AUTH_URL).toBe('https://api.workos.com/user_management/authorize/device');
    expect(WORKOS_AUTHENTICATE_URL).toBe('https://api.workos.com/user_management/authenticate');
    expect(CLINE_API_BASE).toBe('https://api.cline.bot/api/v1');
    expect(CLINE_CHAT_URL).toBe('https://api.cline.bot/api/v1/chat/completions');
    expect(CLINE_CLIENT_VERSION).toBe('3.0.70');
    expect(CLINE_CORE_VERSION).toBe('0.0.92');
  });

  // Requirement 2: Device Authorization Flow & Polling
  describe('2. Device authorization flow', () => {
    it('initiates device authorization with workos client_id', async () => {
      // Mock fetch for device auth URL
      const origFetch = globalThis.fetch;
      try {
        let sentUrl = '';
        let sentBody = '';
        let sentMethod = '';

        globalThis.fetch = (async (url: any, opts: any) => {
          sentUrl = String(url);
          sentMethod = opts?.method;
          sentBody = String(opts?.body);
          return new Response(
            JSON.stringify({
              device_code: 'dev_code_123',
              user_code: 'WDJB-9MNP',
              verification_uri: 'https://workos.com/device',
              verification_uri_complete: 'https://workos.com/device?code=WDJB-9MNP',
              interval: 5,
              expires_in: 300,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as any;

        const res = await startWorkosDeviceAuth();
        expect(sentUrl).toBe(WORKOS_DEVICE_AUTH_URL);
        expect(sentMethod).toBe('POST');
        expect(sentBody).toContain(`client_id=${WORKOS_CLIENT_ID}`);
        expect(res.device_code).toBe('dev_code_123');
        expect(res.user_code).toBe('WDJB-9MNP');
        expect(res.interval).toBe(5);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('polls authenticate endpoint and returns tokens on success', async () => {
      const origFetch = globalThis.fetch;
      try {
        let callCount = 0;
        let sentUrl = '';
        let sentBody = '';

        globalThis.fetch = (async (url: any, opts: any) => {
          sentUrl = String(url);
          sentBody = String(opts?.body);
          callCount++;
          if (callCount === 1) {
            return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
          }
          return new Response(
            JSON.stringify({
              access_token: 'wos_access_abc',
              refresh_token: 'wos_refresh_xyz',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as any;

        // Pass 0 interval so test runs fast
        const res = await pollWorkosToken('dev_code_123', {
          interval: 0,
          expiresIn: 10,
        });

        expect(sentUrl).toBe(WORKOS_AUTHENTICATE_URL);
        expect(sentBody).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
        expect(sentBody).toContain('device_code=dev_code_123');
        expect(sentBody).toContain(`client_id=${WORKOS_CLIENT_ID}`);
        expect(res.access_token).toBe('wos_access_abc');
        expect(res.refresh_token).toBe('wos_refresh_xyz');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('registers with Cline upstream using WorkOS tokens', async () => {
      const origFetch = globalThis.fetch;
      try {
        let sentUrl = '';
        let sentPayload: any = null;

        globalThis.fetch = (async (url: any, opts: any) => {
          sentUrl = String(url);
          sentPayload = JSON.parse(opts?.body);
          return new Response(
            JSON.stringify({
              data: {
                accessToken: 'cline_act_123',
                refreshToken: 'cline_rft_456',
                expiresAt: '2026-11-16T12:00:00Z',
                userInfo: { email: 'developer@example.com' },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as any;

        const reg = await registerWithCline('wos_act_111', 'wos_rft_222');
        expect(sentUrl).toBe('https://api.cline.bot/api/v1/auth/register');
        expect(sentPayload.accessToken).toBe('wos_act_111');
        expect(sentPayload.refreshToken).toBe('wos_rft_222');
        expect(reg.data.accessToken).toBe('cline_act_123');
        expect(reg.data.userInfo?.email).toBe('developer@example.com');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // Requirement 3: Cline Token Refresh
  describe('3. Cline Token Refresh', () => {
    it('sends POST to /api/v1/auth/refresh with { refreshToken, grantType: "refresh_token" }', async () => {
      const origFetch = globalThis.fetch;
      try {
        let sentUrl = '';
        let sentBody: any = null;

        globalThis.fetch = (async (url: any, opts: any) => {
          sentUrl = String(url);
          sentBody = JSON.parse(opts?.body);
          return new Response(
            JSON.stringify({
              data: {
                accessToken: 'new_cline_access_token',
                refreshToken: 'new_cline_refresh_token',
                expiresAt: 1731780000000,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as any;

        const refreshed = await refreshClineToken('old_refresh_token_789');
        expect(sentUrl).toBe('https://api.cline.bot/api/v1/auth/refresh');
        expect(sentBody.refreshToken).toBe('old_refresh_token_789');
        expect(sentBody.grantType).toBe('refresh_token');
        expect(refreshed.accessToken).toBe('new_cline_access_token');
        expect(refreshed.refreshToken).toBe('new_cline_refresh_token');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('refreshes account instance credentials via plugin.refreshToken()', async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(
            JSON.stringify({
              data: {
                accessToken: 'refreshed_access_token_via_instance',
                refreshToken: 'refreshed_refresh_token_via_instance',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as any;

        const acc: StoredAccount = {
          id: 'acc_inst_1',
          providerId: 'cline',
          authType: 'oauth',
          credentials: { accessToken: 'old_acc', refreshToken: 'old_ref' },
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          errorCount: 0,
        };

        const res = await plugin.refreshToken(acc);
        expect(res.credentials.accessToken).toBe('refreshed_access_token_via_instance');
        expect(res.credentials.refreshToken).toBe('refreshed_refresh_token_via_instance');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // Requirement 4: Correct Chat Base URL
  describe('4. Correct Chat Base URL', () => {
    it('resolves chat URL to https://api.cline.bot/api/v1/chat/completions (NOT /v1)', () => {
      const defaultPlugin = new ClinePoolPlugin();
      expect(defaultPlugin.defaultBaseUrl).toBe('https://api.cline.bot/api/v1');
      expect(defaultPlugin.getChatUrl()).toBe('https://api.cline.bot/api/v1/chat/completions');

      // Also when configured with base URL
      const customPlugin = new ClinePoolPlugin('https://api.cline.bot/api/v1');
      expect(customPlugin.getChatUrl()).toBe('https://api.cline.bot/api/v1/chat/completions');
    });
  });

  // Requirement 5: Required Upstream Headers
  describe('5. Required upstream headers', () => {
    it('sets HTTP-Referer, X-Title, User-Agent, and Bearer token', () => {
      const acc: StoredAccount = {
        id: 'acc_headers_test',
        providerId: 'cline',
        authType: 'oauth',
        credentials: { accessToken: 'cline_tok_alpha' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      };

      const headers = plugin.buildHeaders(acc, 'session_task_123');
      expect(headers['HTTP-Referer']).toBe('https://cline.bot');
      expect(headers['X-Title']).toBe('Cline');
      expect(headers['User-Agent']).toBe('Cline/3.0.70');
      expect(headers['Authorization']).toBe('Bearer cline_tok_alpha');
      expect(headers['X-Task-ID']).toBe('session_task_123');
      expect(headers['X-CLIENT-TYPE']).toBe('cline-cli');
      expect(headers['X-CLIENT-VERSION']).toBe('3.0.70');
      expect(headers['X-CORE-VERSION']).toBe('0.0.92');
    });
  });

  // Requirement 6: Multi-account rotation with dynamic cooldown on 429
  describe('6. Multi-account rotation with dynamic cooldown on 429', () => {
    it('rotates multiple accounts in round-robin sequence', () => {
      const acc1: StoredAccount = {
        id: 'acc_1',
        providerId: 'cline',
        authType: 'oauth',
        credentials: { accessToken: 'tok_1' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      };
      const acc2: StoredAccount = {
        id: 'acc_2',
        providerId: 'cline',
        authType: 'oauth',
        credentials: { accessToken: 'tok_2' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      };

      plugin.addAccount(acc1);
      plugin.addAccount(acc2);

      const first = plugin.getActiveAccount();
      const second = plugin.getActiveAccount();
      const third = plugin.getActiveAccount();

      expect(first?.id).toBe('acc_1');
      expect(second?.id).toBe('acc_2');
      expect(third?.id).toBe('acc_1');
    });

    it('parses various human durations in 429 bodies ("Try again in 17h 59m", "1d 2h", "45s")', () => {
      expect(parseHumanDurationSeconds('17h 59m')).toBe(17 * 3600 + 59 * 60);
      expect(parseHumanDurationSeconds('1d 2h 30m')).toBe(86400 + 2 * 3600 + 30 * 60);
      expect(parseHumanDurationSeconds('45s')).toBe(45);
      expect(parseHumanDurationSeconds('10m')).toBe(600);
      expect(parseHumanDurationSeconds('')).toBe(0);

      expect(parseClineRetryAfter(undefined, 'Rate limit hit. Try again in 17h 59m')).toBe(64740);
      expect(parseClineRetryAfter(undefined, 'Try again in 2 hours.')).toBe(7200);
      expect(parseClineRetryAfter(undefined, 'Try again in 30 seconds.')).toBe(30);
    });

    it('detects quota exhaustion keywords and assigns 18-hour cooldown', () => {
      expect(isClineQuotaExhausted('Error: daily limit reached for free tier')).toBe(true);
      expect(isClineQuotaExhausted('Error: monthly limit exceeded')).toBe(true);
      expect(isClineQuotaExhausted('You have insufficient quota to complete request')).toBe(true);
      expect(isClineQuotaExhausted('Random network issue')).toBe(false);

      expect(parseClineRetryAfter(undefined, 'Your account quota exceeded. Please upgrade.')).toBe(18 * 3600);
    });

    it('parses expiry timestamps properly', () => {
      const now = Date.now();
      expect(parseClineExpiry(now)).toBe(now);
      expect(parseClineExpiry(Math.floor(now / 1000))).toBe(Math.floor(now / 1000) * 1000);
      expect(parseClineExpiry('2026-11-16T12:00:00Z')).toBe(Date.parse('2026-11-16T12:00:00Z'));
    });

    it('transitions account to cooldown on 429 and fails over to healthy account', async () => {
      const acc1: StoredAccount = {
        id: 'acc_ratelimited',
        providerId: 'cline',
        authType: 'oauth',
        credentials: { accessToken: 'tok_limited' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      };
      const acc2: StoredAccount = {
        id: 'acc_healthy',
        providerId: 'cline',
        authType: 'oauth',
        credentials: { accessToken: 'tok_healthy' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      };

      plugin.addAccount(acc1);
      plugin.addAccount(acc2);

      const origFetch = globalThis.fetch;
      try {
        let callCount = 0;
        globalThis.fetch = (async (_url: any, opts: any) => {
          callCount++;
          const headers = opts?.headers || {};
          if (headers['Authorization'] === 'Bearer tok_limited') {
            return new Response(
              JSON.stringify({ error: 'Try again in 10 minutes' }),
              { status: 429, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              id: 'chatcmpl_healthy_turn',
              choices: [{ message: { content: 'Healthy account response' } }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }) as any;

        const res = await plugin.execute({
          id: 'req_123',
          clientDialect: 'openai-chat',
          stream: false,
          model: 'cline/claude-3-7-sonnet',
          messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(res.content[0].type).toBe('text');
        expect((res.content[0] as any).text).toBe('Healthy account response');
        expect(callCount).toBe(2);
        expect(acc1.status).toBe('cooldown');
        expect(acc1.cooldownUntil).toBeGreaterThan(Date.now() + 500_000);
        expect(acc2.status).toBe('active');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  // Model catalog check
  it('lists models including free tier and reasoning models', async () => {
    const models = await plugin.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.some((m) => m.id === 'cline/claude-3-7-sonnet')).toBe(true);
    expect(models.some((m) => m.id === 'cline/sonnet-agent')).toBe(true);
    expect(models.some((m) => m.id === 'cline-free/mimo-v2.6-flash')).toBe(true);
  });
});
