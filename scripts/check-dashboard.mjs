#!/usr/bin/env bun
/**
 * Gate: the dashboard's inline <script> must parse.
 *
 * src/admin/dashboard-ui.ts builds one ~95 KB script inside a TS template
 * literal. A single mis-escaped quote (`\'` instead of `\\'`) emits broken JS,
 * and then every onclick in the page dies silently while the HTML still
 * renders. That exact bug has shipped four times.
 *
 * Exit 0 = script parses. Exit 1 = it does not, with the offending line.
 *
 * Run: bun scripts/check-dashboard.mjs [module-path]
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const arg = process.argv[2] ?? 'src/admin/dashboard-ui.ts';
const moduleUrl = /^[a-z]+:/i.test(arg) ? arg : pathToFileURL(resolve(arg)).href;
const { getDashboardHtml } = await import(moduleUrl);

const html = getDashboardHtml();

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((body) => body.trim().length > 0);

if (scripts.length === 0) {
  console.error('FAIL: dashboard has no inline script at all.');
  process.exit(1);
}

let failed = false;

for (const [index, body] of scripts.entries()) {
  try {
    new Function(body);
  } catch (err) {
    failed = true;
    const lines = body.split('\n');
    const match = /line (\d+)/.exec(err.message || '');
    const line = match ? Number(match[1]) : 0;

    console.error(`FAIL: inline script #${index + 1} (${body.length} chars) does not parse.`);
    console.error(`  ${err.name}: ${err.message}`);
    if (line > 0 && line <= lines.length) {
      for (let i = Math.max(1, line - 2); i <= Math.min(lines.length, line + 2); i++) {
        console.error(`  ${String(i).padStart(5)} | ${lines[i - 1]}`);
      }
    }
    console.error('\nMost likely cause: a nested quote inside the template literal.');
    console.error("Inside the template, write \\\\' (backslash-backslash-quote) so the browser receives \\'.");
  }
}

if (failed) process.exit(1);

console.log(`OK: ${scripts.length} inline script(s) parse (${scripts[0].length} chars).`);
