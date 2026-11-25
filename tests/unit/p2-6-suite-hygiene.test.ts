import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// SOURCE GUARD: a locally declared stub that reuses a production class name can
// shadow the real plugin/import and hide which implementation a test exercises.
// That property lives in test source, so it cannot be checked by running tests.
const PRODUCTION_NAMES = [
  'KiloProviderPlugin',
  'NousProviderPlugin',
  'OpenCodeProviderPlugin',
  'DeepSeekPoolPlugin',
  'ClinePoolPlugin',
  'LatticeComboPlugin',
  'AccountPoolManager',
  'ProxyPoolManager',
];

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('P2-6 SOURCE GUARD: test stubs do not shadow production names', () => {
  test('no test file declares a class with a production plugin or manager name', () => {
    const offenders: string[] = [];
    for (const file of testFiles(join(import.meta.dir, '..'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:export\s+)?class\s+(\w+)/gm)) {
        if (PRODUCTION_NAMES.includes(match[1])) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
