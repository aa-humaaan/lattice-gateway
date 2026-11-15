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
import { globalPluginRegistry } from './registry';
import { logger } from '../utils/logger';

export class LatticeComboPlugin implements ProviderPlugin {
  readonly id = 'lattice';
  readonly displayName = 'Lattice Virtual Combos & Failover Engine';
  readonly description = 'Aggregates multi-provider virtual combo pipelines with automatic 429 and error failover';
  readonly defaultBaseUrl = 'http://127.0.0.1:4000';

  async listModels(): Promise<ModelDescriptor[]> {
    return globalComboManager.listAsModels();
  }

  private resolveProviderForModel(modelId: string): { plugin: ProviderPlugin; resolvedModel: string } {
    // 1. Direct provider prefix: "kilo/modelName"
    const parts = modelId.split('/');
    if (parts.length > 1) {
      const providerId = parts[0];
      if (globalPluginRegistry.has(providerId)) {
        return { plugin: globalPluginRegistry.get(providerId)!, resolvedModel: modelId };
      }
    }

    // 2. Direct plugin ID match
    if (globalPluginRegistry.has(modelId)) {
      return { plugin: globalPluginRegistry.get(modelId)!, resolvedModel: modelId };
    }

    // 3. Fallback search across all registered plugins
    for (const plugin of globalPluginRegistry.getAll()) {
      if (plugin.id !== 'lattice') {
        return { plugin, resolvedModel: modelId };
      }
    }

    throw new GatewayError(
      404,
      'model_not_found',
      `No active provider found for combo target model: ${modelId}`
    );
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

    let lastError: any = null;
    for (const target of combo.targets) {
      try {
        const { plugin } = this.resolveProviderForModel(target);
        logger.info(`[LatticeCombo] Routing combo ${combo.id} -> target ${target} (${plugin.id})`);
        
        const targetReq: CanonicalRequest = {
          ...req,
          model: target,
        };

        const res = await plugin.execute(targetReq, signal);
        return {
          ...res,
          model: combo.id, // Preserve virtual combo model identity
        };
      } catch (err: any) {
        lastError = err;
        logger.warn(
          `[LatticeCombo] Target ${target} failed for combo ${combo.id}: ${err.message || err}. Falling back to next target...`
        );
      }
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

    let lastError: any = null;
    for (const target of combo.targets) {
      try {
        const { plugin } = this.resolveProviderForModel(target);
        logger.info(`[LatticeCombo] Streaming combo ${combo.id} -> target ${target} (${plugin.id})`);

        const targetReq: CanonicalRequest = {
          ...req,
          model: target,
        };

        const stream = await plugin.executeStream(targetReq, signal);
        // Wrap stream to replace target model with combo.id in stream_start event
        const comboId = combo.id;
        return (async function* () {
          for await (const event of stream) {
            if (event.type === 'stream_start') {
              yield { ...event, model: comboId };
            } else {
              yield event;
            }
          }
        })();
      } catch (err: any) {
        lastError = err;
        logger.warn(
          `[LatticeCombo] Stream target ${target} failed for combo ${combo.id}: ${err.message || err}. Falling back to next target...`
        );
      }
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
