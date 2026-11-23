import type { CanonicalRequest } from '../../core/types/canonical';
import type { ProviderPlugin } from '../../core/types/plugin';
import { GatewayError } from '../../core/types/errors';

export function requestHasSamplingFields(req: CanonicalRequest): boolean {
  return (
    req.frequencyPenalty !== undefined ||
    req.presencePenalty !== undefined ||
    req.seed !== undefined ||
    req.n !== undefined ||
    req.logitBias !== undefined
  );
}

/**
 * Fail explicitly when a client constraint cannot be honoured by the chosen
 * provider. Silently dropping it would make the client believe it was applied.
 */
export function assertProviderCapabilities(req: CanonicalRequest, plugin: ProviderPlugin): void {
  const caps = plugin.capabilities ?? {};
  if (req.responseFormat && !caps.responseFormat) {
    throw new GatewayError(
      400,
      'unsupported_parameter',
      `Provider ${plugin.id} does not support response_format; remove it or use a provider that declares structured-output support`
    );
  }
  if (requestHasSamplingFields(req) && !caps.samplingFields) {
    throw new GatewayError(
      400,
      'unsupported_parameter',
      `Provider ${plugin.id} does not support the requested sampling fields (frequency_penalty, presence_penalty, seed, n, logit_bias)`
    );
  }
}
