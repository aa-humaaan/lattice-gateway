import { describe, expect, spyOn, test } from 'bun:test';
import { withRequestDeadline } from '../../src/utils/request-deadline';
import { createServer } from '../../src/core/server';
import { globalAccountPool } from '../../src/pool/account-pool';
import { requestLedger } from '../../src/admin/admin-router';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/core/types/canonical';
import type { ProviderPlugin } from '../../src/core/types/plugin';

describe('request deadline abort wiring', () => {
  test('a timed-out deadline aborts the controller handed to the upstream call', async () => {
    const controller = new AbortController();
    let upstreamSawAbort = false;
    controller.signal.addEventListener('abort', () => {
      upstreamSawAbort = true;
    });

    const hung = new Promise<string>(() => {});
    await expect(withRequestDeadline(hung, 20, 'test', controller)).rejects.toThrow(/timed out/);
    expect(upstreamSawAbort).toBe(true);
  });
});

describe('stream accounting on client abort', () => {
  test('client abort records no usage and no 200 log entry', async () => {
    const providerId = `abort-acct-${Date.now()}`;
    let resolveClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const plugin = {
      id: providerId,
      displayName: providerId,
      defaultBaseUrl: 'http://localhost',
      async listModels() {
        return [
          {
            id: `${providerId}/model`,
            name: 'm',
            providerId,
            created: 1,
            contextWindow: 100000,
            supportsStreaming: true,
          },
        ];
      },
      async execute(req: CanonicalRequest): Promise<CanonicalResponse> {
        return {
          id: req.id,
          model: req.model,
          created: 1,
          content: [],
          stopReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async executeStream(
        req: CanonicalRequest,
        signal?: AbortSignal
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        return (async function* () {
          try {
            yield { type: 'stream_start', id: 's', model: req.model, created: 1 };
            for (let i = 0; i < 100; i++) {
              if (signal?.aborted) return;
              yield { type: 'text_delta', delta: 'x' };
              await new Promise((r) => setTimeout(r, 10));
            }
            yield { type: 'stream_end', stopReason: 'stop' };
          } finally {
            resolveClosed();
          }
        })();
      },
    } as ProviderPlugin;

    const usageSpy = spyOn(globalAccountPool, 'recordProviderUsage');
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const app = createServer({}, [plugin]);
      server = Bun.serve({ port: 0, fetch: app.fetch });
      const base = `http://127.0.0.1:${server.port}`;
      const ac = new AbortController();

      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `${providerId}/model`,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
        signal: ac.signal,
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);

      ac.abort();
      await upstreamClosed;
      await new Promise((r) => setTimeout(r, 50));
      try {
        await reader.cancel();
      } catch {}

      expect(usageSpy).not.toHaveBeenCalled();
      const entries = requestLedger.readRecent(500).filter((e) => e.provider === providerId);
      expect(entries.some((e) => e.status === 200)).toBe(false);
    } finally {
      usageSpy.mockRestore();
      if (server) server.stop(true);
    }
  });
});
