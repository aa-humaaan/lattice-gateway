import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelDescriptor } from '../../src/core/types/plugin';
import type { ProviderPlugin } from '../../src/core/types/plugin';
import { globalPluginRegistry } from '../../src/plugins/registry';
import {
  getEnrichedModelsCatalog,
  observeEnabledPluginCatalogs,
  probeModel,
} from '../../src/admin/models-catalog';
import {
  createPassportSigner,
  createModelPassportStore,
  passportFromDescriptor,
  verifyPassport,
  type ModelPassport,
} from '../../src/core/model-passports';

function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/model',
    name: 'Test Model',
    providerId: 'test',
    contextWindow: 131_072,
    supportsTools: true,
    supportsStreaming: true,
    ...overrides,
  };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('model passport signing', () => {
  test('same evidence produces the same signed passport', () => {
    withTempDir((dir) => {
      const signer = createPassportSigner(dir);
      const first = passportFromDescriptor(descriptor(), 'test', signer, 1_700_000_000_000);
      const second = passportFromDescriptor(descriptor(), 'test', signer, 1_700_000_000_000);

      expect(first.digest).toBe(second.digest);
      expect(first.signature.value).toBe(second.signature.value);
      expect(verifyPassport(first)).toBeTrue();
    });
  });

  test('tampering with a claim invalidates the passport', () => {
    withTempDir((dir) => {
      const passport = passportFromDescriptor(descriptor(), 'test', createPassportSigner(dir), 10);
      const tampered = structuredClone(passport) as ModelPassport;
      tampered.claims.contextWindow!.value = 1_000_000;

      expect(verifyPassport(tampered)).toBeFalse();
    });
  });

  test('tampering with the signature invalidates the passport', () => {
    withTempDir((dir) => {
      const passport = passportFromDescriptor(descriptor(), 'test', createPassportSigner(dir), 10);
      passport.signature.value = `${passport.signature.value.slice(0, -2)}AA`;

      expect(verifyPassport(passport)).toBeFalse();
    });
  });

  test('unknown descriptor values stay absent', () => {
    withTempDir((dir) => {
      const passport = passportFromDescriptor(
        descriptor({ contextWindow: undefined, maxOutputTokens: undefined, supportsThinking: undefined }),
        'test',
        createPassportSigner(dir),
        10
      );

      expect(passport.claims.contextWindow).toBeUndefined();
      expect(passport.claims.maxOutputTokens).toBeUndefined();
      expect(passport.claims.supportsThinking).toBeUndefined();
    });
  });

  test('descriptor catalogue source and evidence are retained on every claim', () => {
    withTempDir((dir) => {
      const passport = passportFromDescriptor(
        descriptor({ catalogSource: 'discovered', catalogEvidence: 'GET /models' }),
        'test',
        createPassportSigner(dir),
        25
      );

      expect(passport.claims.contextWindow).toEqual({
        value: 131_072,
        source: 'discovered',
        observedAt: 25,
        evidence: 'GET /models',
      });
      expect(passport.claims.supportsTools?.source).toBe('discovered');
    });
  });
});

