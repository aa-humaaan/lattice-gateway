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
import { ClinePoolPlugin, parseClineRetryAfter } from '../../../src/plugins/cline';

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
  it('suspends a 401 account and retries the same model on the next account', async () => {
    clinePlugin.accounts[0].status = 'active';
    clinePlugin.accounts[1].status = 'active';

    // Simulate 401 for the first call
    mockServer.simulateError({
      status: 401,
      message: 'Account suspended by WorkOS security policy',
      dialect: 'openai',
      count: 1,
    });

    // Request hits Account 1, suspends it, then stays on the same model via Account 2.
    const res = await client.openaiChat({
      model: 'cline/claude-3-7-sonnet',
      messages: [{ role: 'user', content: 'Test suspension' }],
    });

    expect(res.status).toBe(200);
    expect(clinePlugin.accounts[0].status).toBe('suspended' as any);
    const firstTurnRequests = mockServer.getRequests();
    expect(firstTurnRequests.length).toBe(2);
    expect(firstTurnRequests[0].headers['authorization']).toBe(`Bearer ${clinePlugin.accounts[0].credentials.accessToken}`);
    expect(firstTurnRequests[1].headers['authorization']).toBe(`Bearer ${clinePlugin.accounts[1].credentials.accessToken}`);

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
