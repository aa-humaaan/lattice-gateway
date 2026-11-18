import { describe, expect, test } from 'bun:test';

describe('build hygiene', () => {
  test('the whole project typechecks', () => {
    const result = Bun.spawnSync({
      cmd: ['bunx', 'tsc', '--noEmit'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(output.trim()).toBe('');
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
