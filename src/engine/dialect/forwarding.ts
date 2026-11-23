import type { CanonicalRequest } from '../../core/types/canonical';

/** OpenAI-compatible upstream fields that the gateway now carries and forwards. */
export function forwardSamplingFields(req: CanonicalRequest): Record<string, unknown> {
  return {
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.frequencyPenalty !== undefined ? { frequency_penalty: req.frequencyPenalty } : {}),
    ...(req.presencePenalty !== undefined ? { presence_penalty: req.presencePenalty } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.n !== undefined ? { n: req.n } : {}),
    ...(req.logitBias !== undefined ? { logit_bias: req.logitBias } : {}),
    ...(req.user !== undefined ? { user: req.user } : {}),
    ...(req.responseFormat
      ? {
          response_format: {
            type: req.responseFormat.type,
            ...(req.responseFormat.jsonSchema
              ? { json_schema: req.responseFormat.jsonSchema }
              : {}),
          },
        }
      : {}),
  };
}
