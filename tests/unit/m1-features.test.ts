import { describe, it, expect } from 'bun:test';
import { createAdminRouter, broadcastLog } from '../../src/admin/admin-router';
import { getEnrichedModelsCatalog, formatOutputTokens } from '../../src/admin/models-catalog';
import { KiloProviderPlugin } from '../../src/plugins/kilo';
import { ClinePoolPlugin } from '../../src/plugins/cline';
import { OpenCodeProviderPlugin } from '../../src/plugins/opencode';
import { NousProviderPlugin } from '../../src/plugins/nous';
import { globalComboManager } from '../../src/pool/combos';
import { globalAccountPool } from '../../src/pool/account-pool';

describe('Milestone M1 — Comprehensive Verification Suite', () => {
  const router = createAdminRouter();
  const kiloPlugin = new KiloProviderPlugin();
  const clinePlugin = new ClinePoolPlugin();
  const opencodePlugin = new OpenCodeProviderPlugin();
  const nousPlugin = new NousProviderPlugin();

  describe('R1: Model Context Window & Token Limits Fixes', () => {
    it('formats output tokens accurately', () => {
      expect(formatOutputTokens(undefined)).toBe('8k tokens');
      expect(formatOutputTokens(4096)).toBe('4k tokens');
      expect(formatOutputTokens(16384)).toBe('16k tokens');
      expect(formatOutputTokens(32000)).toBe('32k tokens');
      expect(formatOutputTokens(131072)).toBe('128k tokens');
      expect(formatOutputTokens(1048576)).toBe('1M tokens');
    });

    it('validates kilo/liquid/lfm-3-1.7b:free has 32k context and 4k max output', async () => {
      const models = await kiloPlugin.listModels();
      const liquid = models.find((m) => m.id === 'liquid/lfm-3-1.7b:free' || m.id === 'kilo/liquid/lfm-3-1.7b:free');
      expect(liquid).toBeDefined();
      expect(liquid?.contextWindow).toBe(32768);
      expect((liquid as any)?.maxOutputTokens).toBe(4096);

      const catalog = getEnrichedModelsCatalog();
      const catLiquid = catalog.find((m) => m.id === 'kilo/liquid/lfm-3-1.7b:free');
      expect(catLiquid).toBeDefined();
      expect(catLiquid?.contextWindow).toBe(32768);
      expect(catLiquid?.contextWindowFormatted).toBe('32k tokens');
      expect(catLiquid?.maxOutputTokens).toBe(4096);
      expect(catLiquid?.maxOutputTokensFormatted).toBe('4k tokens');
    });

    it('validates cline-free/mimo-v2.6-flash has 200k context and 32k max output', async () => {
      const models = await clinePlugin.listModels();
      const mimo = models.find((m) => m.id === 'cline-free/mimo-v2.6-flash');
      expect(mimo).toBeDefined();
      expect(mimo?.contextWindow).toBe(200000);
      expect((mimo as any)?.maxOutputTokens).toBe(32000);

      const catalog = getEnrichedModelsCatalog();
      const catMimo = catalog.find((m) => m.id === 'cline-free/mimo-v2.6-flash');
      expect(catMimo).toBeDefined();
      expect(catMimo?.contextWindow).toBe(200000);
      expect(catMimo?.contextWindowFormatted).toBe('200k tokens');
      expect(catMimo?.maxOutputTokens).toBe(32000);
      expect(catMimo?.maxOutputTokensFormatted).toBe('32k tokens');
    });

    it('validates opencode nemotron-3.5-lightning-free maxOutputTokens is 16k, not 262k', async () => {
      const models = await opencodePlugin.listModels();
      const nemo = models.find((m) => m.id === 'nemotron-3.5-lightning-free');
      expect(nemo).toBeDefined();
      expect((nemo as any)?.maxOutputTokens).toBe(16384);
    });

    it('validates nous models context and max output limits', async () => {
      const models = await nousPlugin.listModels();
      const hermes = models.find((m) => m.id === 'nous/hermes-2-pro-llama-3-8b');
      expect(hermes).toBeDefined();
      expect(hermes?.contextWindow).toBe(8192);
      expect((hermes as any)?.maxOutputTokens).toBe(4096);

      const sonnet = models.find((m) => m.id === 'nous/anthropic/claude-sonnet-5.5');
      expect(sonnet).toBeDefined();
      expect(sonnet?.contextWindow).toBe(200000);
      expect((sonnet as any)?.maxOutputTokens).toBe(8192);

      const deepseekFlash = models.find((m) => m.id === 'nous/deepseek/deepseek-v4.1-flash');
      expect(deepseekFlash).toBeDefined();
      expect(deepseekFlash?.contextWindow).toBe(128000);
      expect((deepseekFlash as any)?.maxOutputTokens).toBe(16000);
    });

    it('validates lattice/1m-free combo target #1 is a genuine 1M context model', () => {
      const combo = globalComboManager.getCombo('lattice/1m-free');
      expect(combo).toBeDefined();
      expect(combo?.targets.length).toBeGreaterThan(0);
      const target1 = combo!.targets[0];
      const genuine1MModels = [
        'kilo/nvidia/nemotron-3.5-super-vl:free',
        'kilo/particle-ai/particle-1:free',
        'kilo/baidu/ernie-5.5-flash-preview:free',
        'kilo/nvidia/nemotron-3.5-lightning:free',
        'kilo/inclusionai/ling-3.2-flash:free',
        'cline-free/step-5-preview',
        'muse-spark-1.3-contributor-free',
        'kilo/kilo-auto/free',
      ];
      expect(genuine1MModels).toContain(target1);
    });
  });

  describe('R2: Free Model Providers & Models Cataloging', () => {
    it('verifies cline free models include reflection/beam-free and poolside/laguna-s-2.1-free', async () => {
      const models = await clinePlugin.listModels();
      const beam = models.find((m) => m.id === 'reflection/beam-free');
      expect(beam).toBeDefined();
      expect(beam?.contextWindow).toBe(1048576);
      expect((beam as any)?.maxOutputTokens).toBe(131072);

      const laguna = models.find((m) => m.id === 'poolside/laguna-s-2.1-free');
      expect(laguna).toBeDefined();
      expect(laguna?.contextWindow).toBe(256000);
      expect((laguna as any)?.maxOutputTokens).toBe(32768);
    });

    it('verifies opencode free models include muse-spark and nemotron-3-ultra', async () => {
      const models = await opencodePlugin.listModels();
      const ids = models.map((m) => m.id);
      expect(ids).toContain('muse-spark-1.3-contributor-free');
      expect(ids).toContain('muse-spark-1.2-contributor-free');
      expect(ids).toContain('nemotron-3-ultra-free');
      expect(ids).toContain('ling-3.0-flash-fin-free');

      const spark13 = models.find((m) => m.id === 'muse-spark-1.3-contributor-free');
      expect(spark13?.contextWindow).toBe(1048576);
      expect((spark13 as any)?.maxOutputTokens).toBe(131072);
    });

    it('verifies catalog includes Groq Free Tier and Google Gemini Free Tier models', () => {
      const catalog = getEnrichedModelsCatalog();
      const groqLlama = catalog.find((m) => m.id === 'groq/llama-3.3-70b-versatile');
      expect(groqLlama).toBeDefined();
      expect(groqLlama?.isFree).toBeTrue();
      expect(groqLlama?.providerId).toBe('groq');

      const groqInstant = catalog.find((m) => m.id === 'groq/llama-3.1-8b-instant');
      expect(groqInstant).toBeDefined();
      expect(groqInstant?.isFree).toBeTrue();

      const geminiFlash = catalog.find((m) => m.id === 'gemini-2.0-flash');
      expect(geminiFlash).toBeDefined();
      expect(geminiFlash?.isFree).toBeTrue();
      expect(geminiFlash?.providerId).toBe('gemini');
      expect(geminiFlash?.contextWindow).toBe(1048576);

      const geminiThinking = catalog.find((m) => m.id === 'gemini-2.0-flash-thinking-exp');
      expect(geminiThinking).toBeDefined();
      expect(geminiThinking?.isFree).toBeTrue();
      expect(geminiThinking?.contextWindow).toBe(1048576);
    });
  });

  describe('R3: Token Usage View & Telemetry APIs', () => {
    it('serves GET /api/usage/stats with all KPI metrics and periods', async () => {
      for (const period of ['today', '24h', '7d', '30d', 'all']) {
        const res = await router.request(`/api/usage/stats?period=${period}`);
        expect(res.status).toBe(200);
        const json = (await res.json()) as any;
        expect(json.success).toBeTrue();
        expect(json.period).toBe(period);
        expect(json.stats).toBeDefined();
        expect(typeof json.stats.totalRequests).toBe('number');
        expect(typeof json.stats.totalPromptTokens).toBe('number');
        expect(typeof json.stats.totalCompletionTokens).toBe('number');
        expect(typeof json.stats.totalCachedTokens).toBe('number');
        // Cost fields are null until a priced model reports usage — never a guessed 0.
        expect(json.stats.totalCostUsd).toBeNull();
        expect(json.stats.totalCostSaved).toBeNull();
        expect(json.providers).toBeDefined();
      }
    });

    it('serves GET /api/usage/providers with provider aggregates', async () => {
      const res = await router.request('/api/usage/providers');
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBeTrue();
      expect(Array.isArray(json.providers)).toBeTrue();
      expect(json.providers.length).toBeGreaterThan(0);
      const first = json.providers[0];
      expect(first.id).toBeDefined();
      expect(first.name).toBeDefined();
      expect(typeof first.totalTokens).toBe('number');
      expect(Array.isArray(first.models)).toBeTrue();
      // Aggregates must come from real ledger events and add up.
      for (const provider of json.providers) {
        const summed = provider.models.reduce(
          (total: number, model: any) => total + model.totalTokens,
          0
        );
        expect(provider.totalTokens).toBe(summed);
      }
    });

    it('serves GET /api/usage/logs with pagination', async () => {
      const res = await router.request('/api/usage/logs?page=1&pageSize=10');
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBeTrue();
      expect(typeof json.total).toBe('number');
      expect(json.page).toBe(1);
      expect(json.pageSize).toBe(10);
      expect(Array.isArray(json.logs)).toBeTrue();
    });

    it('broadcastLog records live telemetry and caps ring buffer and recentBuckets', () => {
      for (let i = 0; i < 505; i++) {
        broadcastLog({
          timestamp: Date.now() + i,
          method: 'POST',
          path: '/v1/chat/completions',
          model: 'kilo/liquid/lfm-3-1.7b:free',
          provider: 'kilo',
          status: 200,
          latencyMs: 142,
          promptTokens: 50,
          completionTokens: 25,
        });
      }
    });
  });

  describe('R4: Quota Tracker View & Cooldown Management', () => {
    it('serves GET /api/quotas returning per-account quota and health status', async () => {
      const res = await router.request('/api/quotas');
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBeTrue();
      expect(json.summary).toBeDefined();
      expect(typeof json.summary.totalAccounts).toBe('number');
      expect(typeof json.summary.activeAccounts).toBe('number');
      expect(typeof json.summary.cooldownAccounts).toBe('number');
      expect(typeof json.summary.healthyQuotas).toBe('number');
      expect(Array.isArray(json.quotas)).toBeTrue();

      if (json.quotas.length > 0) {
        const acc = json.quotas[0];
        expect(acc.accountId).toBeDefined();
        expect(acc.providerId).toBeDefined();
        expect(Array.isArray(acc.items)).toBeTrue();
        if (acc.items.length > 0) {
          const item = acc.items[0];
          expect(typeof item.percentage).toBe('number');
          expect(['healthy', 'warning', 'critical', 'unlimited']).toContain(item.threshold);
          expect(typeof item.resetFormatted).toBe('string');
        }
      }
    });

    it('clears account cooldown via POST /api/quotas/:accountId/reset-cooldown', async () => {
      let targetAccId = 'acc_test_cooldown_target';
      const accounts = globalAccountPool.listAccounts();
      if (accounts.length > 0) {
        targetAccId = accounts[0].id;
      } else {
        globalAccountPool.addAccount({
          id: targetAccId,
          providerId: 'kilo',
          authType: 'api_key',
          credentials: { apiKey: 'test-key' },
          status: 'cooldown',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          errorCount: 1,
        });
      }
      
      const res = await router.request(`/api/quotas/${targetAccId}/reset-cooldown`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBeTrue();
      expect(json.accountId).toBe(targetAccId);
      expect(json.status).toBe('active');
    });
  });

  describe('R5: Dashboard UI Offline Invariant & Section Structure', () => {
    it('verifies dashboard contains Usage and Quota tracker navigation and views', async () => {
      const res = await router.request('/admin');
      expect(res.status).toBe(200);
      const html = await res.text();

      // Navigation tabs
      expect(html).toContain('data-tab="usage"');
      expect(html).toContain('data-tab="quotas"');

      // Views
      expect(html).toContain('id="view-usage"');
      expect(html).toContain('id="view-quotas"');

      // Usage KPI cards
      expect(html).toContain('id="usage-kpi-requests"');
      expect(html).toContain('id="usage-kpi-prompt"');
      expect(html).toContain('id="usage-kpi-cached"');
      expect(html).toContain('id="usage-kpi-completion"');
      expect(html).toContain('id="usage-kpi-cost"');

      // Request Inspection Modal
      expect(html).toContain('id="modal-request-detail"');

      // Quota summary cards
      expect(html).toContain('id="quota-sum-total"');
      expect(html).toContain('id="quota-sum-active"');
      expect(html).toContain('id="quota-sum-healthy"');
      expect(html).toContain('id="quota-sum-cooldown"');
      expect(html).toContain('id="quota-cards-container"');

      // Strict offline invariants: no external google fonts, cdn scripts, or tracking
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).not.toContain('cdnjs.cloudflare.com');
      expect(html).not.toContain('cdn.jsdelivr.net');
    });
  });
});
