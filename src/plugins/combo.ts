import type {
  ProviderPlugin,
  ModelDescriptor,
  StoredAccount,
  HealthCheckResult,
} from '../core/types/plugin';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../core/types/canonical';
import { GatewayError } from '../core/types/errors';
import { globalComboManager } from '../pool/combos';
import { globalAccountPool } from '../pool/account-pool';
import { globalPluginRegistry } from './registry';
import { logger } from '../utils/logger';
import { countPromptTokens } from '../utils/token-counter';
import { estimatePromptTokens } from '../utils/token-estimator';
import { resolveProviderForModel } from '../utils/model-resolver';
import {
  getGlobalModelPassportStore,
  type ModelPassportStore,
} from '../core/model-passports';
import {
  globalSessionAffinityStore,
  type SessionAffinityStore,
} from '../core/session-affinity';

const DEFAULT_CONTEXT_WINDOW = 128000;
const CONTEXT_SAFETY_MARGIN_TOKENS = 256;
const MIN_OUTPUT_TOKENS = 256;
const MAX_STREAM_TARGET_SWITCHES = 4;

function isContentEvent(event: CanonicalStreamEvent): boolean {
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'tool_call_start' ||
    event.type === 'tool_call_delta'
  );
}

export class LatticeComboPlugin implements ProviderPlugin {
  readonly id = 'lattice';
  readonly displayName = 'Lattice Virtual Combos & Failover Engine';
  readonly description = 'Aggregates multi-provider virtual combo pipelines with automatic 429 and error failover';
  readonly defaultBaseUrl = 'http://127.0.0.1:4000';

