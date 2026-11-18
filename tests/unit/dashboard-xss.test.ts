import { describe, it, expect } from 'bun:test';
import { getDashboardHtml } from '../../src/admin/dashboard-ui';
import { createServer } from '../../src/core/server';

const PAYLOAD = '<img src=x onerror=alert(1)>';
const html = getDashboardHtml();
const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));

function extractFunction(name: string): string {
  const rawStart = script.indexOf(`function ${name}(`);
  if (rawStart < 0) throw new Error(`missing function ${name}`);
  const prefix = rawStart >= 6 && script.slice(rawStart - 6, rawStart) === 'async ' ? 'async ' : '';
  const start = rawStart - prefix.length;
  const open = script.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const escapeStart = script.indexOf('function escapeHtml(str) {');
const escapeEnd = script.indexOf('\n    }', escapeStart) + '\n    }'.length;
const escapeSrc = script.slice(escapeStart, escapeEnd);
const escapeHtml = new Function(`${escapeSrc}; return escapeHtml;`)() as (v: string) => string;

function makeElement() {
  let innerHTML = '';
  return {
    get innerHTML() { return innerHTML; },
    set innerHTML(v: string) { innerHTML = v; },
    textContent: '',
    className: '',
    style: {},
    children: [] as any[],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, appendChild() {},
    prepend() {}, removeChild() {},
  };
}

function makeDocument(elements: Record<string, ReturnType<typeof makeElement>> = {}) {
  const created: ReturnType<typeof makeElement>[] = [];
  return {
    created,
    getElementById(id: string) {
      if (!elements[id]) elements[id] = makeElement();
      return elements[id];
    },
    createElement() {
      const el = makeElement();
      created.push(el);
      return el;
    },
    addEventListener() {},
  };
}

function expectEscaped(rendered: string) {
  expect(rendered).toContain(PAYLOAD.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  expect(rendered).not.toContain(PAYLOAD);
  expect(rendered).not.toMatch(/<img\s+src=x\s+onerror=/);
}

describe('SEC-01: dashboard escapes client-supplied model names', () => {
  it('the shipped escapeHtml escapes the payload', () => {
    expect(escapeHtml(PAYLOAD)).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('model grid escapes the model name and id', () => {
    const document = makeDocument();
    const render = new Function('document', 'escapeHtml',
      `${escapeSrc}\n${extractFunction('renderModelsGrid')}\nreturn renderModelsGrid;`
    )(document, escapeHtml);
    render([{ id: PAYLOAD, name: PAYLOAD, providerId: 'kilo', ownedBy: 'evil', badges: [] }]);
    expectEscaped(document.getElementById('models-grid-container').innerHTML);
  });

  it('combo rows escape combo and target names', async () => {
    const document = makeDocument();
    const fetchStub = () => Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        combos: [{ id: PAYLOAD, name: PAYLOAD, targets: [PAYLOAD], targetDetails: [{ target: PAYLOAD, status: 'reachable' }] }],
      }),
    });
    const fetchCombos = new Function('document', 'escapeHtml', 'fetchStub',
      `${escapeSrc}\nconst fetch = fetchStub;\n${extractFunction('fetchCombos')}\nreturn fetchCombos;`
    )(document, escapeHtml, fetchStub);
    await fetchCombos();
    expectEscaped(document.getElementById('combos-table-body').innerHTML);
  });

  it('usage log rows escape the model field', () => {
    const document = makeDocument();
    const start = script.indexOf("const logsTbody = document.getElementById('usage-logs-tbody');");
    const endMarker = 'logsTbody.innerHTML = logsHtml;';
    const end = script.indexOf(endMarker, start) + endMarker.length;
    const body = script.slice(start, end) + '\n}';
    const usageLogsData = [{ timestamp: 1, method: 'POST', path: '/v1/chat/completions', provider: 'kilo', model: PAYLOAD, promptTokens: 1, completionTokens: 1, latencyMs: 1, status: 200 }];
    new Function('document', 'escapeHtml', 'usageLogsData', body)(document, escapeHtml, usageLogsData);
    expectEscaped(document.getElementById('usage-logs-tbody').innerHTML);
  });

  it('SSE log output escapes the model field', () => {
    const document = makeDocument();
    let onmessage: ((e: { data: string }) => void) | undefined;
    class EventSourceStub {
      onmessage: ((e: { data: string }) => void) | undefined;
      constructor() { onmessage = (e) => this.onmessage?.(e); }
    }
    const init = new Function('document', 'EventSource', 'escapeHtml',
      `${escapeSrc}\n${extractFunction('initLogStream')}\nreturn initLogStream;`
    )(document, EventSourceStub, escapeHtml);
    init();
    onmessage!({ data: JSON.stringify({ timestamp: 1, method: 'POST', path: '/v1/chat/completions', model: PAYLOAD, status: 200, latencyMs: 1, totalTokens: 1 }) });
    expect(document.created.length).toBeGreaterThan(0);
    expectEscaped(document.created[0].innerHTML);
  });

  it('harness cards escape names, categories, descriptions and paths', () => {
    const document = makeDocument();
    const render = new Function('document', 'escapeHtml',
      `${escapeSrc}\n${extractFunction('renderHarnessGrid')}\nreturn renderHarnessGrid;`
    )(document, escapeHtml);
    render([{
      id: PAYLOAD, name: PAYLOAD, category: PAYLOAD, protocol: 'http',
      description: PAYLOAD, targetPath: PAYLOAD, configured: false, detected: false,
      configSnippet: '',
    }]);
    expectEscaped(document.getElementById('harness-grid-container').innerHTML);
  });

  it('plugin rows escape display names, ids and base URLs', async () => {
    const document = makeDocument();
    const fetchStub = () => Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        plugins: [{
          id: PAYLOAD, displayName: PAYLOAD, defaultBaseUrl: PAYLOAD,
          supportedAuthTypes: [PAYLOAD], enabled: true,
        }],
      }),
    });
    const fetchPlugins = new Function('document', 'escapeHtml', 'fetchStub', 'allAccountsData', 'PROVIDER_LOGOS_MAP', 'allModels',
      `${escapeSrc}\nconst fetch = fetchStub;\n${extractFunction('fetchPlugins')}\nreturn fetchPlugins;`
    )(document, escapeHtml, fetchStub, [], {}, []);
    await fetchPlugins();
    expectEscaped(document.getElementById('plugins-table-body').innerHTML);
  });

  it('wizard target rows escape target names', () => {
    const document = makeDocument();
    const render = new Function('document', 'escapeHtml', 'allAccountsData', 'wizardTargets',
      `${escapeSrc}\n${extractFunction('renderWizardTargets')}\nreturn renderWizardTargets;`
    )(document, escapeHtml, [], [PAYLOAD]);
    render();
    expectEscaped(document.getElementById('wizard-targets-list').innerHTML);
  });

  it('sanitizes executable markup at the innerHTML boundary', () => {
    const fnStart = script.indexOf('    function sanitizeDashboardHtml(html) {');
    const fnEnd = script.indexOf('    const nativeInnerHTML =', fnStart);
    const fnSrc = script.slice(fnStart, fnEnd);
    const attrs = [
      { name: 'onerror', value: 'alert(1)' },
      { name: 'href', value: 'javascript:alert(1)' },
      { name: 'class', value: 'safe' },
    ];
    const node = {
      tagName: 'A',
      attributes: attrs,
      removeAttribute(name: string) {
        const i = attrs.findIndex((a) => a.name === name);
        if (i >= 0) attrs.splice(i, 1);
      },
      remove() {},
    };
    const document = { createElement: () => ({ content: { querySelectorAll: () => [node] } }) };
    const nativeInnerHTML = {
      set: (_el: unknown, value: string) => { /* template parse stand-in */ },
      get: () => '<a class="safe">text</a>',
    };
    const sanitize = new Function('document', 'nativeInnerHTML',
      `${fnSrc}\nreturn sanitizeDashboardHtml;`
    )(document, nativeInnerHTML) as (v: string) => string;

    sanitize('<a onerror="alert(1)" href="javascript:alert(1)" class="safe">text</a>');
    expect(attrs.map((a) => a.name)).toEqual(['class']);
    expect(sanitize('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });

  it('serves the dashboard with a strict Content-Security-Policy', async () => {
    const app = createServer({ adminToken: 'admin-secret' });
    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).toMatch(/style-src 'nonce-[^']+'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");

    const body = await res.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain(`<style nonce="${nonce}">`);
    expect(body).toContain('data-call-click=');
    expect(body).not.toMatch(/\son(click|input|change|error)\s*=/);

    const second = await app.request('/admin');
    expect(second.headers.get('content-security-policy')).not.toBe(csp);
  });
});