describe('model passport store', () => {
  test('a fresh store is empty', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      expect(store.list()).toEqual([]);
    });
  });

  test('observed passports survive a store restart', () => {
    withTempDir((dir) => {
      const file = join(dir, 'passports.json');
      const signer = createPassportSigner(dir);
      createModelPassportStore(file, signer).observe(descriptor(), 'test', 100);

      const restored = createModelPassportStore(file, signer).get('test/model');
      expect(restored?.generatedAt).toBe(100);
      expect(restored && verifyPassport(restored)).toBeTrue();
    });
  });

  test('corrupt storage is ignored without being overwritten', () => {
    withTempDir((dir) => {
      const file = join(dir, 'passports.json');
      writeFileSync(file, '{"passports":');

      const store = createModelPassportStore(file, createPassportSigner(dir));
      expect(store.list()).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe('{"passports":');
    });
  });

  test('newer observations replace one model record instead of duplicating it', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe(descriptor({ contextWindow: 10_000 }), 'test', 10);
      store.observe(descriptor({ contextWindow: 20_000 }), 'test', 20);

      expect(store.list()).toHaveLength(1);
      expect(store.get('test/model')?.claims.contextWindow?.value).toBe(20_000);
    });
  });

  test('stored records with invalid signatures are rejected on load', () => {
    withTempDir((dir) => {
      const file = join(dir, 'passports.json');
      const signer = createPassportSigner(dir);
      createModelPassportStore(file, signer).observe(descriptor(), 'test', 10);
      const payload = JSON.parse(readFileSync(file, 'utf8'));
      payload.passports[0].claims.contextWindow.value = 1;
      writeFileSync(file, JSON.stringify(payload));

      expect(createModelPassportStore(file, signer).list()).toEqual([]);
    });
  });

  test('records signed by a different key are rejected by the store trust anchor', () => {
    withTempDir((dir) => {
      const trustedDir = join(dir, 'trusted');
      const foreignDir = join(dir, 'foreign');
      const file = join(dir, 'passports.json');
      const foreign = passportFromDescriptor(
        descriptor(),
        'test',
        createPassportSigner(foreignDir),
        10
      );
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, passports: [foreign] }));

      const trustedStore = createModelPassportStore(file, createPassportSigner(trustedDir));
      expect(trustedStore.list()).toEqual([]);
    });
  });

  test('measured availability keeps declared capability evidence intact', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe(descriptor(), 'test', 10);
      const updated = store.recordAvailability('test/model', {
        healthy: true,
        latencyMs: 42,
        observedAt: 20,
        evidence: 'explicit basic probe',
      });

      expect(updated.availability).toEqual({
        value: { healthy: true, latencyMs: 42 },
        source: 'measured',
        observedAt: 20,
        evidence: 'explicit basic probe',
      });
      expect(updated.claims.supportsTools?.source).toBe('declared');
      expect(verifyPassport(updated)).toBeTrue();
    });
  });

  test('an older availability result cannot overwrite a newer observation', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe(descriptor(), 'test', 10);
      store.recordAvailability('test/model', {
        healthy: true, latencyMs: 20, observedAt: 30,
      });
      const result = store.recordAvailability('test/model', {
        healthy: false, latencyMs: 200, observedAt: 20, error: 'stale failure',
      });

      expect(result.availability?.observedAt).toBe(30);
      expect(result.availability?.value.healthy).toBeTrue();
    });
  });
});

describe('catalogue passport observation', () => {
  function plugin(id: string, model: ModelDescriptor): ProviderPlugin {
    return {
      id,
      displayName: id,
      defaultBaseUrl: 'https://example.com',
      async listModels() { return [model]; },
      async execute() { throw new Error('not used'); },
      async executeStream() { return (async function* () {})(); },
    };
  }

  test('enabled plugin descriptors become verified passports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    const owner = plugin('passport_enabled', descriptor({
      id: 'passport_enabled/model',
      providerId: 'passport_enabled',
      catalogSource: 'discovered',
      catalogEvidence: 'provider /models',
    }));
    globalPluginRegistry.register(owner);
    try {
      const observed = await observeEnabledPluginCatalogs(store);
      const passport = store.get('passport_enabled/model');
      expect(observed.some((item) => item.id === 'passport_enabled/model')).toBeTrue();
      expect(passport && verifyPassport(passport)).toBeTrue();
      expect(passport?.claims.contextWindow?.source).toBe('discovered');
    } finally {
      globalPluginRegistry.unregister(owner.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('disabled plugins are not observed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    const owner = plugin('passport_disabled', descriptor({
      id: 'passport_disabled/model', providerId: 'passport_disabled',
    }));
    globalPluginRegistry.register(owner, false);
    try {
      await observeEnabledPluginCatalogs(store);
      expect(store.get('passport_disabled/model')).toBeUndefined();
    } finally {
      globalPluginRegistry.unregister(owner.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy static rows stay visibly unverified without a passport', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      const row = getEnrichedModelsCatalog(store).find(
        (item) => item.id === 'kilo/particle-ai/particle-1:free'
      );
      expect(row?.verificationStatus).toBe('unverified');
      expect(row?.passportDigest).toBeUndefined();
    });
  });

  test('observed rows expose their digest and claim sources', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe(descriptor({ id: 'kilo/particle-ai/particle-1:free' }), 'kilo', 10);
      const row = getEnrichedModelsCatalog(store).find(
        (item) => item.id === 'kilo/particle-ai/particle-1:free'
      );
      expect(row?.verificationStatus).toBe('declared');
      expect(row?.passportDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(row?.claimSources?.contextWindow).toBe('declared');
    });
  });

  test('observed claim values replace stale static catalogue values', () => {
    withTempDir((dir) => {
      const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
      store.observe(descriptor({
        id: 'kilo/particle-ai/particle-1:free',
        contextWindow: 65_536,
        maxOutputTokens: 2048,
        supportsTools: false,
      }), 'kilo', 10);
      const row = getEnrichedModelsCatalog(store).find(
        (item) => item.id === 'kilo/particle-ai/particle-1:free'
      );

      expect(row?.contextWindow).toBe(65_536);
      expect(row?.contextWindowFormatted).toBe('64k tokens');
      expect(row?.maxOutputTokens).toBe(2048);
      expect(row?.supportsTools).toBeFalse();
    });
  });
});

