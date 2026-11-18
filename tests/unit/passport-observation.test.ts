import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createModelPassportStore,
  createPassportSigner,
} from '../../src/core/model-passports';
import type { ModelDescriptor } from '../../src/core/types/plugin';
import {
  observeCanonicalResponse,
  observeStreamEvents,
  observeContextOverflow,
} from '../../src/core/passport-observation';
import type { CanonicalResponse, CanonicalStreamEvent, CanonicalRequest } from '../../src/core/types/canonical';
import type { ProviderPlugin } from '../../src/core/types/plugin';
import { getGlobalModelPassportStore } from '../../src/core/model-passports';
import { createServer } from '../../src/core/server';

function withStore(run: (store: ReturnType<typeof createModelPassportStore>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-learn-'));
  try {
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    const model: ModelDescriptor = {
      id: 'kilo/model', name: 'Model', providerId: 'kilo',
      supportsTools: false, supportsThinking: false, supportsStreaming: false,
      contextWindow: 128000,
    };
    store.observe(model, 'kilo', 10);
    run(store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const responseWithTools: CanonicalResponse = {
  id: 'r', model: 'kilo/model', created: 1,
  content: [
    { type: 'thinking', thinking: 'plan' },
    { type: 'tool_use', id: 'c1', name: 'read', input: {} },
  ],
  stopReason: 'tool_calls',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
};

describe('passive capability learning', () => {
  test('a real tool call and thinking block upgrade declared claims to measured', () => {
    withStore((store) => {
      observeCanonicalResponse(store, 'kilo/model', responseWithTools, undefined, 20);
      const passport = store.get('kilo/model')!;
      expect(passport.claims.supportsTools).toEqual({
        value: true, source: 'measured', observedAt: 20,
        evidence: 'observed tool_use in canonical response',
      });
      expect(passport.claims.supportsThinking?.source).toBe('measured');
      expect(passport.claims.supportsThinking?.value).toBeTrue();
    });
  });

  test('repeated identical observations do not change the signed record', () => {
    withStore((store) => {
      observeCanonicalResponse(store, 'kilo/model', responseWithTools, undefined, 20);
      const digest = store.get('kilo/model')!.digest;
      observeCanonicalResponse(store, 'kilo/model', responseWithTools, undefined, 21);
      expect(store.get('kilo/model')!.digest).toBe(digest);
    });
  });

  test('measured claims survive a later catalogue refresh', () => {
    withStore((store) => {
      observeCanonicalResponse(store, 'kilo/model', responseWithTools, undefined, 20);
      store.observe({
        id: 'kilo/model', name: 'Model', providerId: 'kilo',
        supportsTools: false, supportsThinking: false, supportsStreaming: false,
        contextWindow: 128000,
      }, 'kilo', 30);
      expect(store.get('kilo/model')!.claims.supportsTools?.value).toBeTrue();
      expect(store.get('kilo/model')!.claims.supportsTools?.source).toBe('measured');
    });
  });

  test('stream events upgrade supportsStreaming but emit no negative claims', () => {
    withStore((store) => {
      const events: CanonicalStreamEvent[] = [
        { type: 'stream_start', id: 's', model: 'kilo/model', created: 1 },
        { type: 'text_delta', delta: 'ok' },
        { type: 'stream_end', stopReason: 'stop' },
      ];
      observeStreamEvents(store, 'kilo/model', events, 20);
      const passport = store.get('kilo/model')!;
      expect(passport.claims.supportsStreaming?.value).toBeTrue();
      expect(passport.claims.supportsStreaming?.source).toBe('measured');
      expect(passport.claims.supportsTools?.value).toBeFalse();
    });
  });

  test('the global passport store keeps independent instances per data directory', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'lattice-store-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'lattice-store-b-'));
    try {
      const a = getGlobalModelPassportStore(dirA);
      const b = getGlobalModelPassportStore(dirB);
      a.observe({ id: 'm', name: 'M', contextWindow: 1000 }, 'p', 1);
      expect(b.get('m')).toBeUndefined();
      expect(getGlobalModelPassportStore(dirA)).toBe(a);
      expect(getGlobalModelPassportStore(dirB)).toBe(b);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('a real chat response upgrades the passport through the router', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-learn-route-'));
    try {
      const store = getGlobalModelPassportStore(dir);
      store.observe({
        id: 'learn/model', name: 'Learn', providerId: 'learn',
        supportsTools: false, contextWindow: 128000,
      }, 'learn', 10);
      const plugin = {
        id: 'learn', displayName: 'Learn', defaultBaseUrl: 'https://example.com',
        async listModels() { return [{ id: 'learn/model', name: 'Learn' }]; },
        async execute(request: CanonicalRequest) {
          return {
            id: 'r', model: request.model, created: 1,
            content: [{ type: 'tool_use' as const, id: 'c1', name: 'read', input: {} }],
            stopReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        async executeStream() { return (async function* () {})(); },
      } as ProviderPlugin;
      const app = createServer({ dataDir: dir }, [plugin]);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'learn/model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const learned = getGlobalModelPassportStore(dir).get('learn/model');
      expect(learned?.claims.supportsTools?.source).toBe('measured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a context overflow records a conservative upper bound, not a new contextWindow', () => {
    withStore((store) => {
      observeContextOverflow(store, 'kilo/model', 130000, 20);
      const passport = store.get('kilo/model')!;
      expect(passport.claims.contextOverflowAt?.value).toBe(130000);
      expect(passport.claims.contextOverflowAt?.source).toBe('measured');
      expect(passport.claims.contextWindow?.value).toBe(128000);
    });
  });
});




