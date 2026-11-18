import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

export interface LocalAuthTokens {
  gatewayToken: string;
  adminToken: string;
}

/** Short, non-reversible identifier safe to print in terminal scrollback. */
export function tokenFingerprint(token?: string): string {
  if (!token) return '(not set)';
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/** Fingerprints of the effective tokens passed to loadConfig (env overrides included). */
export function tokenBannerLines(tokens: { gatewayToken?: string; adminToken?: string }): string {
  return [
    `  Gateway Token:    ${tokenFingerprint(tokens.gatewayToken)}`,
    `  Admin Token:      ${tokenFingerprint(tokens.adminToken)}`,
  ].join('\n');
}

/**
 * Loads the local gateway/admin bearer tokens, generating them on first run.
 * Stored outside version control with owner-only permissions where the
 * platform supports it. Rotation is a deliberate operator action: delete the
 * file and restart the gateway.
 */
export function loadOrCreateAuthTokens(dataDir = 'data'): LocalAuthTokens {
  const file = join(dataDir, 'lattice-auth.json');

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as LocalAuthTokens;
      if (parsed.gatewayToken && parsed.adminToken) return parsed;
    } catch {
      // A corrupt token file is regenerated rather than silently disabling auth.
    }
  }

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const tokens: LocalAuthTokens = {
    gatewayToken: `lgw_${randomBytes(24).toString('base64url')}`,
    adminToken: `ladm_${randomBytes(24).toString('base64url')}`,
  };
  writeFileSync(file, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX mode bits; the file is still git-ignored.
  }
  return tokens;
}
