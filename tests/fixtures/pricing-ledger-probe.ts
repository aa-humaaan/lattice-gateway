import { createAdminRouter, broadcastLog } from '../../src/admin/admin-router';

// Runs in its own process with a fresh LATTICE_LEDGER_PATH so cost assertions
// never depend on events appended by other test files.
const mode = process.env.PRICING_PROBE_MODE;
const router = createAdminRouter();
const read = async (path: string) => (await (await router.request(path)).json()) as any;

const before = (await read('/api/telemetry')).telemetry;

if (mode === 'unknown-estimated') {
  broadcastLog({
    timestamp: Date.now(), method: 'POST', path: '/v1/chat/completions',
    provider: 'unknown-provider', model: 'unknown/model', status: 200, latencyMs: 1,
    promptTokens: 10, completionTokens: 5, estimated: false,
  });
  broadcastLog({
    timestamp: Date.now(), method: 'POST', path: '/v1/chat/completions',
    provider: 'paid-provider', model: 'openai/gpt-4o', status: 200, latencyMs: 1,
    promptTokens: 1_000_000, completionTokens: 100_000, estimated: true,
  });
} else if (mode === 'reported') {
  broadcastLog({
    timestamp: Date.now(), method: 'POST', path: '/v1/chat/completions',
    provider: 'paid-provider', model: 'openai/gpt-4o', status: 200, latencyMs: 1,
    promptTokens: 1_000_000, completionTokens: 100_000, estimated: false,
  });
}

const after = (await read('/api/telemetry')).telemetry;
const stats = (await read('/api/usage/stats')).stats;
console.log(`PRICING_PROBE:${JSON.stringify({ before, after, stats })}`);
