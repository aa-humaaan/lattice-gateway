import { createServer } from '../../../src/core/server';
import { globalAccountPool } from '../../../src/pool/account-pool';
import { globalBreakerRegistry } from '../../../src/core/breaker';
import { GatewayError } from '../../../src/core/types/errors';
import type { ProviderPlugin, ModelDescriptor } from '../../../src/core/types/plugin';
import type { CanonicalResponse, CanonicalStreamEvent } from '../../../src/core/types/canonical';

const calls = { n: 0 };
class Flaky implements ProviderPlugin {
  readonly id = 'flaky-gate'; readonly displayName = 'F'; readonly defaultBaseUrl = 'https://f.local/v1';
  async listModels(): Promise<ModelDescriptor[]> { return [{ id: 'flaky-gate/m', name: 'F', providerId: 'flaky-gate', ownedBy: 'x', created: 1 }]; }
  async execute(): Promise<CanonicalResponse> {
    const lease = globalAccountPool.acquireAccount(globalAccountPool.listAccounts().filter((a) => a.providerId === 'flaky-gate'));
    if (!lease) throw new GatewayError(503, 'breaker_open', 'no account available');
    calls.n++;
    try { throw new GatewayError(503, 'api_error', 'down'); } finally { lease.release(); }
  }
  async executeStream(): Promise<AsyncIterable<CanonicalStreamEvent>> { return (async function* () {})(); }
}
globalBreakerRegistry.configure('flaky-gate', { failureThreshold: 3, backoffBaseMs: 10000, backoffCeilingMs: 10000, jitterRatio: 0 });
globalAccountPool.addAccount({ id: 'gate-acc-0', providerId: 'flaky-gate', credentials: { apiKey: 'k' }, status: 'active' } as any);
const app = createServer({}, [new Flaky()]);
const body = JSON.stringify({ model: 'flaky-gate/m', messages: [{ role: 'user', content: 'hi' }] });
for (let i = 0; i < 6; i++) await app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
const b = globalBreakerRegistry.get('flaky-gate');
console.log(`GATE after 6: calls=${calls.n} state=${b.state} allow=${b.allow()} failures=${b.failures}`);
for (let i = 0; i < 6; i++) await app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
console.log(`GATE after 12: calls=${calls.n} state=${b.state} allow=${b.allow()}`);
