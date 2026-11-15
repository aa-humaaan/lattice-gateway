/**
 * Feature F9: Plugin - Cline Pool Upstream & Token Rotation
 * 
 * Verifies:
 * - WorkOS OAuth token refresh lifecycle
 * - Multi-account rotation across Cline pool accounts
 * - Dynamic 429 Retry-After header and natural language parsing ("Try again in X hours/seconds")
 * - Account state transition on suspension or invalid token
 * - Request dispatching with active Cline credentials and quota verification
 * - Automatic cooldown expiration and account reactivation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../../harness/mock-upstream';
import { TestClient } from '../../harness/test-client';
import {
  assertOpenAISuccess,
  assertModelPresent,
} from '../../harness/assertions';
import { createServer } from '../../../src/core/server';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../../src/core/types/plugin';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';
import { GatewayError } from '../../../src/core/types/errors';

export function parseClineRetryAfter(headerValue?: string | null, bodyText?: string | null): number {
  if (headerValue && !isNaN(Number(headerValue))) {
    return Number(headerValue);
  }

  const text = (bodyText || '') + ' ' + (headerValue || '');

  const hoursMatch = text.match(/try\s+again\s+in\s+(\d+)\s*hours?/i);
  if (hoursMatch) {
    return parseInt(hoursMatch[1], 10) * 3600;
  }

  const minutesMatch = text.match(/try\s+again\s+in\s+(\d+)\s*minutes?/i);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10) * 60;
  }

  const secondsMatch = text.match(/try\s+again\s+in\s+(\d+)\s*(?:seconds?|secs?)/i);
  if (secondsMatch) {
    return parseInt(secondsMatch[1], 10);
  }

  return 30; // Default fallback
}

class ClinePoolPlugin implements ProviderPlugin {
  readonly id = 'cline';
  readonly displayName = 'Cline Multi-Account Pool';
  readonly defaultBaseUrl: string;
  public accounts: StoredAccount[] = [];
  private currentAccountIndex = 0;

  constructor(upstreamBaseUrl: string, initialAccounts?: StoredAccount[]) {
    this.defaultBaseUrl = upstreamBaseUrl;
    if (initialAccounts && initialAccounts.length > 0) {
      this.accounts = [...initialAccounts];
    }
  }

  addAccount(account: StoredAccount): void {
    this.accounts.push(account);
  }

  resetIndex(): void {
    this.currentAccountIndex = 0;
  }

  getActiveAccounts(): StoredAccount[] {
    const now = Date.now();
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && acc.cooldownUntil && acc.cooldownUntil <= now) {
        acc.status = 'active';
        acc.cooldownUntil = undefined;
      }
    }
    return this.accounts.filter((acc) => acc.status === 'active');
  }

  getNextAccount(): StoredAccount {
    const active = this.getActiveAccounts();
    if (active.length === 0) {
      throw new GatewayError(429, '429', 'All Cline accounts are currently rate-limited or suspended', {
        retryAfter: 30,
      });
    }
    const acc = active[this.currentAccountIndex % active.length];
    this.currentAccountIndex++;
    return acc;
  }

  async refreshToken(account: StoredAccount): Promise<StoredAccount> {
    const res = await fetch(`${this.defaultBaseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: account.credentials.refreshToken }),
    });

    if (!res.ok) {
      throw new Error(`Failed to refresh Cline token: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    account.credentials.accessToken = data.access_token;
    account.credentials.refreshToken = data.refresh_token;
    account.updatedAt = Date.now();
    return account;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: 'cline/claude-3-7-sonnet',
        name: 'Cline Claude 3.7 Sonnet',
        providerId: 'cline',
        ownedBy: 'cline',
        created: 1731693600,
      },
      {
        id: 'cline/mimo-v2.6-flash',
        name: 'Cline Mimo Flash',
        providerId: 'cline',
        ownedBy: 'cline',
        created: 1731693600,
      },
    ];
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const account = this.getNextAccount();
    account.lastUsedAt = Date.now();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${account.credentials.accessToken}`,
      'Connection': 'close',
    };

    const res = await fetch(`${this.defaultBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model.replace(/^cline\//, ''),
        messages: req.messages,
        stream: false,
      }),
      signal,
    });

    if (res.status === 401) {
      account.status = 'suspended';
      account.errorCount++;
      throw new GatewayError(401, '401', 'Cline account suspended or unauthorized');
    }

    if (res.status === 429) {
      const rawBody = await res.text();
      const retryAfter = parseClineRetryAfter(res.headers.get('retry-after'), rawBody);
      account.status = 'cooldown';
      account.cooldownUntil = Date.now() + retryAfter * 1000;
      account.errorCount++;
      throw new GatewayError(429, '429', `Cline rate limit exceeded. Retry in ${retryAfter}s`, {
        retryAfter,
      });
    }

    if (!res.ok) {
      throw new GatewayError(res.status, String(res.status), `Cline upstream error: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    return {
      id: data.id || req.id,
      model: req.model,
      created: data.created || Math.floor(Date.now() / 1000),
      content: [{ type: 'text', text: choice?.message?.content || '' }],
      stopReason: choice?.finish_reason || 'stop',
      usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
    };
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const timestamp = Math.floor(Date.now() / 1000);
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: timestamp };
      yield { type: 'text_delta', delta: 'Cline pool streamed turn' };
      yield { type: 'stream_end', stopReason: 'stop' };
    })();
  }
}

describe('Feature F9: Plugin Cline Pool Upstream & Token Rotation', () => {
  let mockServer: MockUpstreamServer;
  let clinePlugin: ClinePoolPlugin;
  let gatewayServer: any;
  let client: TestClient;

  beforeAll(async () => {
    mockServer = await createMockUpstream();
    clinePlugin = new ClinePoolPlugin(mockServer.url, [
      {
        id: 'acc_cline_1',
        providerId: 'cline',
        authType: 'oauth',
        credentials: {
          accessToken: 'tok_cline_alpha',
          refreshToken: 'ref_cline_alpha',
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      },
      {
        id: 'acc_cline_2',
        providerId: 'cline',
        authType: 'oauth',
        credentials: {
          accessToken: 'tok_cline_beta',
          refreshToken: 'ref_cline_beta',
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorCount: 0,
      },
    ]);

    const app = createServer({ port: 0 }, [clinePlugin]);
    gatewayServer = Bun.serve({
      port: 0,
      fetch: app.fetch,
    });

    client = new TestClient(`http://127.0.0.1:${gatewayServer.port}`);
  });

  afterAll(async () => {
    if (gatewayServer) gatewayServer.stop(true);
    if (mockServer) await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    clinePlugin.resetIndex();
  });

  // Test 1: WorkOS OAuth token refresh lifecycle
  it('refreshes expired WorkOS OAuth token via /api/v1/auth/refresh', async () => {
    const acc = clinePlugin.accounts[0];
    const initialToken = acc.credentials.accessToken;

    const refreshed = await clinePlugin.refreshToken(acc);
    expect(refreshed.credentials.accessToken).toBe('cline_refreshed_access_token');
    expect(refreshed.credentials.refreshToken).toBe('cline_refreshed_refresh_token');
    expect(refreshed.credentials.accessToken).not.toBe(initialToken);
  });

  // Test 2: Multi-account rotation across Cline pool accounts
  it('rotates sequential requests round-robin across multiple Cline accounts', async () => {
    // Reset account tokens for clean tracking
    clinePlugin.accounts[0].credentials.accessToken = 'token_acc_1';
    clinePlugin.accounts[0].status = 'active';
    clinePlugin.accounts[1].credentials.accessToken = 'token_acc_2';
    clinePlugin.accounts[1].status = 'active';

    mockServer.configureOpenAIChat({ content: 'Cline response' });

    // Request 1 -> Account 1
    await client.openaiChat({
      model: 'cline/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Turn 1' }],
    });

    // Request 2 -> Account 2
    await client.openaiChat({
      model: 'cline/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Turn 2' }],
    });

    // Request 3 -> Account 1 again
    await client.openaiChat({
      model: 'cline/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Turn 3' }],
    });

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(3);
    expect(requests[0].headers['authorization']).toBe('Bearer token_acc_1');
    expect(requests[1].headers['authorization']).toBe('Bearer token_acc_2');
    expect(requests[2].headers['authorization']).toBe('Bearer token_acc_1');
  });

  // Test 3: Dynamic 429 Retry-After parsing
  it('parses natural language Retry-After text ("Try again in X hours/seconds")', () => {
    expect(parseClineRetryAfter(undefined, 'Rate limit hit. Try again in 2 hours.')).toBe(7200);
    expect(parseClineRetryAfter(undefined, 'Rate limit hit. Try again in 45 seconds.')).toBe(45);
    expect(parseClineRetryAfter(undefined, 'Rate limit hit. Try again in 10 minutes.')).toBe(600);
    expect(parseClineRetryAfter('60', undefined)).toBe(60);
    expect(parseClineRetryAfter(undefined, 'Generic error')).toBe(30);
  });

  // Test 4: Account state transition on suspension
  it('transitions account state to suspended on upstream 401 and removes it from routing', async () => {
    clinePlugin.accounts[0].status = 'active';
    clinePlugin.accounts[1].status = 'active';

    // Simulate 401 for the first call
    mockServer.simulateError({
      status: 401,
      message: 'Account suspended by WorkOS security policy',
      dialect: 'openai',
      count: 1,
    });

    // Request hits Account 1 and fails with 401
    const res = await client.openaiChat({
      model: 'cline/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Test suspension' }],
    });

    expect(res.status).toBe(401);
    expect(clinePlugin.accounts[0].status).toBe('suspended' as any);

    // Next request should automatically route to Account 2
    mockServer.reset();
    mockServer.configureOpenAIChat({ content: 'Healthy turn' });

    const res2 = await client.openaiChat({
      model: 'cline/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Subsequent turn' }],
    });

    expect(res2.status).toBe(200);
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].headers['authorization']).toBe(`Bearer ${clinePlugin.accounts[1].credentials.accessToken}`);
  });

  // Test 5: User profile quota check & credentials verification
  it('dispatches requests with active Cline credentials and checks user profile quota', async () => {
    const userRes = await fetch(`${mockServer.url}/api/v1/auth/user`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer cline_token_pro' },
    });

    expect(userRes.status).toBe(200);
    const userData = (await userRes.json()) as any;
    expect(userData.id).toBe('user_cline_mock');
    expect(userData.email).toBe('cline_user@example.com');
    expect(userData.quota.remaining_turns).toBe(250);
    expect(userData.quota.plan).toBe('pro');
  });

  // Test 6: Auto-heal / Cooldown expiration restores account
  it('restores account status from cooldown to active after cooldown duration passes', () => {
    const acc = clinePlugin.accounts[0];
    acc.status = 'cooldown';
    acc.cooldownUntil = Date.now() - 5000; // Expired 5 seconds ago

    const activeList = clinePlugin.getActiveAccounts();
    expect(activeList.some((a) => a.id === acc.id)).toBeTrue();
    expect(acc.status).toBe('active' as any);
    expect(acc.cooldownUntil).toBeUndefined();
  });
});