  constructor(
    private readonly passportStore: ModelPassportStore = getGlobalModelPassportStore(),
    private readonly affinityStore: SessionAffinityStore = globalSessionAffinityStore
  ) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return globalComboManager.listAsModels();
  }

  private resolveProviderForModel(modelId: string): { plugin: ProviderPlugin; resolvedModel: string } {
    return resolveProviderForModel(modelId);
  }

  private async getModelContextWindow(modelId: string): Promise<number> {
    const { plugin, resolvedModel } = this.resolveProviderForModel(modelId);
    for (const id of new Set([modelId, resolvedModel])) {
      const passport = this.passportStore.get(id);
      const contextWindow = passport?.claims.contextWindow?.value;
      if (
        passport &&
        this.passportStore.verify(id) &&
        typeof contextWindow === 'number' &&
        contextWindow > 0
      ) {
        return contextWindow;
      }
    }
    try {
      const models = await plugin.listModels();
      const bareTarget = resolvedModel.includes('/')
        ? resolvedModel.split('/').slice(1).join('/')
        : resolvedModel;
      const match =
        models.find((m) => m.id === resolvedModel) ??
        models.find((m) => m.id === modelId) ??
        models.find((m) => m.id.split('/').slice(1).join('/') === bareTarget) ??
        models.find((m) => m.id === bareTarget);
      if (match?.contextWindow && match.contextWindow > 0) {
        return match.contextWindow;
      }
    } catch (err) {
      logger.warn(`[LatticeCombo] Failed to fetch models for ${plugin.id}, using default context window: ${err}`);
    }

    if (
      modelId.includes('1m') ||
      modelId.includes('particle-1') ||
      modelId.includes('ernie-5.5') ||
      modelId.includes('nemotron-3.5-lightning') ||
      modelId.includes('ling-3.2') ||
      modelId.includes('step-5-preview') ||
      modelId.includes('muse-spark') ||
      modelId.includes('claude-sonnet-4-5') ||
      modelId.includes('claude-opus-4-5') ||
      modelId.includes('claude-haiku-4-5')
    ) {
      return 1_048_576;
    }

    return DEFAULT_CONTEXT_WINDOW;
  }

  private isContextOverflowError(err: unknown): boolean {
    if (!(err instanceof GatewayError)) return false;
    const status = err.status ?? err.statusCode;
    if (status !== 400 && status !== 422) return false;
    const msg = (err.message || '').toLowerCase();
    return (
      msg.includes('context length') ||
      msg.includes('context_length_exceeded') ||
      msg.includes('maximum context') ||
      msg.includes('too many tokens') ||
      msg.includes('exceeds context') ||
      msg.includes('reduce the length') ||
      msg.includes('prompt is too long')
    );
  }

  private hasQuotaAvailable(providerId: string): boolean {
    const accounts = globalAccountPool.listAccounts(providerId);
    if (accounts.length === 0) return true;
    return accounts.some((a) => a.status === 'active' && a.quotaRemaining !== 0);
  }

  async execute(req: CanonicalRequest, signal?: AbortSignal): Promise<CanonicalResponse> {
    const combo = globalComboManager.getCombo(req.model);
    if (!combo) {
      const available = globalComboManager.listCombos().map((c) => c.id).join(', ');
      throw new GatewayError(
        404,
        'model_not_found',
        `Virtual combo not found: ${req.model}. Available combos: ${available || 'none'}`
      );
    }

    const estimate = countPromptTokens(req);
    let lastError: any = null;
    let overflowCount = 0;
    let skippedCount = 0;
    let quotaSkippedCount = 0;
    const maxContextSeen = { value: 0 };
    const sessionKey = req.affinity?.sessionKey;
    const pinnedTarget = sessionKey ? this.affinityStore.getTarget(sessionKey) : undefined;
    const targets = pinnedTarget && combo.targets.includes(pinnedTarget)
      ? [pinnedTarget, ...combo.targets.filter((target) => target !== pinnedTarget)]
      : [...combo.targets];

    let attemptCount = 0;
    for (const target of targets) {
      if (attemptCount >= MAX_STREAM_TARGET_SWITCHES) {
        logger.warn(`[LatticeCombo] Target attempt budget exhausted for combo ${combo.id}`);
        break;
      }
      attemptCount++;
      let resolved: { plugin: ProviderPlugin; resolvedModel: string };
      try {
        resolved = this.resolveProviderForModel(target);
      } catch (err) {
        lastError = err;
        skippedCount++;
        continue;
      }

      const contextWindow = await this.getModelContextWindow(target);
      if (contextWindow > maxContextSeen.value) maxContextSeen.value = contextWindow;

      const availableForOutput = contextWindow - estimate.total - CONTEXT_SAFETY_MARGIN_TOKENS;
      if (availableForOutput < MIN_OUTPUT_TOKENS) {
        logger.warn(
          `[LatticeCombo] Skipping target ${target} for combo ${combo.id}: prompt (~${estimate.total} tokens) + safety margin exceeds context window (${contextWindow} tokens)`
        );
        skippedCount++;
        continue;
      }

      if (!this.hasQuotaAvailable(resolved.plugin.id)) {
        logger.warn(
          `[LatticeCombo] Skipping target ${target} for combo ${combo.id}: all accounts for provider ${resolved.plugin.id} have exhausted quota`
        );
        quotaSkippedCount++;
        continue;
      }

      let clampedMaxTokens: number | undefined;
      if (req.maxTokens !== undefined) {
        clampedMaxTokens = Math.min(req.maxTokens, availableForOutput);
      }

      try {
        logger.info(`[LatticeCombo] Routing combo ${combo.id} -> target ${target} (${resolved.plugin.id}, ctx=${contextWindow}, est_prompt=${estimate.total}${clampedMaxTokens ? `, max_tokens=${clampedMaxTokens}` : ''})`);

        const targetReq: CanonicalRequest = {
          ...req,
          model: target,
          maxTokens: clampedMaxTokens,
        };

        const res = await resolved.plugin.execute(targetReq, signal);
        if (sessionKey) this.affinityStore.pinTarget(sessionKey, target);
        return {
          ...res,
          model: combo.id,
        };
      } catch (err: any) {
        lastError = err;
        if (this.isContextOverflowError(err)) {
          overflowCount++;
          logger.warn(
            `[LatticeCombo] Target ${target} context overflow for combo ${combo.id}: ${err.message || err}. Trying next target...`
          );
        } else {
          logger.warn(
            `[LatticeCombo] Target ${target} failed for combo ${combo.id}: ${err.message || err}. Falling back to next target...`
          );
        }
      }
    }

    if (quotaSkippedCount > 0 && quotaSkippedCount + skippedCount + overflowCount >= combo.targets.length) {
      const resetInfo = globalAccountPool.getNextResetTime();
      const retryAfter = resetInfo?.retryAfterSeconds || 60;
      const resetTimeStr = resetInfo
        ? ` Quota resets at ${new Date(resetInfo.resetAt).toISOString()} (in ${retryAfter}s).`
        : '';
      throw new GatewayError(
        429,
        'rate_limit',
        `All targets in combo ${combo.id} have exhausted their account quotas.${resetTimeStr} Wait for quota reset or add more accounts.`,
        { providerId: this.id, retryAfter }
      );
    }

    if (skippedCount + overflowCount >= combo.targets.length) {
      throw new GatewayError(
        400,
        'context_length_exceeded',
        `All targets in combo ${combo.id} exceeded context window. Estimated prompt: ~${estimate.total} tokens. Largest available context: ${maxContextSeen.value} tokens. Shorten the context or use a larger-context model directly.`,
        { providerId: this.id }
      );
    }

    throw (
      lastError ||
      new GatewayError(503, 'service_unavailable', `All targets in combo ${combo.id} failed`)
    );
  }

  async executeStream(
    req: CanonicalRequest,
    signal?: AbortSignal
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const combo = globalComboManager.getCombo(req.model);
    if (!combo) {
      const available = globalComboManager.listCombos().map((c) => c.id).join(', ');
      throw new GatewayError(
        404,
        'model_not_found',
        `Virtual combo not found: ${req.model}. Available combos: ${available || 'none'}`
      );
    }

    const estimate = countPromptTokens(req);
    let lastError: any = null;
    let overflowCount = 0;
    let skippedCount = 0;
    let quotaSkippedCount = 0;
    let switchCount = 0;
    const maxContextSeen = { value: 0 };
    const sessionKey = req.affinity?.sessionKey;
    const pinnedTarget = sessionKey ? this.affinityStore.getTarget(sessionKey) : undefined;
    const targets = pinnedTarget && combo.targets.includes(pinnedTarget)
      ? [pinnedTarget, ...combo.targets.filter((target) => target !== pinnedTarget)]
      : [...combo.targets];

    for (const target of targets) {
      if (switchCount >= MAX_STREAM_TARGET_SWITCHES) {
        logger.warn(`[LatticeCombo] Switch budget exhausted for combo ${combo.id}`);
        break;
      }
      let resolved: { plugin: ProviderPlugin; resolvedModel: string };
      try {
        resolved = this.resolveProviderForModel(target);
      } catch (err) {
        lastError = err;
        skippedCount++;
        continue;
      }

      const contextWindow = await this.getModelContextWindow(target);
      if (contextWindow > maxContextSeen.value) maxContextSeen.value = contextWindow;

      const availableForOutput = contextWindow - estimate.total - CONTEXT_SAFETY_MARGIN_TOKENS;
      if (availableForOutput < MIN_OUTPUT_TOKENS) {
        logger.warn(
          `[LatticeCombo] Skipping stream target ${target} for combo ${combo.id}: prompt (~${estimate.total} tokens) + safety margin exceeds context window (${contextWindow} tokens)`
        );
        skippedCount++;
        continue;
      }

      if (!this.hasQuotaAvailable(resolved.plugin.id)) {
        logger.warn(
          `[LatticeCombo] Skipping stream target ${target} for combo ${combo.id}: all accounts for provider ${resolved.plugin.id} have exhausted quota`
        );
        quotaSkippedCount++;
        continue;
      }

      let clampedMaxTokens: number | undefined;
      if (req.maxTokens !== undefined) {
        clampedMaxTokens = Math.min(req.maxTokens, availableForOutput);
      }

      try {
        logger.info(`[LatticeCombo] Streaming combo ${combo.id} -> target ${target} (${resolved.plugin.id}, ctx=${contextWindow}, est_prompt=${estimate.total}${clampedMaxTokens ? `, max_tokens=${clampedMaxTokens}` : ''})`);

        const targetReq: CanonicalRequest = {
          ...req,
          model: target,
          maxTokens: clampedMaxTokens,
        };

        const stream = await resolved.plugin.executeStream(targetReq, signal);
        const iterator = stream[Symbol.asyncIterator]();
        const buffered: CanonicalStreamEvent[] = [];
        let firstContent: IteratorResult<CanonicalStreamEvent> | undefined;
        let emptyStream = false;
        try {
          // Metadata events (stream_start) are not content. Keep reading until
          // the first content-bearing event so a "connected then died" upstream
          // is still safe to retry without duplicating anything for the client.
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              emptyStream = true;
              break;
            }
            if (isContentEvent(next.value)) {
              firstContent = next;
              break;
            }
            buffered.push(next.value);
          }
        } catch (err: any) {
          lastError = err;
          switchCount++;
          logger.warn(`[LatticeCombo] Stream target ${target} failed before content: ${err.message || err}. Retrying next target...`);
          continue;
        }

        if (emptyStream) {
          lastError = new Error(`Upstream ${target} returned an empty stream`);
          switchCount++;
          logger.warn(`[LatticeCombo] Stream target ${target} returned no events. Retrying next target...`);
          continue;
        }

        if (sessionKey) this.affinityStore.pinTarget(sessionKey, target);
        const comboId = combo.id;
        return (async function* () {
          try {
            for (const event of buffered) {
              if (event.type === 'stream_start') {
                yield { ...event, model: comboId };
              } else {
                yield event;
              }
            }
            let current = firstContent!;
            while (!current.done) {
              const event = current.value;
              if (event.type === 'stream_start') {
                yield { ...event, model: comboId };
              } else {
                yield event;
              }
              current = await iterator.next();
            }
          } catch (streamErr: any) {
            // Content has already been emitted. Switching models now would
            // duplicate tool calls and break the client's session.
            logger.error(`[LatticeCombo] Mid-stream error on target ${target}: ${streamErr.message || streamErr}`);
            yield {
              type: 'stream_error',
              error: {
                message: streamErr.message || 'Upstream connection closed mid-stream',
                type: 'upstream_error',
                code: 'stream_failed',
                status: streamErr.status ?? streamErr.statusCode ?? 500,
              },
            };
          }
        })();
      } catch (err: any) {
        lastError = err;
        switchCount++;
        if (this.isContextOverflowError(err)) {
          overflowCount++;
          logger.warn(
            `[LatticeCombo] Stream target ${target} context overflow for combo ${combo.id}: ${err.message || err}. Trying next target...`
          );
        } else {
          logger.warn(
            `[LatticeCombo] Stream target ${target} failed for combo ${combo.id}: ${err.message || err}. Falling back to next target...`
          );
        }
      }
    }

    if (quotaSkippedCount > 0 && quotaSkippedCount + skippedCount + overflowCount >= combo.targets.length) {
      const resetInfo = globalAccountPool.getNextResetTime();
      const retryAfter = resetInfo?.retryAfterSeconds || 60;
      const resetTimeStr = resetInfo
        ? ` Quota resets at ${new Date(resetInfo.resetAt).toISOString()} (in ${retryAfter}s).`
        : '';
      throw new GatewayError(
        429,
        'rate_limit',
        `All targets in combo ${combo.id} have exhausted their account quotas.${resetTimeStr} Wait for quota reset or add more accounts.`,
        { providerId: this.id, retryAfter }
      );
    }

    if (skippedCount + overflowCount >= combo.targets.length) {
      throw new GatewayError(
        400,
        'context_length_exceeded',
        `All targets in combo ${combo.id} exceeded context window. Estimated prompt: ~${estimate.total} tokens. Largest available context: ${maxContextSeen.value} tokens. Shorten the context or use a larger-context model directly.`,
        { providerId: this.id }
      );
    }

    throw (
      lastError ||
      new GatewayError(503, 'service_unavailable', `All targets in combo ${combo.id} failed`)
    );
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const combos = globalComboManager.listCombos();
    return {
      healthy: combos.length > 0,
      checkedAt: Date.now(),
      message: `${combos.length} virtual combos configured and ready`,
    };
  }
}
