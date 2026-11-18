import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';

const STORE = 'data/lattice-store.json';

describe('credential store hygiene', () => {
  test('credential store is ignored by git', () => {
    const result = Bun.spawnSync({ cmd: ['git', 'check-ignore', '-q', STORE], stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
  });

  test('credential store is not tracked by git', () => {
    const result = Bun.spawnSync({ cmd: ['git', 'ls-files', STORE], stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('');
  });

  test('SECURITY.md tells the operator to rotate before untracking', () => {
    expect(existsSync('SECURITY.md')).toBe(true);
    const doc = readFileSync('SECURITY.md', 'utf8');
    expect(doc).toContain('rotate');
    expect(doc).toContain('filter-repo');
    expect(doc).toContain('git rm --cached');
  });
});
