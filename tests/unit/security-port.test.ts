import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const sources = ['start.bat', 'start.ps1', 'src/index.ts', 'bin/lattice.ts'];

describe('launchers never kill unrelated processes', () => {
  for (const file of sources) {
    test(`${file} contains no process-killing commands`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/taskkill/i);
      expect(source).not.toMatch(/Stop-Process/i);
      expect(source).not.toMatch(/netstat/i);
      expect(source).not.toMatch(/findstr/i);
    });
  }

  test('entrypoints explain what to do when the port is busy', () => {
    for (const file of ['src/index.ts', 'bin/lattice.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/port \$\{config\.port\} is already in use/i);
      expect(source).toMatch(/--port/);
    }
  });
});
