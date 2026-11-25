// A combo request is served by one target provider and one account. The router
// must attribute usage, the ledger row and the receipt to that provider/account
// — never to the virtual combo ("lattice") that fronted it. The direct-plugin
// path must produce the identical attribution.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from '../../src/core/server';
import { globalAccountPool } from '../../src/pool/account-pool';
import { globalComboManager } from '../../src/pool/combos';
import { globalPluginRegistry } from '../../src/plugins/registry';
import { LatticeComboPlugin } from '../../src/plugins/combo';
import { requestLedger } from '../../src/admin/admin-router';
import { buildReceipt } from '../../src/core/receipt';
import type { ProviderPlugin, ModelDescriptor, StoredAccount } from '../../src/core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';

const PROVIDER_ID = 'attrib-provider';
const COMBO_ID = 'lattice/attrib-combo';
const ACCOUNT_ID = 'acc_attrib_x';

function account(): StoredAccount {
  return {
    id: ACCOUNT_ID,
    providerId: PROVIDER_ID,
    authType: 'api_key',
    status: 'active',
    credentials: { apiKey: 'key-x' },
    createdAt: 1,
    updatedAt: 1,
    errorCount: 0,
    quotaRemaining: 1000,
    quotaLimit: 1000,
  };
}

// Mirrors the real pooled plugins: the executing plugin picks the account and
// stamps it on the request it was handed.
class AccountStampingProvider implements ProviderPlugin {
  readonly id = PROVIDER_ID;
  readonly displayName = 'Attribution Test Provider';
  readonly defaultBaseUrl = 'http://stub';

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        id: `${PROVIDER_ID}/model`,
        name: 'Attribution Model',
        providerId: PROVIDER_ID,
        contextWindow: 100_000,
      },
    ];
  }

  async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
    req.accountId = ACCOUNT_ID;
    return {
      id: req.id,
      model: req.model,
      created: 1,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'stop',
      usage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 },
    };
  }

  async executeStream(req: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamEvent>> {
    req.accountId = ACCOUNT_ID;
    return (async function* () {
      yield { type: 'stream_start', id: req.id, model: req.model, created: 1 };
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'stream_end', stopReason: 'stop', usage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 } };
    })();
  }
}

function resetAccountUsage(): void {
  const acc = globalAccountPool.getAccount(ACCOUNT_ID);
  if (!acc) return;
  acc.quotaRemaining = 1000;
  acc.tokensUsed = 0;
  acc.requestsUsed = 0;
  acc.lastUsedAt = undefined;
}

function ledgerRowFor(requestId: string) {
  return requestLedger.readRecent(500).find((event) => event.requestId === requestId);
}

async function post(app: ReturnType<typeof createServer>, body: Record<string, unknown>, requestId: string) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify(body),
  });
}

const provider = new AccountStampingProvider();
const comboPlugin = new LatticeComboPlugin();
const app = createServer({}, [provider, comboPlugin]);

beforeEach(() => {
  globalAccountPool.addAccount(account());
  resetAccountUsage();
});

afterAll(() => {
  globalAccountPool.deleteAccount(ACCOUNT_ID);
  globalComboManager.deleteCombo(COMBO_ID);
  globalPluginRegistry.unregister(provider.id);
  globalPluginRegistry.unregister(comboPlugin.id);
});

describe('combo traffic attribution', () => {
  globalPluginRegistry.register(provider);
  globalPluginRegistry.register(comboPlugin);
  globalComboManager.createCombo({
    id: COMBO_ID,
    name: 'Attribution Combo',
    targets: [`${PROVIDER_ID}/model`],
    createdAt: Date.now(),
  });

  test('non-streaming combo request charges the serving account and names the serving provider', async () => {
    const requestId = `req_attrib_combo_${Date.now()}`;
    const res = await post(
      app,
      { model: COMBO_ID, messages: [{ role: 'user', content: 'hi' }] },
      requestId
    );
    expect(res.status).toBe(200);

    const acc = globalAccountPool.getAccount(ACCOUNT_ID)!;
    expect(acc.requestsUsed).toBe(1);
    expect(acc.tokensUsed).toBe(15);
    expect(acc.quotaRemaining).toBe(985);

    const row = ledgerRowFor(requestId);
    expect(row).toBeDefined();
    expect(row!.provider).toBe(PROVIDER_ID);
    expect(row!.accountId).toBe(ACCOUNT_ID);
    expect(row!.model).toBe(COMBO_ID);

    const receipt = buildReceipt(row!);
    expect(receipt.provider).toBe(PROVIDER_ID);
    expect(receipt.accountId).toBe(ACCOUNT_ID);
    expect(receipt.lines.join('\n')).toContain(ACCOUNT_ID);
  });

  test('streaming combo request charges the serving account and names the serving provider', async () => {
    const requestId = `req_attrib_combo_stream_${Date.now()}`;
    const res = await post(
      app,
      { model: COMBO_ID, messages: [{ role: 'user', content: 'hi' }], stream: true },
      requestId
    );
    expect(res.status).toBe(200);
    await res.text();

    const acc = globalAccountPool.getAccount(ACCOUNT_ID)!;
    expect(acc.requestsUsed).toBe(1);
    expect(acc.tokensUsed).toBe(15);
    expect(acc.quotaRemaining).toBe(985);

    const row = ledgerRowFor(requestId);
    expect(row).toBeDefined();
    expect(row!.provider).toBe(PROVIDER_ID);
    expect(row!.accountId).toBe(ACCOUNT_ID);
  });

  test('direct-plugin traffic attributes identically to the combo path', async () => {
    const requestId = `req_attrib_direct_${Date.now()}`;
    const res = await post(
      app,
      { model: `${PROVIDER_ID}/model`, messages: [{ role: 'user', content: 'hi' }] },
      requestId
    );
    expect(res.status).toBe(200);

    const acc = globalAccountPool.getAccount(ACCOUNT_ID)!;
    expect(acc.requestsUsed).toBe(1);
    expect(acc.tokensUsed).toBe(15);
    expect(acc.quotaRemaining).toBe(985);

    const row = ledgerRowFor(requestId);
    expect(row).toBeDefined();
    expect(row!.provider).toBe(PROVIDER_ID);
    expect(row!.accountId).toBe(ACCOUNT_ID);
    expect(row!.model).toBe(`${PROVIDER_ID}/model`);
  });
});
