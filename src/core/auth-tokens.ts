import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

export interface LocalAuthTokens {
  gatewayToken: string;
  adminToken: string;
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
