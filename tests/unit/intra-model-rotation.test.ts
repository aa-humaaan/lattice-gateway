import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import { NousProviderPlugin } from '../../src/plugins/nous';
import { ClinePoolPlugin } from '../../src/plugins/cline';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { globalComboManager } from '../../src/pool/combos';
import { globalAccountPool } from '../../src/pool/account-pool';
import { createMockUpstream, type MockUpstreamServer } from '../harness/mock-upstream';
import type { CanonicalRequest } from '../../src/core/types/canonical';
import type { StoredAccount } from '../../src/core/types/plugin';
import { createSessionAffinityStore } from '../../src/core/session-affinity';

describe('Unit: Multi-Account Intra-Model Rotation Engine', () => {
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

  it('rotates from Account 1 to Account 2 for the exact same model when Account 1 hits 429', async () => {
    const kilo = new KiloProviderPlugin(mockServer.url);

    // Register 2 distinct accounts for Kilo
    const acc1: StoredAccount = {
      id: 'acc_kilo_rot_1',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'key_account_alpha' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };
    const acc2: StoredAccount = {
      id: 'acc_kilo_rot_2',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'key_account_beta' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };

    kilo.addAccount(acc1);
    kilo.addAccount(acc2);
    kilo.currentAccount = acc1;

    // Upstream configuration:
    // If request comes with key_account_alpha -> return 429
    // If request comes with key_account_beta -> return 200 OK
    let attemptCount = 0;
    mockServer.onRequest((req, body, recorded) => {
      attemptCount++;
      const auth = recorded.headers['authorization'];
      if (auth === 'Bearer key_account_alpha') {
        return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '25' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_nemotron_ok',
          choices: [{ message: { content: 'Nemotron response from Account 2' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const canonicalReq: CanonicalRequest = {
      id: 'req_nemotron_rotation',
      clientDialect: 'openai-chat',
      model: 'kilo/nvidia/nemotron-3.5-lightning:free',
      messages: [{ role: 'user', content: 'Generate high-throughput code' }],
      stream: false,
    };

    const res = await kilo.execute(canonicalReq);
    expect(res).toBeDefined();
    expect((res.content[0] as any).text).toBe('Nemotron response from Account 2');
    expect(attemptCount).toBe(2);

    // Verify account 1 was put into cooldown
    expect(acc1.status).toBe('cooldown');
    expect(acc1.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('uses the session-pinned account before provider default order', async () => {
    const affinity = createSessionAffinityStore();
    const kilo = new KiloProviderPlugin(mockServer.url, undefined, affinity);
    const acc1: StoredAccount = {
      id: 'acc_pin_1', providerId: 'kilo', authType: 'api_key',
      credentials: { apiKey: 'pin_key_1' }, status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0,
    };
    const acc2: StoredAccount = {
      id: 'acc_pin_2', providerId: 'kilo', authType: 'api_key',
      credentials: { apiKey: 'pin_key_2' }, status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0,
    };
    kilo.addAccount(acc1);
    kilo.addAccount(acc2);
    kilo.currentAccount = acc1;
    affinity.pinAccount('ses_pinned', 'kilo', acc2.id);
    const authorizations: string[] = [];
    mockServer.onRequest((_req, _body, recorded) => {
      authorizations.push(recorded.headers['authorization']);
      return new Response(JSON.stringify({
        id: 'pinned', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await kilo.execute({
      id: 'request', clientDialect: 'openai-chat', model: 'kilo/model',
      messages: [{ role: 'user', content: 'hi' }], stream: false,
      affinity: { sessionKey: 'ses_pinned' },
    });
    expect(authorizations[0]).toBe('Bearer pin_key_2');
  });

  it('repins the successful account after same-model 429 rotation', async () => {
    const affinity = createSessionAffinityStore();
    const kilo = new KiloProviderPlugin(mockServer.url, undefined, affinity);
    const acc1: StoredAccount = {
      id: 'acc_repin_1', providerId: 'kilo', authType: 'api_key',
      credentials: { apiKey: 'repin_key_1' }, status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0,
    };
    const acc2: StoredAccount = {
      id: 'acc_repin_2', providerId: 'kilo', authType: 'api_key',
      credentials: { apiKey: 'repin_key_2' }, status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0,
    };
    kilo.addAccount(acc1);
    kilo.addAccount(acc2);
    affinity.pinAccount('ses_repin', 'kilo', acc1.id);
    mockServer.onRequest((_req, _body, recorded) => {
      if (recorded.headers['authorization'] === 'Bearer repin_key_1') {
        return new Response('{}', { status: 429, headers: { 'Retry-After': '10' } });
      }
      return new Response(JSON.stringify({
        id: 'repinned', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await kilo.execute({
      id: 'request', clientDialect: 'openai-chat', model: 'kilo/model',
      messages: [{ role: 'user', content: 'hi' }], stream: false,
      affinity: { sessionKey: 'ses_repin' },
    });
    expect(affinity.getAccount('ses_repin', 'kilo')).toBe(acc2.id);
  });

  it('Cline retries another account on 401 before allowing model fallback', async () => {
    const affinity = createSessionAffinityStore();
    const accounts: StoredAccount[] = [
      {
        id: 'cline_401_first', providerId: 'cline', authType: 'api_key',
        credentials: { apiKey: 'cline_bad_key' }, status: 'active',
        createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0,
      },
      {
        id: 'cline_401_second', providerId: 'cline', authType: 'api_key',
        credentials: { apiKey: 'cline_good_key' }, status: 'active',
        createdAt: Date.now(), updatedAt: Date.now(), errorCount: 0,
      },
    ];
    const cline = new ClinePoolPlugin(mockServer.url, accounts, affinity);
    affinity.pinAccount('ses_cline_401', 'cline', accounts[0].id);
    mockServer.onRequest((_req, _body, recorded) => {
      if (recorded.headers['authorization'] === 'Bearer cline_bad_key') {
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify({
        id: 'cline-ok', choices: [{ message: { content: 'same model' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const response = await cline.execute({
      id: 'request', clientDialect: 'openai-chat', model: 'cline/model',
      messages: [{ role: 'user', content: 'hi' }], stream: false,
      affinity: { sessionKey: 'ses_cline_401' },
    });
    expect((response.content[0] as any).text).toBe('same model');
    expect(affinity.getAccount('ses_cline_401', 'cline')).toBe(accounts[1].id);
  });

  it('rotates across accounts transparently during streaming requests on 429', async () => {
    const kilo = new KiloProviderPlugin(mockServer.url);

    const acc1: StoredAccount = {
      id: 'acc_kilo_stream_1',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'stream_key_1' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };
    const acc2: StoredAccount = {
      id: 'acc_kilo_stream_2',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'stream_key_2' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };

    kilo.addAccount(acc1);
    kilo.addAccount(acc2);
    kilo.currentAccount = acc1;

    mockServer.onRequest((req, body, recorded) => {
      const auth = recorded.headers['authorization'];
      if (auth === 'Bearer stream_key_1') {
        return new Response(JSON.stringify({ error: { message: 'Quota limit' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
        });
      }

      // Successful SSE stream for account 2
      const encoder = new TextEncoder();
      const sseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Stream chunk from Account 2"}}]}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const stream = await kilo.executeStream({
      id: 'req_stream_rot',
      clientDialect: 'openai-chat',
      model: 'kilo/nvidia/nemotron-3.5-lightning:free',
      messages: [{ role: 'user', content: 'Stream test' }],
      stream: true,
    });

    const chunks: string[] = [];
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        chunks.push(event.delta);
      }
    }

    expect(chunks.join('')).toBe('Stream chunk from Account 2');
    expect(acc1.status).toBe('cooldown');
  });

  it('rotates across Nous Research accounts when primary account hits rate limit', async () => {
    const nous = new NousProviderPlugin(mockServer.url);

    const acc1: StoredAccount = {
      id: 'acc_nous_rot_1',
      providerId: 'nous',
      authType: 'api_key',
      credentials: { apiKey: 'sk-nous-alpha' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };
    const acc2: StoredAccount = {
      id: 'acc_nous_rot_2',
      providerId: 'nous',
      authType: 'api_key',
      credentials: { apiKey: 'sk-nous-beta' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };

    nous.addAccount(acc1);
    nous.addAccount(acc2);
    nous.currentAccount = acc1;

    mockServer.onRequest((req, body, recorded) => {
      const auth = recorded.headers['authorization'];
      if (auth === 'Bearer sk-nous-alpha') {
        return new Response(JSON.stringify({ error: { message: 'Nous 429' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '15' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_hermes_ok',
          choices: [{ message: { content: 'Hermes response from Account 2' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await nous.execute({
      id: 'req_hermes_rotation',
      clientDialect: 'openai-chat',
      model: 'nous/hermes-3-llama-3.1-70b',
      messages: [{ role: 'user', content: 'Hermes reasoning' }],
      stream: false,
    });

    expect((res.content[0] as any).text).toBe('Hermes response from Account 2');
    expect(acc1.status).toBe('cooldown');
  });

  it('keeps combo on the same target model across accounts before cascading to next model', async () => {
    const kilo = new KiloProviderPlugin(mockServer.url);
    const nous = new NousProviderPlugin(mockServer.url);

    const kiloAcc1: StoredAccount = {
      id: 'acc_kilo_combo_1',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'kilo_combo_key_1' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };
    const kiloAcc2: StoredAccount = {
      id: 'acc_kilo_combo_2',
      providerId: 'kilo',
      authType: 'api_key',
      credentials: { apiKey: 'kilo_combo_key_2' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorCount: 0,
    };

    kilo.addAccount(kiloAcc1);
    kilo.addAccount(kiloAcc2);
    kilo.currentAccount = kiloAcc1;

    globalPluginRegistry.register(kilo);
    globalPluginRegistry.register(nous);

    globalComboManager.createCombo({
      id: 'lattice/intra-rotation-combo',
      name: 'Intra Rotation Test Combo',
      targets: [
        'kilo/nvidia/nemotron-3.5-lightning:free',
        'nous/hermes-3-llama-3.1-70b',
      ],
      createdAt: Date.now(),
    });

    const comboPlugin = new LatticeComboPlugin();

    // kilo_combo_key_1 -> 429
    // kilo_combo_key_2 -> 200 OK (so combo stays on nemotron, does NOT cascade to hermes!)
    mockServer.onRequest((req, body, recorded) => {
      const auth = recorded.headers['authorization'];
      if (auth === 'Bearer kilo_combo_key_1') {
        return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
        });
      }
      if (auth === 'Bearer kilo_combo_key_2') {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_stay_on_same_model',
            model: body?.model || 'kilo/nvidia/nemotron-3.5-lightning:free',
            choices: [{ message: { content: 'Success on Nemotron with Account 2' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: { message: 'Unexpected call' } }), { status: 500 });
    });

    const res = await comboPlugin.execute({
      id: 'req_combo_intra_test',
      clientDialect: 'openai-chat',
      model: 'lattice/intra-rotation-combo',
      messages: [{ role: 'user', content: 'Test combo staying on target' }],
      stream: false,
    });

    expect((res.content[0] as any).text).toBe('Success on Nemotron with Account 2');
    expect(kiloAcc1.status).toBe('cooldown');
  });
});
