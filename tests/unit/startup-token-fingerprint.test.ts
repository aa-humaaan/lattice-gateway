import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { tokenFingerprint, tokenBannerLines } from '../../src/core/auth-tokens';

describe('SEC-05: startup banner prints token fingerprints only', () => {
  it('fingerprint is deterministic and does not contain the token', () => {
    const token = 'lgw_SUPER_SECRET_TOKEN_VALUE';
    const fp = tokenFingerprint(token);
    expect(fp).toBe(tokenFingerprint(token));
    expect(fp).not.toContain(token);
    expect(fp).not.toContain('SUPER_SECRET');
    expect(tokenFingerprint('other-token')).not.toBe(fp);
    expect(tokenFingerprint(undefined)).toContain('not set');
  });

  it('banner lines describe the supplied effective tokens, never the raw values', () => {
    const lines = tokenBannerLines({
      gatewayToken: 'ENV_OVERRIDE_GATEWAY',
      adminToken: 'ENV_OVERRIDE_ADMIN',
    });
    expect(lines).toContain(tokenFingerprint('ENV_OVERRIDE_GATEWAY'));
    expect(lines).toContain(tokenFingerprint('ENV_OVERRIDE_ADMIN'));
    expect(lines).not.toContain('ENV_OVERRIDE_GATEWAY');
    expect(lines).not.toContain('ENV_OVERRIDE_ADMIN');
  });

  // SOURCE GUARD: the banner call itself is exercised above; this check proves
  // both shipped entrypoints wire it up, which no importable API exposes.
  it('SOURCE GUARD: both entrypoints report the tokens from loadConfig, not generated ones', () => {
    for (const file of ['src/index.ts', 'bin/lattice.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src).toContain('tokenBannerLines(config)');
      expect(src).not.toMatch(/\$\{authTokens\.(gatewayToken|adminToken)\}/);
    }
  });
});
