import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createServer } from '../../src/core/server';
import { globalBreakerRegistry } from '../../src/core/breaker';
import { globalAccountPool } from '../../src/pool/account-pool';
import { GatewayError } from '../../src/core/types/errors';
import type {
  ProviderPlugin,
  ModelDescriptor,
  StoredAccount,
} from '../../src/core/types/plugin';
import type {
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';

const LONG_BACKOFF = { failureThreshold: 3, backoffBaseMs: 600_000, backoffCeilingMs: 600_000, jitterRatio: 0 };

function model(id: string, providerId: string): ModelDescriptor {
  return { id, name: id, providerId, ownedBy: 'x', created: 1 };
}

function stormPlugin(id: string): ProviderPlugin & { calls: number } {
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'https://storm.local/v1',
    calls: 0,
    async listModels(): Promise<ModelDescriptor[]> { return [model(`${id}/m`, id)]; },
    async execute(): Promise<CanonicalResponse> {
      this.calls++;
      throw new GatewayError(503, 'api_error', 'upstream 5xx storm');
    },
    async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      this.calls++;
      return (async function* () {})();
    },
  };
}

function midStreamPlugin(id: string): ProviderPlugin & { calls: number } {
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'https://midstream.local/v1',
    calls: 0,
    async listModels(): Promise<ModelDescriptor[]> { return [model(`${id}/m`, id)]; },
    async execute(): Promise<CanonicalResponse> {
      throw new Error('unused');
    },
    async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      this.calls++;
      return (async function* () {
        yield { type: 'stream_start', id: 's1', model: `${id}/m`, created: 1 };
        yield { type: 'text_delta', delta: 'partial' };
        throw new GatewayError(503, 'api_error', 'upstream died mid-stream');
      })();
    },
  };
}

async function post(app: Awaited<ReturnType<typeof createServer>>, id: string, stream = false): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `${id}/m`, messages: [{ role: 'user', content: 'hi' }], stream }),
  });
}

function accountedStormPlugin(id: string): ProviderPlugin & { calls: number } {
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'https://accounted.local/v1',
    calls: 0,
    async listModels(): Promise<ModelDescriptor[]> { return [model(`${id}/m`, id)]; },
    async execute(): Promise<CanonicalResponse> {
      const lease = globalAccountPool.acquireAccount(
        globalAccountPool.listAccounts().filter((a) => a.providerId === id)
      );
      if (!lease) throw new GatewayError(503, 'breaker_open', 'no account available');
      this.calls++;
      try {
        throw new GatewayError(503, 'api_error', 'upstream 5xx storm');
      } finally {
        lease.release();
      }
    },
    async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      return (async function* () {})();
    },
  };
}

afterEach(() => {
  globalBreakerRegistry.reset();
  for (const acc of globalAccountPool.listAccounts()) {
    if (acc.id.startsWith('gate-acc-')) globalAccountPool.deleteAccount(acc.id);
  }
});

describe('router breaker ownership', () => {
  test('keyless plugin receiving a 5xx storm stops getting provider calls once the breaker opens', async () => {
    const id = 'gate-keyless-storm';
    globalBreakerRegistry.configure(id, LONG_BACKOFF);
    const plugin = stormPlugin(id);
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-keyless-')) }, [plugin]);

    for (let i = 0; i < 8; i++) await post(app, id);

    expect(plugin.calls).toBe(3);
    expect(globalBreakerRegistry.get(id).state).toBe('open');
  });

  test('six mid-stream deaths open the breaker and stop further provider calls', async () => {
    const id = 'gate-midstream-death';
    globalBreakerRegistry.configure(id, LONG_BACKOFF);
    const plugin = midStreamPlugin(id);
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-midstream-')) }, [plugin]);

    for (let i = 0; i < 6; i++) {
      const res = await post(app, id, true);
      await res.text().catch(() => {});
    }

    expect(plugin.calls).toBe(3);
    expect(globalBreakerRegistry.get(id).state).toBe('open');
  });

  test('failures equals the number of failed provider calls', async () => {
    const id = 'gate-failure-count';
    globalBreakerRegistry.configure(id, LONG_BACKOFF);
    globalAccountPool.addAccount({
      id: 'gate-acc-count', providerId: id, authType: 'api_key', status: 'active',
      credentials: { apiKey: 'k' }, createdAt: 1, updatedAt: 1, errorCount: 0,
    } as StoredAccount);
    const plugin = accountedStormPlugin(id);
    const app = createServer({ dataDir: mkdtempSync(join(tmpdir(), 'lg-count-')) }, [plugin]);

    for (let i = 0; i < 6; i++) await post(app, id);

    expect(plugin.calls).toBe(3);
    expect(globalBreakerRegistry.get(id).failures).toBe(3);
  });
});
