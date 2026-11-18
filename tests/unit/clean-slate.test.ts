import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.superpowers') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|html|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('clean slate', () => {
  test('FreeLLMAPI plugin file is gone', () => {
    expect(existsSync('src/plugins/freellmapi.ts')).toBeFalse();
  });

  test('no shipped source references freellmapi', () => {
    const offenders = sourceFiles('src')
      .concat(sourceFiles('bin'))
      .filter((file) => readFileSync(file, 'utf8').toLowerCase().includes('freellmapi'));
    expect(offenders).toEqual([]);
  });

  test('default combos contain no freellmapi targets', async () => {
    const { ComboManager } = await import('../../src/pool/combos');
    const manager = new ComboManager();
    const combos = manager.listCombos();
    expect(combos.length).toBeGreaterThan(0);
    for (const combo of combos) {
      expect(combo.targets.some((t) => t.toLowerCase().includes('freellmapi'))).toBeFalse();
    }
  });

  test('no hard-coded personal paths or gateway tokens in source', () => {
    const badPaths: string[] = [];
    const badTokens: string[] = [];
    for (const file of sourceFiles('src').concat(sourceFiles('bin'))) {
      const text = readFileSync(file, 'utf8');
      if (/C:\\Users\\adity/i.test(text)) badPaths.push(file);
      if (text.includes('sk-lattice-master')) badTokens.push(file);
    }
    expect(badPaths).toEqual([]);
    expect(badTokens).toEqual([]);
  });

  test('models view has no hard-coded model counts', () => {
    const ui = readFileSync('src/admin/dashboard-ui.ts', 'utf8');
    for (const stale of ['31 verified zero-cost', '31 Models Available', '50 Free Models Available', 'All (72)']) {
      expect(ui).not.toContain(stale);
    }
  });

  test('zero configured accounts yields zero available models', async () => {
    const { getEnrichedModelsCatalog } = await import('../../src/admin/models-catalog');
    const { globalAccountPool } = await import('../../src/pool/account-pool');
    for (const acc of globalAccountPool.listAccounts()) globalAccountPool.deleteAccount(acc.id);
    const models = getEnrichedModelsCatalog();
    expect(models.every((m) => m.available === false)).toBeTrue();
  });
});
