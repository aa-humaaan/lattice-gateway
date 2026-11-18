import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { runConformanceDirectory } from '../src/conformance/runner';

const output = 'conformance/results.json';
const results = await runConformanceDirectory('conformance/fixtures');
const report = { schemaVersion: 1, passed: results.every((result) => result.passed), results };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${results.filter((result) => result.passed).length}/${results.length} conformance fixtures passed`);
if (!report.passed) process.exitCode = 1;
