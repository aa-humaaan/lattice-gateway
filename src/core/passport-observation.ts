import type { CanonicalResponse, CanonicalStreamEvent } from './types/canonical';
import type { ModelPassportStore } from './model-passports';

function claim(
  store: ModelPassportStore,
  modelId: string,
  name: 'supportsTools' | 'supportsThinking' | 'supportsStreaming' | 'contextOverflowAt',
  value: boolean | number,
  evidence: string,
  observedAt: number,
  source: 'measured' = 'measured'
): void {
  try {
    store.recordCapabilityClaim(modelId, name, { value, source, observedAt, evidence });
  } catch {
    // Learning is best-effort; a missing passport must never break a request.
  }
}

export function observeCanonicalResponse(
  store: ModelPassportStore,
  modelId: string,
  response: CanonicalResponse,
  evidence = 'observed tool_use in canonical response',
  observedAt = Date.now()
): void {
  const hasThinking = response.content.some((part) => part.type === 'thinking');
  const hasTools = response.content.some((part) => part.type === 'tool_use');
  if (hasTools) claim(store, modelId, 'supportsTools', true, evidence, observedAt);
  if (hasThinking) {
    claim(store, modelId, 'supportsThinking', true, 'observed thinking block in canonical response', observedAt);
  }
}

export function observeStreamEvents(
  store: ModelPassportStore,
  modelId: string,
  events: CanonicalStreamEvent[],
  observedAt = Date.now()
): void {
  if (events.length === 0) return;
  if (events.some((event) => event.type === 'stream_end' || event.type === 'text_delta' ||
      event.type === 'thinking_delta' || event.type === 'tool_call_delta')) {
    claim(store, modelId, 'supportsStreaming', true, 'observed stream events from upstream', observedAt);
  }
  if (events.some((event) => event.type === 'tool_call_start' || event.type === 'tool_call_delta')) {
    claim(store, modelId, 'supportsTools', true, 'observed tool_call delta in stream', observedAt);
  }
  if (events.some((event) => event.type === 'thinking_delta')) {
    claim(store, modelId, 'supportsThinking', true, 'observed thinking delta in stream', observedAt);
  }
}

export function observeStreamEvent(
  store: ModelPassportStore,
  modelId: string,
  event: CanonicalStreamEvent,
  observedAt = Date.now()
): void {
  if (event.type === 'text_delta' || event.type === 'stream_end') {
    claim(store, modelId, 'supportsStreaming', true, 'observed stream events from upstream', observedAt);
  } else if (event.type === 'thinking_delta') {
    claim(store, modelId, 'supportsThinking', true, 'observed thinking delta in stream', observedAt);
    claim(store, modelId, 'supportsStreaming', true, 'observed stream events from upstream', observedAt);
  } else if (event.type === 'tool_call_start' || event.type === 'tool_call_delta') {
    claim(store, modelId, 'supportsTools', true, 'observed tool_call delta in stream', observedAt);
    claim(store, modelId, 'supportsStreaming', true, 'observed stream events from upstream', observedAt);
  }
}

export function observeContextOverflow(
  store: ModelPassportStore,
  modelId: string,
  estimatedTokens: number,
  observedAt = Date.now()
): void {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return;
  claim(
    store,
    modelId,
    'contextOverflowAt',
    estimatedTokens,
    'upstream rejected a prompt of this estimated size as too long',
    observedAt
  );
}



