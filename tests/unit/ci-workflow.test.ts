import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const workflowPath = join(import.meta.dir, '..', '..', '.github', 'workflows', 'ci.yml');

describe('P0-6: CI workflow guards', () => {
  it('workflow file exists', () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it('triggers on pull_request and on push to main', () => {
    const yml = readFileSync(workflowPath, 'utf8');
    expect(yml).toContain('pull_request:');
    expect(yml).toMatch(/push:\s*\n\s*branches:\s*\[?\s*main/);
  });

  it('runs install, typecheck, verify, test and conformance', () => {
    const yml = readFileSync(workflowPath, 'utf8');
    expect(yml).toContain('bun install --frozen-lockfile');
    expect(yml).toContain('bun run typecheck');
    expect(yml).toContain('bun run verify');
    expect(yml).toContain('bun test');
    expect(yml).toContain('bun run conformance');
  });

  it('restores conformance/results.json and asserts a clean tree', () => {
    const yml = readFileSync(workflowPath, 'utf8');
    expect(yml).toContain('git restore -- conformance/results.json');
    expect(yml).toContain('git diff --exit-code');
  });
});
