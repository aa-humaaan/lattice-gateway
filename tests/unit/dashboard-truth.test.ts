import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const html = () => readFileSync('src/admin/dashboard-ui.ts', 'utf8');

describe('dashboard truth', () => {
  test('no hard-coded token or request counts are shipped', () => {
    const src = html();
    for (const fake of ['813,700', '524,300', '289,400', '462', '1,420', '128,400', '24.85']) {
      expect(src).not.toContain(fake);
    }
  });

  test('no hard-coded account, plugin or model counts are shipped', () => {
    const src = html();
    expect(src).not.toContain('>8 Active<');
    expect(src).not.toContain('>6 Active<');
    expect(src).not.toContain('>3 Active<');
    expect(src).not.toContain('>31 Free<');
    expect(src).not.toContain('>7 Tools<');
    expect(src).not.toContain('>6</div>');
    expect(src).not.toContain('>11</div>');
    expect(src).not.toContain('>9</div>');
    expect(src).not.toContain('>2</div>');
  });

  test('nav badges start empty and are refreshed centrally', () => {
    const src = html();
    expect(src).toContain('id="badge-models-count"');
    expect(src).toMatch(/function refreshBadges\s*\(/);
    expect(src).toContain("badge-models-count');");
  });

  test('the dashboard filters out unavailable models', () => {
    const src = html();
    expect(src).toMatch(/available !== false/);
  });

  test('the deferred KPI placeholders are fed by live fetches', () => {
    const src = html();
    expect(src).toMatch(/usage-dist-summary'\);\s*if \(sum\) sum\.textContent = 'Total: ' \+ \(stats\.totalTokens/);
    expect(src).toMatch(/quota-sum-total'\);\s*if \(elTot\) elTot\.textContent = summary\.totalAccounts/);
    expect(src).toContain('fetchUsageStats().catch(() => {})');
    expect(src).toContain('fetchQuotas().catch(() => {})');
  });
});
