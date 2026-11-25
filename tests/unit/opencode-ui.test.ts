import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

// SOURCE GUARD: the connect UI is inline script text in dashboard-ui.ts with
// no exported component to mount in a test, so text assertions are required.
const src = readFileSync('src/admin/dashboard-ui.ts', 'utf8');

describe('SOURCE GUARD: OpenCode connect UI', () => {
  test('OpenCode has a Connect button like other providers', () => {
    expect(src).not.toMatch(/p\.id !== 'opencode'/);
    expect(src).toMatch(/openCredentialsModal\([^)]*p\.id/);
  });

  test('OpenCode modal offers keyless connect and API-key input', () => {
    expect(src).toMatch(/Connect keyless/i);
    expect(src).toMatch(/OpenCode Zen API Key|Optional API key/i);
    expect(src).not.toMatch(/Zero-Auth Keyless Mode Active/);
  });

  test('submit no longer early-returns for OpenCode', () => {
    expect(src).not.toMatch(/already registered live/);
    expect(src).toMatch(/currentProviderTab === 'opencode'[\s\S]*?authType: 'anonymous'/);
  });
});