describe('explicit model probes', () => {
  test('executes the requested model with bounded output and records only availability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    let received: any;
    let healthChecks = 0;
    const owner = {
      id: 'probe_success',
      displayName: 'Probe Success',
      defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [descriptor({ id: 'probe_success/model', providerId: 'probe_success' })];
      },
      async execute(request: any) {
        received = request;
        return {
          id: 'response', model: request.model, created: 1,
          content: [{ type: 'text', text: 'pong' }], stopReason: 'stop',
        };
      },
      async executeStream() { return (async function* () {})(); },
      async healthCheck() {
        healthChecks++;
        return { healthy: true, checkedAt: Date.now() };
      },
    } as unknown as ProviderPlugin;
    globalPluginRegistry.register(owner);
    try {
      const result = await probeModel('probe_success/model', 'Ping', store);
      const passport = store.get('probe_success/model');

      expect(result.success).toBeTrue();
      expect(received.model).toBe('probe_success/model');
      expect(received.maxTokens).toBe(1);
      expect(received.stream).toBeFalse();
      expect(healthChecks).toBe(0);
      expect(passport?.availability?.source).toBe('measured');
      expect(passport?.claims.contextWindow?.source).toBe('declared');
      expect(passport?.claims.supportsTools?.source).toBe('declared');
    } finally {
      globalPluginRegistry.unregister(owner.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects disabled and unknown models without executing them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    let executions = 0;
    const owner = {
      id: 'probe_disabled',
      displayName: 'Probe Disabled',
      defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [descriptor({ id: 'probe_disabled/model', providerId: 'probe_disabled' })];
      },
      async execute() { executions++; throw new Error('must not execute'); },
      async executeStream() { return (async function* () {})(); },
    } as unknown as ProviderPlugin;
    globalPluginRegistry.register(owner, false);
    try {
      const disabled = await probeModel('probe_disabled/model', 'Ping', store);
      const unknown = await probeModel('missing/model', 'Ping', store);
      expect(disabled.success).toBeFalse();
      expect(unknown.success).toBeFalse();
      expect(executions).toBe(0);
      expect(store.list()).toEqual([]);
    } finally {
      globalPluginRegistry.unregister(owner.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('records a sanitized failure without leaking upstream error text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    const owner = {
      id: 'probe_failure',
      displayName: 'Probe Failure',
      defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [descriptor({ id: 'probe_failure/model', providerId: 'probe_failure' })];
      },
      async execute() { throw new Error('Authorization: Bearer secret-token; raw upstream body'); },
      async executeStream() { return (async function* () {})(); },
    } as unknown as ProviderPlugin;
    globalPluginRegistry.register(owner);
    try {
      const result = await probeModel('probe_failure/model', 'Ping', store);
      const availability = store.get('probe_failure/model')?.availability;
      expect(result.success).toBeFalse();
      expect(result.error).toBe('Model probe failed');
      expect(JSON.stringify(result)).not.toContain('secret-token');
      expect(availability?.value.error).toBe('Model probe failed');
    } finally {
      globalPluginRegistry.unregister(owner.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a hung provider is bounded by the probe deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-passport-'));
    const store = createModelPassportStore(join(dir, 'passports.json'), createPassportSigner(dir));
    const owner = {
      id: 'probe_hung',
      displayName: 'Probe Hung',
      defaultBaseUrl: 'https://example.com',
      async listModels() {
        return [descriptor({ id: 'probe_hung/model', providerId: 'probe_hung' })];
      },
      async execute() { return new Promise(() => {}); },
      async executeStream() { return (async function* () {})(); },
    } as unknown as ProviderPlugin;
    globalPluginRegistry.register(owner);
    try {
      const outcome = await Promise.race([
        probeModel('probe_hung/model', 'Ping', store, 10),
        new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 100)),
      ]);
      expect(outcome).not.toBe('test-timeout');
      expect(typeof outcome === 'object' && outcome.success).toBeFalse();
    } finally {
      globalPluginRegistry.unregister(owner.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
