import { describe, it, expect } from 'bun:test';
import { getDashboardHtml } from '../../src/admin/dashboard-ui';

const script = (() => {
  const html = getDashboardHtml('test-nonce');
  return html.slice(html.indexOf('<script'), html.indexOf('</script>'));
})();

const start = script.indexOf('    const CALLABLES = {');
const end = script.indexOf('    for (const callEvent of', start);
const dispatcherSrc = script.slice(start, end);
const names = [...dispatcherSrc.matchAll(/^\s+(\w+): \1,?$/gm)].map((m) => m[1]);

function makeDispatcher(calls: any[]) {
  const stubs = names.map((n) =>
    `function ${n}(...args) { calls.push([${JSON.stringify(n)}, ...args]); }`
  ).join('\n');
  return new Function('calls', `${stubs}\n${dispatcherSrc}\nreturn invokeCall;`)(calls) as
    (expr: string, el: any, event: any) => void;
}

describe('strict CSP: inline handlers are dispatched without inline script', () => {
  it('registers every former inline handler in the allow-list', () => {
    expect(names.length).toBeGreaterThan(25);
    expect(names).toContain('switchNavTab');
    expect(names).toContain('showRequestDetailModal');
  });

  it('dispatches literal, numeric, this and event arguments', () => {
    const calls: any[] = [];
    const invoke = makeDispatcher(calls);
    const el = { dataset: { target: 'kilo/model' } };
    let stopped = false;
    const event = { stopPropagation: () => { stopped = true; } };

    invoke("switchNavTab('models')", el, event);
    invoke('moveWizardTarget(2, -1)', el, event);
    invoke("openCredentialsModal('kilo')", el, event);
    invoke("setModelsFilter('all', this)", el, event);
    invoke('toggleTargetInChain(this.dataset.target)', el, event);
    invoke('event.stopPropagation()', el, event);
    invoke('filterModels()', el, event);

    expect(calls).toEqual([
      ['switchNavTab', 'models'],
      ['moveWizardTarget', 2, -1],
      ['openCredentialsModal', 'kilo'],
      ['setModelsFilter', 'all', el],
      ['toggleTargetInChain', 'kilo/model'],
      ['filterModels'],
    ]);
    expect(stopped).toBe(true);
  });

  it('ignores unknown calls instead of evaluating arbitrary strings', () => {
    const calls: any[] = [];
    const invoke = makeDispatcher(calls);
    invoke('alert(1)', {}, {});
    expect(calls).toEqual([]);
  });
});
