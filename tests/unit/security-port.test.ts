import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const sources = ['start.bat', 'start.ps1', 'src/index.ts', 'bin/lattice.ts'];

describe('launchers never kill unrelated processes', () => {
  // SOURCE GUARD: launcher scripts are not importable modules; the forbidden
  // commands matter only as shipped text, so inspect the files directly.
  for (const file of sources) {
    test(`SOURCE GUARD: ${file} contains no process-killing commands`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/taskkill/i);
      expect(source).not.toMatch(/Stop-Process/i);
      expect(source).not.toMatch(/netstat/i);
      expect(source).not.toMatch(/findstr/i);
    });
  }

  test('port conflict message names the owning PID when the error carries it', async () => {
    const { formatPortConflict } = await import('../../src/utils/port-error');
    expect(formatPortConflict(4000, { code: 'EADDRINUSE', pid: 12345 })).toContain('PID 12345');
    expect(formatPortConflict(4000, { code: 'EADDRINUSE' })).toMatch(/port 4000 is already in use/i);
    expect(formatPortConflict(4000, { code: 'EADDRINUSE' })).not.toContain('undefined');
  });

  // SOURCE GUARD: entrypoint behavior below is tested via formatPortConflict;
  // this check only proves both entrypoints actually call it.
  test('SOURCE GUARD: entrypoints explain what to do when the port is busy', () => {
    for (const file of ['src/index.ts', 'bin/lattice.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/formatPortConflict\(config\.port, err\)/);
      expect(source).toMatch(/--port/);
    }
  });
});
