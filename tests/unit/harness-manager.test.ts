import { describe, expect, test } from 'bun:test';
import {
  configureHarness,
  detectAllHarnesses,
  getHarnessDefinitions,
  getOpenCodeCatalogModels,
} from '../../src/admin/harness-manager';
import { gatewayBearerToken } from '../../src/core/local-token';

describe('harness manager', () => {
  test('definitions cover supported harnesses with a protocol', () => {
    const defs = getHarnessDefinitions();
    expect(Object.keys(defs)).not.toEqual([]);
    expect(defs.opencode?.protocol).toBe('openai');
    for (const def of Object.values(defs)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.recommendedModel.length).toBeGreaterThan(0);
      expect(def.getSnippet('/tmp/config.json')).toContain('127.0.0.1:4000');
    }
  });

  test('generated snippets carry the real gateway token, never a placeholder', () => {
    const token = gatewayBearerToken();
    for (const def of Object.values(getHarnessDefinitions())) {
      const snippet = def.getSnippet('/tmp/config.json');
      expect(snippet).toContain(token);
      expect(snippet).not.toContain('sk-lattice-master');
    }
  });

  test('SEC-12: snippets use the token override instead of the generated token', () => {
    const previous = process.env.LATTICE_GATEWAY_TOKEN;
    const override = 'OVERRIDE-GW-SEC12';
    process.env.LATTICE_GATEWAY_TOKEN = override;
    try {
      const generated = gatewayBearerToken();
      for (const def of Object.values(getHarnessDefinitions())) {
        const snippet = def.getSnippet('/tmp/config.json');
        expect(snippet).toContain(override);
        expect(snippet).not.toContain(generated);
      }
    } finally {
      if (previous === undefined) delete process.env.LATTICE_GATEWAY_TOKEN;
      else process.env.LATTICE_GATEWAY_TOKEN = previous;
    }
  });

  test('detection mirrors definitions and reports concrete paths', () => {
    const defs = getHarnessDefinitions();
    const detected = detectAllHarnesses();
    expect(detected.map((h) => h.id)).toEqual(Object.keys(defs));
    for (const harness of detected) {
      expect(harness.targetPath).toBe(defs[harness.id].getPath());
      expect(typeof harness.detected).toBe('boolean');
      expect(typeof harness.configured).toBe('boolean');
      expect(harness.configSnippet).toContain('127.0.0.1:4000');
    }
  });

  test('an unknown harness id fails closed with a clear message', () => {
    const result = configureHarness('not-a-harness');
    expect(result.success).toBeFalse();
    expect(result.harness).toBe('not-a-harness');
    expect(result.message).toContain('Unknown harness ID');
  });

  test('the OpenCode catalog exposes virtual combos and real models', () => {
    const models = getOpenCodeCatalogModels();
    expect(models['lattice/1m-free']?.limit.context).toBe(1048576);
    expect(models['kilo/particle-ai/particle-1:free']?.limit.context).toBe(1048576);
    expect(models['lattice/fast-free']?.limit.output).toBe(4096);
  });
});
